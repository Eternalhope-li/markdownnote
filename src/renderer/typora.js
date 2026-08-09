// typora.js —— MarkdownNote 所见即所得编辑器内核（原创实现）
//
// 架构：编辑面板 DOM 即唯一真相（Single Source of Truth）
//   · 打开文件：markdown-it 一次性渲染到面板（低频）
//   · 击键：仅对光标所在块做局部转换（行级标记 / 行内闭合），绝不整篇重渲染
//   · 保存：防抖 1s 后整篇序列化（turndown），写盘由 files.js 再防抖
// 性能：击键路径只处理当前块（O(当前行长度)），与文档总大小无关；
//       全量操作只发生在“打开 / 保存”两个低频点，打字全程不卡。
//
// 空段落往返：编辑时的空段落以不可见占位符标记，序列化后写成 HTML 注释
//   `<!--  -->`，重开文件时 markdown-it 渲染出注释节点，load 再还原为空段落。
//   这样两个相邻列表 / 引用之间永远有独立段落隔开，往返不合并。

const TurndownService = require('turndown');
const doc = require('./doc');
const preview = require('./preview');
const { getFrontmatterRaw } = require('./frontmatter');
const pasteImage = require('./paste-image');
const hljs = require('highlight.js');
// 补齐常用语言里 hljs 默认未注册的几种
try { hljs.registerLanguage('dart', require('highlight.js/lib/languages/dart')); } catch (e) {}
try { hljs.registerLanguage('toml', require('highlight.js/lib/languages/toml')); } catch (e) {}
try { hljs.registerLanguage('properties', require('highlight.js/lib/languages/properties')); } catch (e) {}

const ZWSP = '\u200b';          // 空块占位（保证光标可定位、编辑时不可见）
const SENTINEL = '\u0001';      // 序列化时空段落的哨兵（用户不可能输入的控制符）

let onChangeCb = null;
let onSaveCb = null;
let onGetNotePathCb = null;
let composing = false;
let dirty = false;
let serializeTimer = null;

const $ = (id) => document.getElementById(id);
function getPane() { return $('typoraPane'); }

// ---------- HTML -> Markdown（仅在保存时整篇执行） ----------
const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  fence: '```',
  hr: '---'
});
// 输入语法原样保留（否则 #、*、- 会被转义，永远无法再解析成格式）
td.escape = (s) => s;

// 代码块：fenced 序列化；忽略行号 gutter，只取 <code> 文本，保留 \n 行结构
td.addRule('fencedCodeBlock', {
  filter: (node) => node.nodeName === 'PRE',
  replacement: (content, node) => {
    const code = node.querySelector('code');
    const raw = (code ? code.textContent : node.textContent || '').replace(/\u200b/g, '').replace(/\n+$/, '');
    const lang = code && /language-([\w+#.\-]+)/.exec(code.className);
    const info = lang ? lang[1] : '';
    const longest = (raw.match(/\x60{3,}/g) || []).reduce((m, x) => Math.max(m, x.length), 0);
    const fence = String.fromCharCode(96).repeat(Math.max(3, longest + 1));
    return '\n\n' + fence + info + '\n' + raw + '\n' + fence + '\n\n';
  }
});

// 删除线 <s>/<del> -> ~~text~~
td.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content) => '~~' + content + '~~'
});

// 任务列表 checkbox -> [x] / [ ]
td.addRule('taskCheckbox', {
  filter: (node) => node.nodeName === 'INPUT' && node.type === 'checkbox',
  replacement: (content, node) => (node.checked ? '[x] ' : '[ ] ')
});

// 列表项：干净的 "- " / "1. " 前缀，嵌套列表 4 空格缩进
td.addRule('listItem', {
  filter: 'li',
  replacement: function (content, node) {
    let text = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, '\n    ');
    const parent = node.parentNode;
    let prefix = '- ';
    if (parent && parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = (start ? Number(start) + index : index + 1) + '. ';
    }
    return prefix + text + (node.nextSibling && !/\n$/.test(text) ? '\n' : '');
  }
});

// 表格：重建 GFM 表格（turndown 原生不支持）
td.addRule('table', {
  filter: 'table',
  replacement: function (content, node) {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cellsOf = (tr) => Array.from(tr.children).map((c) =>
      (c.textContent || '').trim().replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' '));
    const data = rows.map(cellsOf);
    const sep = data[0].map(() => '---');
    const lines = [data[0], sep, ...data.slice(1)].map((r) => '| ' + r.join(' | ') + ' |');
    return lines.join('\n') + '\n\n';
  }
});

// ---------- 通用工具 ----------
function normText(s) { return (s || '').replace(/\u200b/g, '').replace(/\u00a0/g, ' '); }

function closestTag(node, tag) {
  let n = node;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === tag) return n;
    n = n.parentNode;
  }
  return null;
}

function caretNode() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return sel.getRangeAt(0).startContainer;
}

function caretBlock() {
  const pane = getPane();
  const n = caretNode();
  if (!n) return null;
  let b = n;
  while (b && b !== pane && b.parentNode !== pane) b = b.parentNode;
  return b && b !== pane ? b : null;
}

function caretOffsetInBlock(block) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function topLevelBlocks(pane) {
  const out = [];
  for (const c of pane.childNodes) {
    if (c.nodeType === Node.ELEMENT_NODE && c.tagName !== 'BR') out.push(c);
  }
  return out;
}

function blockIsEmpty(el) {
  if (!el) return false;
  return normText(el.textContent).trim() === '' && !el.querySelector('input, img, br');
}

function placeCaretAtEnd(el) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  let lastText = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) lastText = walker.currentNode;
  if (lastText) {
    range.setStart(lastText, lastText.nodeValue.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtOffset(el, offset) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = null;
  let rest = Math.max(0, offset);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (rest <= t.nodeValue.length) { node = t; break; }
    rest -= t.nodeValue.length;
  }
  if (node) {
    range.setStart(node, rest);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------- 自动配对括号（Typora 式）：() [] {} "" '' `` ----------
const PAIR_OPEN = { '(': ')', '[': ']', '{': '}' };   // 开括号 -> 闭括号
const PAIR_SAME = { '"': '"', "'": "'", '`': '`' };   // 同字符配对
const PAIR_CLOSE = { ')': '(', ']': '[', '}': '{' };  // 闭括号 -> 开括号
const PAIR_MAP = Object.assign({}, PAIR_OPEN, PAIR_SAME); // 退格删除配对用

// 光标在整个面板文本中的扁平偏移（跨行内元素）
function caretFlatIndex() {
  const pane = getPane();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const r = sel.getRangeAt(0);
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === r.startContainer) return acc + r.startOffset;
    acc += n.nodeValue.length;
    n = walker.nextNode();
  }
  return acc;
}

function charsAtCaret() {
  const pane = getPane();
  const idx = caretFlatIndex();
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n = walker.nextNode();
  let prev = null;
  let next = null;
  while (n) {
    const len = n.nodeValue.length;
    if (prev === null && idx > acc && idx <= acc + len) prev = n.nodeValue[idx - acc - 1];
    if (next === null && idx >= acc && idx < acc + len) next = n.nodeValue[idx - acc];
    acc += len;
    n = walker.nextNode();
  }
  return { prev, next, idx };
}

function placeCaretAtFlat(idx) {
  const pane = getPane();
  const sel = window.getSelection();
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n = walker.nextNode();
  while (n) {
    const len = n.nodeValue.length;
    if (idx <= acc + len) {
      const range = document.createRange();
      range.setStart(n, Math.max(0, Math.min(len, idx - acc)));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      pane.focus();
      return;
    }
    acc += len;
    n = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(pane);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  pane.focus();
}

// 引号/反引号在“行首或标点之后”才视为左引号，正文里（can't、`x）正常输入单字符
function isOpeningPosition(prev) {
  if (prev === null || prev === undefined) return true;
  if (/\s/.test(prev)) return true;
  return /[([{<,:;.!?\u2014\u2013\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01]/.test(prev);
}

// 开括号：插入配对；闭括号：跳过已配对的闭括号（并触发行内格式转换）
function handleAutoPair(e) {
  if (composing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const key = e.key;
  if (!(key in PAIR_OPEN) && !(key in PAIR_SAME) && !(key in PAIR_CLOSE)) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) return false;
  if (caretInPre()) return false;
  const { prev, next, idx } = charsAtCaret();
  // 闭括号：下一字符正好是配对的闭括号 → 跳过（链接/图片/行内格式即时闭合）
  if (key in PAIR_CLOSE) {
    if (next === key) {
      e.preventDefault();
      placeCaretAtFlat(idx + 1);
      if (tryInlineFormat()) scheduleSerialize();
      return true;
    }
    return false; // 没有可跳过的配对：正常输入
  }
  // 同字符配对（" ' `）：光标后正好是同字符 → 跳过；行首/标点后 → 配对；正文中 → 单字符
  if (key in PAIR_SAME) {
    if (next === key) {
      e.preventDefault();
      placeCaretAtFlat(idx + 1);
      if (tryInlineFormat()) scheduleSerialize();
      return true;
    }
    if (!isOpeningPosition(prev)) return false;
  }
  const close = (key in PAIR_OPEN) ? PAIR_OPEN[key] : key;
  e.preventDefault();
  pushUndo();
  document.execCommand('insertText', false, key + close);
  placeCaretAtFlat(idx + 1);
  return true;
}

// 删除相邻的自动配对括号（退格一次删掉 "()" / "[]" / "{}" / """" / "''" / "``"）
function deleteCharRange(startIdx, endIdx) {
  const pane = getPane();
  const sel = window.getSelection();
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n = walker.nextNode();
  let start = null;
  let end = null;
  while (n) {
    const len = n.nodeValue.length;
    if (!start && startIdx <= acc + len) start = { n, off: Math.max(0, Math.min(len, startIdx - acc)) };
    if (!end && endIdx <= acc + len) end = { n, off: Math.max(0, Math.min(len, endIdx - acc)) };
    acc += len;
    n = walker.nextNode();
  }
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.n, start.off);
  range.setEnd(end.n, end.off);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('delete');
  return true;
}

function stripWhitespaceTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toRemove = [];
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.nodeValue && t.nodeValue.trim() === '') toRemove.push(t);
  }
  for (const t of toRemove) {
    if (t.parentNode) t.parentNode.removeChild(t);
  }
}

// ---------- 序列化：DOM -> Markdown（保存时执行） ----------
function markEmptyBlocks(pane) {
  for (const el of topLevelBlocks(pane)) {
    const tag = el.tagName && el.tagName.toLowerCase();
    if ((tag === 'p' || tag === 'div') && blockIsEmpty(el)) el.textContent = SENTINEL;
  }
}

function serialize() {
  if (!dirty) return doc.getDoc();
  const pane = getPane();
  // 在克隆副本上标记空段落，绝不污染正在编辑的真实 DOM
  const clone = pane.cloneNode(true);
  markEmptyBlocks(clone);
  const fm = getFrontmatterRaw(doc.getDoc());
  let body = td.turndown(clone.innerHTML).trim();
  // 空段落哨兵写成 HTML 注释 <!--  -->，并清掉其它控制符，保证磁盘文件干净
  body = body
    .replace(/(^|\n)[^\S\n]*\u0001[^\S\n]*(?=\n|$)/g, '$1<!--  -->')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const md = (fm ? fm.trimEnd() + '\n\n' : '') + body + '\n';
  dirty = false;
  if (md !== doc.getDoc()) {
    doc.setDoc(md);
    if (onChangeCb) onChangeCb(md);
  }
  return md;
}

function scheduleSerialize(delay) {
  dirty = true;
  clearTimeout(serializeTimer);
  serializeTimer = setTimeout(() => serialize(), delay == null ? 1000 : delay);
}

function flush() { serialize(); }

// 写盘前清理：空段落哨兵 -> `<!--  -->`，删零宽占位，规整空行
function cleanMarkdown(md) {
  return md
    .replace(/^\ufeff/, '')
    .replace(/(^|\n)[^\S\n]*\u0001[^\S\n]*(?=\n|$)/g, '$1<!--  -->')
    .replace(/\u0001/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/(^|\n)[^\S\n]*\u200b[^\S\n]*(?=\n|$)/g, '$1')
    .replace(/\u200b/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
// ---------- 行级空标记：输入 "# " / "- " / "1. " / "> " / "- [ ] " 立即排版 ----------
const EMPTY_MARKER_RE = [
  {
    re: /^(#{1,6}) $/,
    make: (m) => { const h = document.createElement('h' + m[1].length); h.textContent = ZWSP; return h; }
  },
  {
    re: /^([-*+]) $/,
    make: () => {
      const ul = document.createElement('ul');
      const li = document.createElement('li');
      li.textContent = ZWSP;
      ul.appendChild(li);
      return ul;
    }
  },
  {
    re: /^(\d+)\. $/,
    make: () => {
      const ol = document.createElement('ol');
      const li = document.createElement('li');
      li.textContent = ZWSP;
      ol.appendChild(li);
      return ol;
    }
  },
  {
    re: /^([-*+]) \[([ xX])\] $/,
    make: (m) => {
      const ul = document.createElement('ul');
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = /[xX]/.test(m[2]);
      li.appendChild(cb);
      li.appendChild(document.createTextNode(ZWSP));
      ul.appendChild(li);
      return ul;
    }
  },
  {
    re: /^> $/,
    make: () => {
      const bq = document.createElement('blockquote');
      const p = document.createElement('p');
      p.textContent = ZWSP;
      bq.appendChild(p);
      return bq;
    }
  }
];

// ---------- 行首标记“悬停”状态（Typora 式）：输入 "# " 后井号虚化、整行按目标样式预览，
//            光标移走 / 回车 / 点击时才真正转成标题、列表、引用等 ----------
function matchPendingMarker(textBefore) {
  let m = /^([-+*])\s+\[([ xX])\]\s/.exec(textBefore);
  if (m) return { type: 'task', marker: textBefore.slice(0, m[0].length) };
  m = /^(#{1,6})\s/.exec(textBefore);
  if (m) return { type: 'h' + m[1].length, marker: textBefore.slice(0, m[0].length) };
  m = /^([-+*])\s/.exec(textBefore);
  if (m) return { type: 'ul', marker: textBefore.slice(0, m[0].length) };
  m = /^(\d+)\.\s/.exec(textBefore);
  if (m) return { type: 'ol', marker: textBefore.slice(0, m[0].length) };
  m = /^>\s/.exec(textBefore);
  if (m) return { type: 'quote', marker: textBefore.slice(0, m[0].length) };
  return null;
}

// 把块开头的 markerLen 个字符包进 <span class="md-marker">（跨文本节点，不移动光标位置）
function wrapMarkerPrefix(el, markerLen) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = markerLen;
  const span = document.createElement('span');
  span.className = 'md-marker';
  let node = walker.nextNode();
  let skip = true;
  while (node && remaining > 0) {
    let v = node.nodeValue;
    // ?????? \u200b ????????????????
    if (skip && v.charAt(0) === ZWSP) {
      if (v.length === 1) { node = walker.nextNode(); continue; }
      v = v.slice(1);
      node.nodeValue = v;
    }
    skip = false;
    if (v.length <= remaining) {
      span.appendChild(node);
      remaining -= v.length;
    } else {
      span.appendChild(document.createTextNode(v.slice(0, remaining)));
      node.nodeValue = v.slice(remaining);
      remaining = 0;
    }
    node = walker.nextNode();
  }
  el.insertBefore(span, el.firstChild);
}

function unwrapMarker(el) {
  const span = el.querySelector('.md-marker');
  if (span) span.replaceWith(document.createTextNode(span.textContent || ''));
}

function clearPending(el) {
  unwrapMarker(el);
  el.removeAttribute('data-md-pending');
  scheduleSerialize();
}

// 悬停态输入：进入（#  ->  # 标题）/ 升级（-  ->  - [ ]）/ 失效还原；无实际变化时返回 false
function handlePendingInput(target, block, textBefore) {
  const m = matchPendingMarker(textBefore);
  if (!m) {
    if (target.nodeType === Node.ELEMENT_NODE && target.hasAttribute('data-md-pending')) {
      clearPending(target);
      return true;
    }
    return false;
  }
  // 记录光标在本块内的原始偏移。必须在任何 DOM 变更之前计算：
  // 一旦把文本节点 replaceWith 成段落，选区锚点就会被 detach，计出的偏移会错误（粘贴整行标记时光标落在标记边界。
  const preCaret = caretOffsetInBlock(target);
  if (target.nodeType === Node.TEXT_NODE) {
    // 空文档首行：先包成段落
    const p = document.createElement('p');
    p.textContent = target.nodeValue || '';
    target.replaceWith(p);
    block = p;
    target = p;
  }
  const cur = target.getAttribute('data-md-pending');
  const span = target.querySelector('.md-marker');
  if (cur === m.type && span && normText(span.textContent) === m.marker) return false; // 无变化：继续走行内转换
  if (!cur) pushUndo();
  unwrapMarker(target);
  wrapMarkerPrefix(target, m.marker.length);
  target.setAttribute('data-md-pending', m.type);
  const postLen = (target.textContent || '').length;
  placeCaretAtOffset(target, Math.max(m.marker.length, Math.min(preCaret, postLen)));
  scheduleSerialize();
  return true;
}

function tryEmptyMarker() {
  const pane = getPane();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || composing) return false;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  let block = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (block && block !== pane && block.parentNode !== pane) block = block.parentNode;
  if (!block || block === pane) {
    // 空文档首次输入：文本节点直接挂在面板下
    if (node.nodeType !== Node.TEXT_NODE) return false;
    block = node;
  }
  if (block.nodeType === Node.ELEMENT_NODE) {
    const tag = block.tagName.toLowerCase();
    if (tag === 'pre' || tag === 'td' || tag === 'th') return false;
  }
  // 定位“这一行”对应的元素：列表定位到 li，引用定位到内部块，其余就是块本身
  let target = block;
  if (block.nodeType === Node.ELEMENT_NODE) {
    const tag = block.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      const li = closestTag(node, 'li');
      if (!li) return false;
      target = li;
    } else if (tag === 'blockquote') {
      const inner = blockInside(block);
      if (!inner) return false;
      target = inner;
    }
  }
  if (target.nodeType === Node.ELEMENT_NODE && target.querySelector('br, input, img')) return false;

  const text = normText(target.textContent || target.nodeValue || '');
  const pre = range.cloneRange();
  pre.selectNodeContents(target);
  pre.setEnd(range.startContainer, range.startOffset);
  const caret = normText(pre.toString()).length;
  const textBefore = text.slice(0, caret);

  // 列表项内输入 "[ ] " / "[x] "：变成待办项（逐字输入 "- [ ] " 的第二步）
  if (target.nodeType === Node.ELEMENT_NODE && target.tagName === 'LI') {
    const tm = /^\[([ xX])\]\s?$/.exec(textBefore);
    if (tm) {
      pushUndo();
      const nl = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = /[xX]/.test(tm[1]);
      nl.appendChild(cb);
      nl.appendChild(document.createTextNode(text.slice(textBefore.length) || ZWSP));
      target.replaceWith(nl);
      placeCaretAtEnd(nl);
      scheduleSerialize();
      return true;
    }
  }

  // 段落 / 裸文本：进入“悬停”状态（Typora：井号虚化、样式预览，光标移走 / 回车才提交）
  const blockTag = block.nodeType === Node.ELEMENT_NODE ? block.tagName.toLowerCase() : '';
  if (block.nodeType === Node.TEXT_NODE || blockTag === 'p' || blockTag === 'div') {
    return handlePendingInput(target, block, textBefore);
  }

  // 列表项 / 标题 / 引用内部：行首标记立即改变块类型
  for (const rule of EMPTY_MARKER_RE) {
    const m = rule.re.exec(textBefore);
    if (!m) continue;
    pushUndo();
    const el = rule.make(m);
    fillBlockWith(el, text.slice(caret));
    const isList = el.tagName === 'UL' || el.tagName === 'OL';
    const isTargetLi = target.nodeType === Node.ELEMENT_NODE && target.tagName === 'LI';

    if (isTargetLi && isList) {
      // 列表项内 "- " / "1. "：生成嵌套列表（Typora 式）
      target.textContent = ZWSP;
      target.appendChild(el);
      placeCaretAtEnd(el);
      scheduleSerialize();
      return true;
    }
    if (isTargetLi) {
      // 列表项内 "# " / "> "：该项转成标题/引用，其余列表项保留
      const list = target.parentNode;
      const next = list ? list.nextSibling : null;
      target.remove();
      if (list && !list.querySelector('li')) list.remove();
      if (list && list.isConnected) {
        list.after(el);
      } else if (next && next.parentNode) {
        pane.insertBefore(el, next);
      } else {
        pane.appendChild(el);
      }
      placeCaretAtEnd(el);
      scheduleSerialize();
      return true;
    }
    if (target.nodeType === Node.ELEMENT_NODE && target.parentNode &&
        target.parentNode.tagName === 'BLOCKQUOTE') {
      // 引用内 "# " 等：整块移出引用
      const bq = target.parentNode;
      const next = bq.nextSibling;
      target.remove();
      if (!bq.children.length) bq.remove();
      pane.insertBefore(el, next);
      placeCaretAtEnd(el);
      scheduleSerialize();
      return true;
    }
    if (isList && block.nodeType === Node.ELEMENT_NODE) {
      // 紧邻已有列表：先保留一个空段落再插新列表，往返时两列表不会合并
      const prevList = block.previousElementSibling &&
        (block.previousElementSibling.tagName === 'UL' || block.previousElementSibling.tagName === 'OL');
      const nextList = block.nextElementSibling &&
        (block.nextElementSibling.tagName === 'UL' || block.nextElementSibling.tagName === 'OL');
      if (prevList || nextList) {
        const empty = document.createElement('p');
        empty.textContent = ZWSP;
        block.replaceWith(empty);
        empty.after(el);
        placeCaretAtEnd(el);
        return true;
      }
    }
    block.replaceWith(el);
    placeCaretAtEnd(el);
    return true;
  }
  return false;
}

// ---------- 回车完成标记（Typora 式）：输入 "#" / "-" / "1." / ">" / "- [ ]" 后回车即排版；
//            已带内容的行（如 "# 标题"）回车时整行转换 ----------
const ENTER_MARKER_RE = [
  { re: /^(#{1,6}) ?$/, make: EMPTY_MARKER_RE[0].make },
  { re: /^([-+*]) ?$/, make: EMPTY_MARKER_RE[1].make },
  { re: /^(\d+)\. ?$/, make: EMPTY_MARKER_RE[2].make },
  { re: /^([-+*]) \[([ xX])\] ?$/, make: EMPTY_MARKER_RE[3].make },
  { re: /^> ?$/, make: EMPTY_MARKER_RE[4].make },
  { re: /^(#{1,6})\s+/, make: EMPTY_MARKER_RE[0].make, keep: true },
  { re: /^([-+*]) \[([ xX])\]\s+/, make: EMPTY_MARKER_RE[3].make, keep: true },
  { re: /^([-+*])\s+/, make: EMPTY_MARKER_RE[1].make, keep: true },
  { re: /^(\d+)\.\s+/, make: EMPTY_MARKER_RE[2].make, keep: true },
  { re: /^>\s+/, make: EMPTY_MARKER_RE[4].make, keep: true }
];


// ??????????????????????????????????Typora ??
function keepListSeparated(el) {
  if (!el || (el.tagName !== 'UL' && el.tagName !== 'OL')) return;
  const listLike = (n) => n && (n.tagName === 'UL' || n.tagName === 'OL');
  const prev = el.previousElementSibling;
  const next = el.nextElementSibling;
  if (listLike(prev) && listLike(next)) {
    const e1 = document.createElement('p'); e1.textContent = ZWSP;
    const e2 = document.createElement('p'); e2.textContent = ZWSP;
    prev.after(e1); e1.after(el); el.after(e2);
  } else if (listLike(prev)) {
    const empty = document.createElement('p'); empty.textContent = ZWSP;
    prev.after(empty); empty.after(el);
  } else if (listLike(next)) {
    const empty = document.createElement('p'); empty.textContent = ZWSP;
    el.before(empty);
  }
}

function tryEnterMarker() {
  const pane = getPane();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || composing) return false;
  const block = caretBlock();
  if (!block || block === pane) return false;
  if (block.nodeType === Node.ELEMENT_NODE) {
    const tag = block.tagName.toLowerCase();
    if (tag !== 'p' && tag !== 'div') return false;
    if (block.querySelector('br, input, img')) return false;
  }
  const text = normText(block.textContent);
  for (const rule of ENTER_MARKER_RE) {
    const m = rule.re.exec(text);
    if (!m) continue;
    pushUndo();
    let rest = '';
    if (rule.keep) {
      // 已带内容的行：保留标记后面的全部内容
      rest = text.slice(m[0].length);
    } else if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      rest = text.slice(normText(pre.toString()).length);
    }
    const el = rule.make(m);
    fillBlockWith(el, rest);
    if (block.parentNode) block.replaceWith(el);
    else pane.appendChild(el);
    keepListSeparated(el);
    if (rule.keep) {
      // 转换的同时换行（Typora 式）：标题下方补空段落，列表补空项，引用补空行
      const tag = el.tagName.toLowerCase();
      if (tag === 'blockquote') {
        const p = document.createElement('p');
        p.textContent = ZWSP;
        el.appendChild(p);
        placeCaretAtEnd(p);
      } else if (tag === 'ul' || tag === 'ol') {
        const nl = document.createElement('li');
        const firstLi = el.querySelector('li');
        if (firstLi && firstLi.querySelector('input[type=checkbox]')) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          nl.appendChild(cb);
        }
        nl.appendChild(document.createTextNode(ZWSP));
        el.appendChild(nl);
        placeCaretAtEnd(nl);
      } else {
        const p = document.createElement('p');
        p.textContent = ZWSP;
        el.after(p);
        placeCaretAtEnd(p);
      }
    } else {
      placeCaretAtEnd(el);
    }
    scheduleSerialize();
    return true;
  }
  return false;
}

// ---------- 行内语法闭合即转换：**加粗** / *斜体* / ~~删除线~~ / `代码` / [链接](url) / ![图片](url) ----------
// Convert existing line content into the new block (rest is empty on fresh input)
function fillBlockWith(el, rest) {
  const content = rest || ZWSP;
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) { el.textContent = content; return; }
  if (tag === 'blockquote') {
    const p = el.querySelector('p');
    if (p) p.textContent = content;
    return;
  }
  const li = el.querySelector('li');
  if (!li) return;
  if (li.querySelector('input[type=checkbox]')) {
    let t = li.lastChild;
    if (!t || t.nodeType !== Node.TEXT_NODE) {
      t = document.createTextNode('');
      li.appendChild(t);
    }
    t.nodeValue = content;
  } else {
    li.textContent = content;
  }
}

function formatBlock() {
  const pane = getPane();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const n = sel.getRangeAt(0).startContainer;
  const leaf = n.nodeType === Node.ELEMENT_NODE ? n : n.parentNode;
  let top = leaf;
  while (top && top !== pane && top.parentNode !== pane) top = top.parentNode;
  if (!top || top === pane) return n.nodeType === Node.TEXT_NODE ? n : null;
  const tag = top.tagName.toLowerCase();
  if (tag === 'ul' || tag === 'ol') return closestTag(n, 'li') || top;
  if (tag === 'table') return closestTag(n, 'td') || closestTag(n, 'th') || top;
  if (tag === 'blockquote') {
    for (const t of ['p', 'div', 'li', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const el = closestTag(n, t);
      if (el) return el;
    }
    return top;
  }
  return top;
}

function tryInlineFormat() {
  const pane = getPane();
  const block = formatBlock();
  if (!block || block === pane) return false;
  if (caretInPre()) return false; // 代码块内不做行内转换
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);

  // 只处理块内最后一个文本节点，避免破坏 checkbox / 图片等元素
  let lastText = null;
  if (block.nodeType === Node.TEXT_NODE) {
    lastText = block;
  } else {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) lastText = walker.currentNode;
  }
  if (!lastText) return false;
  const text = lastText.nodeValue.replace(/\u200b/g, '').replace(/\u00a0/g, ' ');
  if (range.startContainer !== lastText || range.startOffset !== lastText.nodeValue.length) return false;

  const patterns = [
    {
      re: /!\[([^\]]*)\]\(([^)\s]+)\)$/,
      make: (m) => {
        const img = document.createElement('img');
        img.src = m[2];
        img.alt = m[1] || '图片';
        return img;
      }
    },
    {
      re: /\*\*([^*]+)\*\*$/,
      make: (m) => {
        const s = document.createElement('strong');
        s.textContent = m[1];
        return s;
      }
    },
    {
      re: /\*\*\*([^*]+)\*\*\*$/,   // ***bold italic*** -> <strong><em>
      make: (m) => {
        const s = document.createElement('strong');
        const e = document.createElement('em');
        e.textContent = m[1];
        s.appendChild(e);
        return s;
      }
    },
    {
      re: /\*\*([^*]+)\*\*$/,
      make: (m) => {
        const s = document.createElement('strong');
        s.textContent = m[1];
        return s;
      }
    },
    {
      re: /__([^_]+)__$/,
      make: (m) => {
        const s = document.createElement('strong');
        s.textContent = m[1];
        return s;
      }
    },
    {
      re: /~~([^~]+)~~$/,
      make: (m) => {
        const d = document.createElement('del');
        d.textContent = m[1];
        return d;
      }
    },
    {
      re: /`([^`]+)`$/,
      make: (m) => {
        const c = document.createElement('code');
        c.textContent = m[1];
        return c;
      }
    },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)$/,
      make: (m) => {
        const a = document.createElement('a');
        a.href = m[2];
        a.textContent = m[1];
        return a;
      }
    },
    {
      re: /\*([^*\s][^*]*)\*$/,
      make: (m, full) => {
        if (m.index > 0 && full[m.index - 1] === '*') return null; // 避免把 ** 拆成斜体
        const e = document.createElement('em');
        e.textContent = m[1];
        return e;
      }
    },
    {
      re: /_([^_\s][^_]*)_$/,
      make: (m) => {
        const e = document.createElement('em');
        e.textContent = m[1];
        return e;
      }
    }
  ];

  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const el = p.make(m, text);
    if (!el) continue;
    const before = text.slice(0, m.index);
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(el);
    const tail = document.createTextNode('\u200b');
    frag.appendChild(tail);
    pushUndo();
    lastText.replaceWith(frag);
    const s = window.getSelection();
    const r = document.createRange();
    r.setStart(tail, 1);
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
    pane.focus();
    return true;
  }
  return false;
}

function caretInPre() {
  const n = caretNode();
  return n ? !!closestTag(n, 'pre') : false;
}

// ---------- 代码行号（Typora 式）：整篇开关，gutter 为不可编辑的数字列 ----------
let codeLinesEnabled = false;

function setCodeLines(enabled) {
  codeLinesEnabled = !!enabled;
  const pane = getPane();
  for (const pre of pane.querySelectorAll('pre')) {
    if (codeLinesEnabled) addCodeGutter(pre); else removeCodeGutter(pre);
  }
  syncCodeGutters();
}

function addCodeGutter(pre) {
  pre.classList.add('code-block');
  if (pre.querySelector(':scope > .code-gutter')) return;
  const g = document.createElement('span');
  g.className = 'code-gutter';
  g.setAttribute('contenteditable', 'false');
  g.textContent = '1';
  pre.insertBefore(g, pre.firstChild);
  refreshToolbar(pre);
}

function removeCodeGutter(pre) {
  const g = pre.querySelector(':scope > .code-gutter');
  if (g) g.remove();
  pre.classList.remove('code-block');
  if (!pre.className.trim()) pre.removeAttribute('class');
  refreshToolbar(pre);
}

function codeLangOf(pre) {
  const code = pre.querySelector('code');
  const m = code && /language-([\w+#.\-]+)/.exec(code.className);
  return m ? m[1] : '';
}

// Typora 式：代码块悬停时右上角显示工具条（语言标签 + 行号开关）
function ensureCodeToolbar(pre) {
  if (pre.querySelector(':scope > .code-toolbar')) return;
  const bar = document.createElement('span');
  bar.className = 'code-toolbar';
  bar.setAttribute('contenteditable', 'false');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-ln-btn';
  btn.textContent = '行号';
  btn.title = '开启/关闭代码行号';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pre.querySelector(':scope > .code-gutter')) removeCodeGutter(pre);
    else addCodeGutter(pre);
    syncCodeGutters();
    refreshToolbar(pre);
  });
  bar.appendChild(btn);
  pre.appendChild(bar);
  refreshToolbar(pre);
}

function refreshToolbar(pre) {
  const btn = pre.querySelector(':scope > .code-toolbar .code-ln-btn');
  if (btn) btn.classList.toggle('active', !!pre.querySelector(':scope > .code-gutter'));
}

// ---------- 代码语言：右下角选择器 + 编辑实时高亮（Typora 式） ----------
const CODE_LANGS = [
  ['js', 'JavaScript'], ['ts', 'TypeScript'], ['py', 'Python'], ['java', 'Java'],
  ['c', 'C'], ['cpp', 'C++'], ['cs', 'C#'], ['go', 'Go'], ['rs', 'Rust'],
  ['rb', 'Ruby'], ['php', 'PHP'], ['swift', 'Swift'], ['kt', 'Kotlin'],
  ['sql', 'SQL'], ['html', 'HTML'], ['css', 'CSS'], ['json', 'JSON'],
  ['xml', 'XML'], ['yaml', 'YAML'], ['toml', 'TOML'], ['bash', 'Bash'],
  ['sh', 'Shell'], ['md', 'Markdown'], ['diff', 'Diff'], ['ini', 'INI'],
  ['properties', 'Properties'], ['dockerfile', 'Dockerfile'], ['makefile', 'Makefile'],
  ['lua', 'Lua'], ['perl', 'Perl'], ['r', 'R'], ['dart', 'Dart']
];

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 重建代码高亮（不改变文本内容，只包 <span class="hljs-*">），保持光标位置
function highlightCodeBlock(pre) {
  const code = pre.querySelector('code');
  if (!code) return;
  const lang = codeLangOf(pre);
  const sel = window.getSelection();
  let keep = -1;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const sn = range.startContainer;
    if (code.contains(sn)) {
      const preRange = document.createRange();
      preRange.selectNodeContents(code);
      preRange.setEnd(sn, range.startOffset);
      const before = preRange.toString();
      let zw = 0;
      for (const ch of before) if (ch === ZWSP) zw++;
      keep = before.length - zw;
    }
  }
  const raw = (code.textContent || '').replace(/\u200b/g, '');
  let html = '';
  if (lang && hljs.getLanguage(lang)) {
    try { html = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value; }
    catch (err) { html = escapeHtml(raw); }
  } else {
    html = escapeHtml(raw);
  }
  code.innerHTML = html;
  if (!code.textContent) code.appendChild(document.createTextNode(ZWSP));
  if (keep >= 0) placeCaretAtOffset(code, Math.min(keep, (code.textContent || '').length));
}

let highlightTimer = null;
function scheduleHighlight(pre) {
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    if (pre && pre.isConnected) highlightCodeBlock(pre);
  }, 260);
}

function setCodeLang(pre, lang) {
  const code = pre.querySelector('code');
  if (!code) return;
  if (lang) code.className = 'language-' + lang;
  else code.removeAttribute('class');
  updateLangPicker(pre);
  highlightCodeBlock(pre);
  scheduleSerialize();
}

function codeLangName(pre) {
  const l = codeLangOf(pre);
  return l || 'text';
}

function updateLangPicker(pre) {
  const picker = pre.querySelector(':scope > .code-lang-picker');
  if (picker) picker.textContent = codeLangName(pre);
}

function ensureCodeLangPicker(pre) {
  if (pre.querySelector(':scope > .code-lang-picker')) {
    updateLangPicker(pre);
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-lang-picker';
  btn.setAttribute('contenteditable', 'false');
  btn.textContent = codeLangName(pre);
  btn.title = '选择代码语言';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showLangMenu(pre, btn);
  });
  pre.appendChild(btn);
}

let langMenuEl = null;
let langMenuPre = null;
function buildLangMenu() {
  if (langMenuEl) return langMenuEl;
  const menu = document.createElement('div');
  menu.className = 'code-lang-menu';
  menu.setAttribute('contenteditable', 'false');
  const input = document.createElement('input');
  input.className = 'code-lang-input';
  input.placeholder = '输入语言名，回车应用';
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'code-lang-list';
  menu.appendChild(input);
  menu.appendChild(list);
  menu.hidden = true;
  document.body.appendChild(menu);
  langMenuEl = menu;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const cur = langMenuPre ? codeLangName(langMenuPre) : '';
    const items = CODE_LANGS.filter(([k]) => !q || k.indexOf(q) !== -1 || k === q || (q && k.startsWith(q)));
    list.textContent = '';
    for (const [k, name] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'code-lang-item' + (k === cur ? ' active' : '');
      b.textContent = name;
      b.dataset.lang = k;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (langMenuPre) setCodeLang(langMenuPre, k);
        hideLangMenu();
      });
      list.appendChild(b);
    }
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      const first = list.querySelector('.code-lang-item');
      const lang = first ? first.dataset.lang : (q || '');
      if (langMenuPre && lang) setCodeLang(langMenuPre, lang);
      hideLangMenu();
    } else if (e.key === 'Escape') {
      hideLangMenu();
    }
    e.stopPropagation();
  });
  render();
  return menu;
}

function showLangMenu(pre, btn) {
  const menu = buildLangMenu();
  langMenuPre = pre;
  const input = menu.querySelector('.code-lang-input');
  input.value = '';
  input.dispatchEvent(new Event('input'));
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + 'px';
  const h = Math.min(320, menu.offsetHeight || 320);
  menu.style.top = (rect.bottom + 4 > window.innerHeight - h ? rect.top - h - 4 : rect.bottom + 4) + 'px';
  input.focus();
}

function hideLangMenu() {
  if (langMenuEl) langMenuEl.hidden = true;
  langMenuPre = null;
}

function onDocClickForLangMenu(e) {
  if (langMenuEl && !langMenuEl.hidden && langMenuEl !== e.target && !langMenuEl.contains(e.target)) {
    hideLangMenu();
  }
}

function codeLineCount(pre) {
  const code = pre.querySelector('code') || pre;
  const text = (code.textContent || '').replace(/\u200b/g, '');
  return Math.max(1, text.split('\n').length);
}

function syncCodeGutters() {
  for (const pre of getPane().querySelectorAll('pre')) {
    const g = pre.querySelector(':scope > .code-gutter');
    if (!g) continue;
    const nums = [];
    for (let i = 1; i <= codeLineCount(pre); i++) nums.push(String(i));
    const text = nums.join('\n');
    if (g.textContent !== text) g.textContent = text;
  }
}

// 代码块内：\n 文本行模型。回车只在光标处插入一个 \n，绝不拆 <pre> 块；
// 关键：\n 必须写进当前文本节点内部——独立 \n 文本节点会让 Chromium 把后续打字重定向到上一节点末尾
function insertNewlineInCode() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  let at = range.startContainer;
  let off = range.startOffset;
  if (at.nodeType !== Node.TEXT_NODE) {
    // 元素边界：找相邻文本节点写入；实在没有就补一个空文本节点
    const kids = Array.from(at.childNodes);
    const after = kids[off];
    const before = kids[off - 1];
    const t = after && after.nodeType === Node.TEXT_NODE ? after :
      (before && before.nodeType === Node.TEXT_NODE ? before : null);
    if (t) {
      at = t;
      off = after === t ? 0 : t.nodeValue.length;
    } else {
      const tn = document.createTextNode('');
      at.insertBefore(tn, after || null);
      at = tn;
      off = 0;
    }
  }
  at.nodeValue = at.nodeValue.slice(0, off) + '\n' + at.nodeValue.slice(off);
  const caretOff = off + 1;
  // Chromium 边界行为：光标停在“块末尾的 \n”之后时，下一次打字会被重定向到 \n 前。
  // 行尾补一个不可见 ZWSP 占位（序列化时会被清掉），光标停在 ZWSP 前，打字落在 \n 后。
  if (caretOff === at.nodeValue.length) {
    const sib = at.nextSibling;
    if (!(sib && sib.nodeType === Node.TEXT_NODE && sib.nodeValue === ZWSP)) {
      at.parentNode.insertBefore(document.createTextNode(ZWSP), sib);
    }
  }
  const r = document.createRange();
  r.setStart(at, caretOff);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function textOffsetIn(code, node, off) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let t = walker.nextNode();
  while (t) {
    if (t === node) return acc + off;
    acc += t.nodeValue.length;
    t = walker.nextNode();
  }
  return acc;
}

function placeCaretAtStart(el) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const first = walker.nextNode();
  if (first) {
    range.setStart(first, 0);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

// Typora 式：代码块第一行按 ↑ / 最后一行按 ↓ 退出代码块
// ↓/↑：多行文本块（段落/标题/列表/引用等）内按行移动，不跳块（Typora 式）
function moveVerticalInText(isDown) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  const pane = getPane();
  let block = range.startContainer;
  while (block && block !== pane && block.parentNode !== pane) block = block.parentNode;
  if (!block || block === pane) return false;
  const text = block.textContent || '';
  if (text.indexOf('\n') === -1) return false; // 单行块：交给浏览器默认（进入下一块）
  const flat = textOffsetIn(block, range.startContainer, range.startOffset);
  const nlBefore = text.lastIndexOf('\n', flat - 1);
  const nlAfter = text.indexOf('\n', flat);
  const lineStart = nlBefore + 1;
  const col = flat - lineStart;
  let target = -1;
  if (isDown) {
    if (nlAfter === -1) return false; // 已在最后一行
    const line2Start = nlAfter + 1;
    const line2End = text.indexOf('\n', line2Start);
    const line2Len = (line2End === -1 ? text.length : line2End) - line2Start;
    target = line2Start + Math.min(col, line2Len);
  } else {
    if (nlBefore === -1) return false; // 已在第一行
    const line1Start = text.lastIndexOf('\n', nlBefore - 1) + 1;
    const line1Len = nlBefore - line1Start;
    target = line1Start + Math.min(col, line1Len);
  }
  if (target === flat) return false;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let t = walker.nextNode();
  while (t) {
    const len = t.nodeValue.length;
    if (target <= acc + len) {
      const r = document.createRange();
      r.setStart(t, Math.max(0, Math.min(len, target - acc)));
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      block.focus();
      return true;
    }
    acc += len;
    t = walker.nextNode();
  }
  return false;
}
// 文档末尾空段落：点击尾部空白 / ↓ 时把光标送到可编辑的尾部位置（Typora 尾部可编辑规则）
function ensureEndParagraph() {
  const pane = getPane();
  const last = pane.lastElementChild;
  if (last && last.tagName !== "PRE" && /^(\u200b\s*|\s*)$/.test(last.textContent || "")) {
    return last; // 末尾已有空段落：复用
  }
  const p = document.createElement("p");
  p.textContent = ZWSP;
  pane.appendChild(p);
  scheduleSerialize();
  return p;
}

// 光标是否位于整篇文档最后一个文本节点（末尾位置）
function isCaretAtDocEnd() {
  const pane = getPane();
  const lastEl = pane.lastElementChild;
  const root = lastEl || pane;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const r = sel.getRangeAt(0);
  const sn = r.startContainer;
  if (sn.nodeType !== Node.TEXT_NODE || !root.contains(sn)) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let t = walker.nextNode();
  let lastText = null;
  while (t) { lastText = t; t = walker.nextNode(); }
  return !!lastText && sn === lastText && r.startOffset >= lastText.nodeValue.length;
}

// 在文档末尾新建一个空段落并放入光标（↑ 在文档开头时对称处理）
function moveCaretToNewEndParagraph(before) {
  const pane = getPane();
  const p = document.createElement("p");
  p.textContent = ZWSP;
  if (before && pane.firstElementChild) pane.insertBefore(p, pane.firstElementChild);
  else pane.appendChild(p);
  scheduleSerialize();
  return p;
}
function exitTableOnArrow(isDown) {
  const node = caretNode();
  const table = closestTag(node, 'table');
  if (!table) return false;
  const tr = closestTag(node, 'tr');
  if (!tr) return false;
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  if (!rows.length) return false;
  const onFirst = rows[0] === tr;
  const onLast = rows[rows.length - 1] === tr;
  if (isDown ? !onLast : !onFirst) return false;
  pushUndo();
  if (isDown) {
    const next = table.nextElementSibling;
    if (next) { placeCaretAtStart(next); return true; }
    // 文档末尾 ↓：光标移到尾部新建的空段落
    const p = moveCaretToNewEndParagraph(false);
    placeCaretAtEnd(p);
  } else {
    const prev = table.previousElementSibling;
    if (prev) { placeCaretAtEnd(prev); return true; }
    const p = moveCaretToNewEndParagraph(true);
    placeCaretAtEnd(p);
  }
  return true;
}

function exitCodeBlockOnArrow(isDown) {
  const pre = closestTag(caretNode(), 'pre');
  if (!pre) return false;
  const code = pre.querySelector('code') || pre;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const flat = textOffsetIn(code, range.startContainer, range.startOffset);
  const text = code.textContent || '';
  const firstNl = text.indexOf('\n');
  const lastNl = text.lastIndexOf('\n');
  const onFirst = firstNl < 0 || flat <= firstNl;
  const onLast = lastNl < 0 || flat > lastNl;
  if (isDown ? !onLast : !onFirst) return false;
  pushUndo();
  if (isDown) {
    const next = pre.nextElementSibling;
    if (next) { placeCaretAtStart(next); return true; }
    // 文档末尾 ↓：光标移到尾部新建的空段落（Typora 尾部可编辑）
    const p = moveCaretToNewEndParagraph(false);
    placeCaretAtEnd(p);
  } else {
    const prev = pre.previousElementSibling;
    if (prev) { placeCaretAtEnd(prev); return true; }
    // 文档开头 ↑：光标移到开头新建的空段落
    const p = moveCaretToNewEndParagraph(true);
    placeCaretAtEnd(p);
  }
  return true;
}

// ---------- 快照式撤销 / 重做（Typora 式）：转换类操作（# / ** / 退格降级等）可 Ctrl+Z 还原成原文 ----------
let undoStack = [];
let redoStack = [];
let preInputSnapshot = null;
const UNDO_LIMIT = 30;

function snapshotState() {
  const pane = getPane();
  // 超大文档（如数万行代码块）不做整块深拷贝，避免撤销操作卡死；此时回落到浏览器原生撤销
  if ((pane.textContent || '').length > 200000) return null;
  const sel = window.getSelection();
  let offset = 0;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(pane);
    pre.setEnd(range.startContainer, range.startOffset);
    offset = pre.toString().length;
  }
  return { clone: pane.cloneNode(true), offset };
}

function pushUndo() {
  const pre = preInputSnapshot;
  preInputSnapshot = null;
  const snap = pre || snapshotState();
  if (!snap) return; // 超大文档跳过快照
  undoStack.push(snap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function restoreSnapshot(entry) {
  const pane = getPane();
  const kids = Array.from(entry.clone.childNodes);
  pane.replaceChildren(...kids);
  dirty = true;
  scheduleSerialize();
  placeCaretAtOffset(pane, entry.offset);
  pane.focus();
}

function performUndo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshotState());
  if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  restoreSnapshot(undoStack.pop());
  return true;
}

function performRedo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  restoreSnapshot(redoStack.pop());
  return true;
}

// ---------- 回车行为 ----------

function enterInHeading(h) {
  pushUndo();
  const offset = caretOffsetInBlock(h);
  const raw = h.textContent || '';
  if (offset === 0) {
    // 标题行首回车：在标题上方插入段落
    const p = document.createElement('p');
    p.textContent = ZWSP;
    h.before(p);
    placeCaretAtEnd(p);
    scheduleSerialize();
    return;
  }
  h.textContent = raw.slice(0, offset).replace(/\u200b/g, '');
  const p = document.createElement('p');
  p.textContent = raw.slice(offset).replace(/\u200b/g, '') || ZWSP;
  h.after(p);
  placeCaretAtEnd(p);
  scheduleSerialize();
}

function liIsEmpty(li) {
  if (normText(li.textContent).trim() !== '') return false;
  if (li.querySelector('ul, ol, img')) return false;
  // 含多个 checkbox 的 li 不视为空项（避免误删任务列表）
  const cbs = li.querySelectorAll('input[type=checkbox]');
  return cbs.length <= 1;
}

function exitList(li) {
  pushUndo();
  const list = li.parentNode;
  const pane = getPane();
  const parentLi = list && list.parentNode && list.parentNode.tagName === 'LI' ? list.parentNode : null;
  const next = list ? list.nextSibling : null;
  li.remove();
  if (list && !list.children.length) list.remove();
  if (parentLi) {
    placeCaretAtEnd(parentLi);
  } else {
    const p = document.createElement('p');
    p.textContent = ZWSP;
    pane.insertBefore(p, next);
    placeCaretAtEnd(p);
  }
  scheduleSerialize();
}

// non-empty list item, caret at start: strip bullet and demote to paragraph (Typora style)
function demoteListItem(li) {
  pushUndo();
  const list = li.parentNode;
  const parentLi = list && list.parentNode && list.parentNode.tagName === 'LI' ? list.parentNode : null;
  const pane = getPane();
  const next = list ? list.nextSibling : null;
  const p = document.createElement('p');
  p.textContent = normText(li.textContent) || ZWSP;
  li.remove();
  if (list && !list.children.length) list.remove();
  if (parentLi) {
    parentLi.after(p);
  } else {
    pane.insertBefore(p, next);
  }
  placeCaretAtEnd(p);
  scheduleSerialize();
}

function enterInListItem(li) {
  const list = li.parentNode;
  if (liIsEmpty(li)) { exitList(li); return; }
  pushUndo();
  const canSplit = !li.querySelector('ul, ol, input, img');
  if (canSplit) {
    const offset = caretOffsetInBlock(li);
    const raw = li.textContent || '';
    li.textContent = raw.slice(0, offset).replace(/\u200b/g, '');
    const nl = document.createElement('li');
    nl.textContent = raw.slice(offset).replace(/\u200b/g, '') || ZWSP;
    li.after(nl);
    placeCaretAtEnd(nl);
  } else {
    // 含 checkbox / 图片 / 嵌套列表：复制同结构新项
    const nl = li.cloneNode(false);
    nl.innerHTML = '';
    const cb = li.querySelector('input[type=checkbox]');
    if (cb) {
      const ncb = document.createElement('input');
      ncb.type = 'checkbox';
      nl.appendChild(ncb);
    }
    nl.appendChild(document.createTextNode(ZWSP));
    li.after(nl);
    placeCaretAtEnd(nl);
  }
  scheduleSerialize();
}

function blockInside(bq) {
  const node = caretNode();
  let cur = node && node.nodeType === Node.ELEMENT_NODE ? node : (node ? node.parentNode : null);
  while (cur && cur !== bq && cur.parentNode !== bq) cur = cur.parentNode;
  return cur && cur !== bq ? cur : null;
}

function enterInBlockquote(bq) {
  pushUndo();
  const curBlock = blockInside(bq);
  const p = document.createElement('p');
  p.textContent = ZWSP;
  if (!curBlock || blockIsEmpty(curBlock)) {
    // 空引用行回车：退出引用
    const pane = getPane();
    const next = bq.nextSibling;
    if (curBlock) curBlock.remove();
    if (!bq.children.length) bq.remove();
    pane.insertBefore(p, next);
    placeCaretAtEnd(p);
  } else {
    curBlock.after(p);
    placeCaretAtEnd(p);
  }
  scheduleSerialize();
}

function enterInTable() {
  pushUndo();
  const node = caretNode();
  const tr = closestTag(node, 'tr');
  if (!tr) return;
  // 表格内空行回车：退出表格
  if (tr.parentNode && tr.parentNode.tagName === 'TBODY') {
    const cells = Array.from(tr.children);
    const allEmpty = cells.length > 0 && cells.every((c) => normText(c.textContent) === '');
    if (allEmpty) {
      const table = tr.parentNode.parentNode;
      const pane = getPane();
      const next = table.nextSibling;
      tr.remove();
      if (table.parentNode && !table.querySelector('tbody tr')) table.remove();
      const p = document.createElement('p');
      p.textContent = ZWSP;
      pane.insertBefore(p, next);
      placeCaretAtEnd(p);
      scheduleSerialize();
      return;
    }
  }
  const count = tr.children.length || 1;
  const nr = tr.cloneNode(false);
  for (let i = 0; i < count; i++) {
    const cell = document.createElement('td');
    cell.textContent = ZWSP;
    nr.appendChild(cell);
  }
  if (tr.parentNode && tr.parentNode.tagName === 'THEAD') {
    const table = tr.parentNode.parentNode;
    const tbody = table.querySelector('tbody') || (() => {
      const tb = document.createElement('tbody');
      table.appendChild(tb);
      return tb;
    })();
    tbody.appendChild(nr);
  } else {
    tr.after(nr);
  }
  placeCaretAtEnd(nr.firstChild);
  scheduleSerialize();
}

// ---------- 行级触发：``` 围栏 / --- 分割线 / | a | b | 表格 ----------
function startCodeFence(text) {
  pushUndo();
  const block = caretBlock();
  const lang = text.replace(/^(```+|~~~+)\s*/, '').trim();
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (lang) code.className = 'language-' + lang;
  code.appendChild(document.createTextNode(ZWSP));
  pre.appendChild(code);
  ensureCodeToolbar(pre);
  ensureCodeLangPicker(pre);
  if (codeLinesEnabled) addCodeGutter(pre);
  if (block) block.replaceWith(pre); else getPane().appendChild(pre);
  placeCaretAtEnd(code);
  syncCodeGutters();
  scheduleSerialize();
}

function startHorizontalRule(block) {
  pushUndo();
  const pane = getPane();
  const hr = document.createElement('hr');
  const p = document.createElement('p');
  p.textContent = ZWSP;
  if (block && block.parentNode === pane) {
    block.replaceWith(hr);
    hr.after(p);
  } else {
    pane.appendChild(hr);
    pane.appendChild(p);
  }
  placeCaretAtEnd(p);
  scheduleSerialize();
}

function parseTableLine(line) {
  const t = line.trim();
  if (!/^\|.+\|$/.test(t)) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()).filter((c) => c !== '');
}

function startTable(block, cells) {
  pushUndo();
  const pane = getPane();
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const c of cells) {
    const th = document.createElement('th');
    th.textContent = c;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  for (let i = 0; i < cells.length; i++) {
    const td = document.createElement('td');
    td.textContent = ZWSP;
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
  table.appendChild(thead);
  table.appendChild(tbody);
  if (block && block.parentNode === pane) {
    block.replaceWith(table);
  } else {
    pane.appendChild(table);
  }
  placeCaretAtEnd(tr.firstChild);
  scheduleSerialize();
}

function tryLineTrigger() {
  const block = caretBlock();
  if (!block || block === getPane()) return false;
  if (block.nodeType === Node.ELEMENT_NODE) {
    if (block.querySelector('br, input, img')) return false;
    const tag = block.tagName.toLowerCase();
    if (tag !== 'p' && tag !== 'div') return false;
  }
  const text = normText(block.textContent);
  if (/^(```+|~~~+)[\w+#.\-]* ?$/.test(text)) { startCodeFence(text); return true; }
  if (/^(---|\*\*\*|___) ?$/.test(text)) { startHorizontalRule(block); return true; }
  const cells = parseTableLine(text);
  if (cells && cells.length >= 2) { startTable(block, cells); return true; }
  return false;
}

// ---------- 退格行为 ----------
function handleBackspace() {
  const node = caretNode();
  if (!node) return false;
  // 退格删除自动配对的空括号（Typora 式）：() [] {} "" '' `` 相邻时一次删掉
  const ch = charsAtCaret();
  if (ch.prev && ch.next && PAIR_MAP[ch.prev] === ch.next) {
    pushUndo();
    deleteCharRange(ch.idx - 1, ch.idx + 1);
    scheduleSerialize();
    return true;
  }
  // 悬停标记行退格：删掉光标前一个字符；标记失效自动还原为普通文本
  const pendEl = closestTag(node, 'p') || closestTag(node, 'div');
  if (pendEl && pendEl.hasAttribute('data-md-pending')) {
    const flat = caretFlatIndex();
    if (flat > 0) {
      pushUndo();
      deleteCharRange(flat - 1, flat);
      scheduleSerialize();
      return true;
    }
    return false; // 行首退格：交给原生（合并到上一块）
  }
  // hr 块退格：把分割线还原成 --- 文本
  const pEl = closestTag(node, 'p');
  if (pEl && blockIsEmpty(pEl) && pEl.previousElementSibling && pEl.previousElementSibling.tagName === 'HR') {
    pushUndo();
    pEl.previousElementSibling.remove();
    pEl.textContent = '---';
    placeCaretAtEnd(pEl);
    scheduleSerialize();
    return true;
  }
  const li = closestTag(node, 'li');
  if (li && liIsEmpty(li)) { exitList(li); return true; }
  // non-empty list item with caret at start: demote to paragraph
  if (li && caretOffsetInBlock(li) === 0 && !li.querySelector('input, ul, ol, img')) {
    demoteListItem(li);
    return true;
  }
  const bq = closestTag(node, 'blockquote');
  let cur = null;
  if (bq) {
    cur = blockInside(bq);
    if (cur && blockIsEmpty(cur)) {
      const pane = getPane();
      const next = bq.nextSibling;
      pushUndo();
      cur.remove();
      if (!bq.children.length) bq.remove();
      const p = document.createElement('p');
      p.textContent = ZWSP;
      pane.insertBefore(p, next);
      placeCaretAtEnd(p);
      scheduleSerialize();
      return true;
    }
  }
  // non-empty first block of quote with caret at start: exit quote
  if (bq && cur && cur === bq.firstElementChild && caretOffsetInBlock(cur) === 0 && !blockIsEmpty(cur)) {
    const pane = getPane();
    const next = bq.nextSibling;
    const p = document.createElement('p');
    p.textContent = normText(cur.textContent) || ZWSP;
    pushUndo();
    cur.remove();
    if (!bq.children.length) bq.remove();
    pane.insertBefore(p, bq.isConnected ? bq : next);
    placeCaretAtEnd(p);
    scheduleSerialize();
    return true;
  }
  const h = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  const heading = closestTag(h, 'h1') || closestTag(h, 'h2') || closestTag(h, 'h3') ||
    closestTag(h, 'h4') || closestTag(h, 'h5') || closestTag(h, 'h6');
  if (heading) {
    const sel = window.getSelection();
    const offset = sel && sel.rangeCount ? sel.getRangeAt(0).startOffset : -1;
    const htext = normText(heading.textContent);
    if (htext === '') {
      // 空标题退格：直接变回空段落（Typora 式），# 可继续删除，不留空壳 <br>
      const p = document.createElement('p');
      p.textContent = ZWSP;
      pushUndo();
      heading.replaceWith(p);
      placeCaretAtEnd(p);
      scheduleSerialize();
      return true;
    }
    if (offset === 0) {
      const p = document.createElement('p');
      p.textContent = heading.textContent || ZWSP;
      pushUndo();
      heading.replaceWith(p);
      placeCaretAtEnd(p);
      scheduleSerialize();
      return true;
    }
  }
  return false;
}

// ---------- 光标位置改动提交标记（Typora 式）：输入 # 后空格 / 方向键 / 点击都会触发 ----------
const CARET_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
let lastMarkerBlock = null;

function isMarkerLine(block) {
  if (!block || block === getPane()) return false;
  if (block.nodeType === Node.ELEMENT_NODE) {
    const tag = block.tagName.toLowerCase();
    if (tag !== 'p' && tag !== 'div') return false;
    if (block.querySelector('br, input, img')) return false;
  }
  return ENTER_MARKER_RE.some((r) => r.re.test(normText(block.textContent)));
}

// 把行首标记块转成标题/列表/引用等，转换时尽量保留光标在内容里的相对位置
function convertMarkerBlock(block) {
  const pane = getPane();
  const sel = window.getSelection();
  if (!block || block === pane) return false;
  if (block.nodeType === Node.ELEMENT_NODE) {
    const tag = block.tagName.toLowerCase();
    if (tag !== 'p' && tag !== 'div') return false;
    if (block.querySelector('br, input, img')) return false;
  }
  const selStart = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
  const caretInside = !!selStart && (selStart === block || (block.nodeType === Node.ELEMENT_NODE && block.contains(selStart)));
  const text = normText(block.textContent);
  for (const rule of ENTER_MARKER_RE) {
    const m = rule.re.exec(text);
    if (!m) continue;
    pushUndo();
    let rest = '';
    let caret = -1;
    if (rule.keep) {
      rest = text.slice(m[0].length);
      if (caretInside) caret = Math.max(0, caretOffsetInBlock(block) - m[0].length);
    } else if (caretInside && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      rest = text.slice(normText(pre.toString()).length);
    }
    const el = rule.make(m);
    fillBlockWith(el, rest);
    if (block.parentNode) {
      block.replaceWith(el);
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        const listLike = (n) => n && (n.tagName === 'UL' || n.tagName === 'OL');
        const prev = el.previousElementSibling;
        const next = el.nextElementSibling;
        if (listLike(prev) && listLike(next)) {
          const e1 = document.createElement('p'); e1.textContent = ZWSP;
          const e2 = document.createElement('p'); e2.textContent = ZWSP;
          prev.after(e1); e1.after(el); el.after(e2);
        } else if (listLike(prev)) {
          const empty = document.createElement('p'); empty.textContent = ZWSP;
          prev.after(empty); empty.after(el);
        } else if (listLike(next)) {
          const empty = document.createElement('p'); empty.textContent = ZWSP;
          el.before(empty);
        }
      }
    } else pane.appendChild(el);
    keepListSeparated(el);
    if (caretInside) {
      if (caret >= 0) placeCaretAtOffset(el, caret);
      else placeCaretAtEnd(el);
    }
    scheduleSerialize();
    return true;
  }
  return false;
}

function tryCommitMarker() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || composing) return false;
  return convertMarkerBlock(caretBlock());
}

function onKeyUp(e) {
  if (composing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (CARET_KEYS.indexOf(e.key) === -1) return;
  // 块级元素两段式（Typora）：只有光标离开标记行，才正式提交渲染；
  // 方向键仍在行内移动时保持编辑预览
  if (lastMarkerBlock && lastMarkerBlock.isConnected) {
    const b = lastMarkerBlock;
    const cur = caretBlock();
    if (cur !== b && !(b.nodeType === Node.ELEMENT_NODE && b.contains(cur))) {
      lastMarkerBlock = null;
      convertMarkerBlock(b);
    }
  }
}

// ---------- Tab：列表缩进 / 表格跳格 / 代码块缩进 ----------
function indentListItem(li) {
  const prev = li.previousElementSibling;
  const list = li.parentNode;
  if (!prev) return;
  pushUndo();
  const sub = document.createElement(list && list.tagName === 'OL' ? 'ol' : 'ul');
  sub.appendChild(li);
  prev.appendChild(sub);
  placeCaretAtEnd(li);
  scheduleSerialize();
}

function outdentListItem(li) {
  const list = li.parentNode;
  const parentLi = list && list.parentNode && list.parentNode.tagName === 'LI' ? list.parentNode : null;
  if (!parentLi) return;
  pushUndo();
  parentLi.after(li);
  if (list && !list.children.length) list.remove();
  placeCaretAtEnd(li);
  scheduleSerialize();
}

function moveTableCell(delta) {
  const node = caretNode();
  const td = closestTag(node, 'td') || closestTag(node, 'th');
  const tr = closestTag(node, 'tr');
  if (!td || !tr) return;
  const cells = Array.from(tr.children);
  let idx = cells.indexOf(td) + delta;
  let target = tr;
  if (idx >= cells.length) { target = tr.nextElementSibling; idx = 0; }
  if (idx < 0) { target = tr.previousElementSibling; if (!target) return; idx = target.children.length - 1; }
  const cell = target && target.children[idx];
  if (cell) placeCaretAtEnd(cell);
}
// ---------- 事件 ----------
let pendingInputTimer = null;
function onInput() {
  if (composing) return;
  // ???? tick ????execCommand ??? input ???????????
  // Chromium ?????? li -> h1 ??????????????
  clearTimeout(pendingInputTimer);
  const node = caretNode();
  const inPre = node ? closestTag(node, 'pre') : null;
  if (inPre) scheduleHighlight(inPre);
  pendingInputTimer = setTimeout(() => {
    if (tryEmptyMarker()) { scheduleSerialize(); return; }
    if (tryInlineFormat()) { scheduleSerialize(); return; }
    syncCodeGutters();
    scheduleSerialize();
  }, 0);
}

// Ctrl+1..6 / Ctrl+0: convert current block to heading / paragraph (Typora shortcut)
function setHeadingLevel(level) {
  const block = caretBlock();
  if (!block || block === getPane()) return;
  if (block.nodeType === Node.TEXT_NODE) {
    const el = document.createElement(level === 0 ? 'p' : 'h' + level);
    el.textContent = block.nodeValue || ZWSP;
    pushUndo();
    block.replaceWith(el);
    placeCaretAtEnd(el);
    scheduleSerialize();
    return;
  }
  const tag = block.tagName.toLowerCase();
  if (tag !== 'p' && tag !== 'div' && !/^h[1-6]$/.test(tag)) return;
  const el = level === 0 ? document.createElement('p') : document.createElement('h' + level);
  el.textContent = normText(block.textContent) || ZWSP;
  pushUndo();
  block.replaceWith(el);
  placeCaretAtEnd(el);
  scheduleSerialize();
}

// ---------- ?????Typora ????????? Ctrl+Z ?????????? ----------
const CONVERSION_KEYS = /[#\-+*>0-9\[\]`"'~_!]/;
function capturePreInput(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || composing) { preInputSnapshot = null; return; }
  const key = e.key;
  const block = caretBlock();
  let tb = '';
  if (block) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      tb = normText(pre.toString());
    }
  }
  const isSyntax = CONVERSION_KEYS.test(key);
  if (isSyntax ? (tb === '' || /[#\-+*>0-9\[\]`"'~_!]$/.test(tb)) : (key === ' ' && /^[#>\-+*0-9]+$/.test(tb))) {
    preInputSnapshot = snapshotState();
  } else {
    preInputSnapshot = null;
  }
}

function onKeyDown(e) {
  capturePreInput(e);
  const node = caretNode();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    flush();
    if (onSaveCb) onSaveCb();
    return;
  }
  if (composing) return;
  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z：转换类操作走快照撤销/重做，无快照时回落到浏览器原生（普通打字）
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey && undoStack.length) {
      e.preventDefault();
      performUndo();
      return;
    }
    if (k === 'z' && e.shiftKey && redoStack.length) {
      e.preventDefault();
      performRedo();
      return;
    }
    if (k === 'y' && !e.shiftKey && redoStack.length) {
      e.preventDefault();
      performRedo();
      return;
    }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const node = caretNode();
    if (node && closestTag(node, 'pre')) {
      if (exitCodeBlockOnArrow(e.key === 'ArrowDown')) {
        e.preventDefault();
        return;
      }
    } else if (node && closestTag(node, 'table')) {
      if (exitTableOnArrow(e.key === 'ArrowDown')) {
        e.preventDefault();
        return;
      }
    } else if (moveVerticalInText(e.key === 'ArrowDown')) {
      e.preventDefault();
      return;
    } else if (e.key === 'ArrowDown' && isCaretAtDocEnd()) {
      // 文档末尾 ↓：光标移到尾部空白新建的空段落（Typora 尾部可编辑）
      pushUndo();
      const b = caretBlock();
      if (isMarkerLine(b)) lastMarkerBlock = b;
      const p = moveCaretToNewEndParagraph(false);
      placeCaretAtEnd(p);
      e.preventDefault();
      return;
  }
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && CARET_KEYS.indexOf(e.key) !== -1) {
    const b = caretBlock();
    lastMarkerBlock = isMarkerLine(b) ? b : null;
  } else if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown' &&
             e.key !== 'Home' && e.key !== 'End' && e.key !== 'PageUp' && e.key !== 'PageDown') {
    lastMarkerBlock = null;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[0-6]$/.test(e.key)) {
    e.preventDefault();
    setHeadingLevel(parseInt(e.key, 10));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    document.execCommand('bold');
    scheduleSerialize();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    document.execCommand('italic');
    scheduleSerialize();
    return;
  }
  if (handleAutoPair(e)) return;
  if (e.key === 'Enter' && node && closestTag(node, 'pre')) {
    e.preventDefault();
    pushUndo();
    insertNewlineInCode();
    syncCodeGutters();
    scheduleSerialize();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (node && closestTag(node, 'table')) { e.preventDefault(); enterInTable(); return; }
    const block = caretBlock();
    if (block && block !== getPane()) {
      const isText = block.nodeType === Node.TEXT_NODE;
      const tag = isText ? '' : block.tagName.toLowerCase();
      if ((isText || tag === 'p' || tag === 'div') && tryLineTrigger()) { e.preventDefault(); return; }
      if ((isText || tag === 'p' || tag === 'div') && tryEnterMarker()) { e.preventDefault(); return; }
      const li = closestTag(node, 'li');
      if (li) { e.preventDefault(); enterInListItem(li); return; }
      const bq = closestTag(node, 'blockquote');
      if (bq) { e.preventDefault(); enterInBlockquote(bq); return; }
      if (/^h[1-6]$/.test(tag)) { e.preventDefault(); enterInHeading(block); return; }
    }
    return; // 普通段落：浏览器原生拆分（保持段落类型）
  }
  if (e.key === 'Backspace') {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) return; // 有选区走原生
    if (handleBackspace()) e.preventDefault();
    return;
  }
  if (e.key === 'Tab') {
    if (node && closestTag(node, 'pre')) { e.preventDefault(); document.execCommand('insertText', false, '    '); return; }
    if (node && closestTag(node, 'table')) { e.preventDefault(); moveTableCell(e.shiftKey ? -1 : 1); return; }
    const li = node && closestTag(node, 'li');
    if (li) { e.preventDefault(); if (e.shiftKey) outdentListItem(li); else indentListItem(li); return; }
    e.preventDefault();
    document.execCommand('insertText', false, '    ');
  }
}

function onClick(e) {
  const cb = e.target && e.target.closest ? e.target.closest('input[type=checkbox]') : null;
  if (cb) {
    e.preventDefault();
    pushUndo();
    cb.checked = !cb.checked;
    scheduleSerialize();
    return;
  }
  // 点击文档其他位置：光标离开标记行 → 提交刚离开的那一行
  if (lastMarkerBlock && lastMarkerBlock.isConnected) {
    const b = lastMarkerBlock;
    const cur = caretBlock();
    if (cur !== b && !(b.nodeType === Node.ELEMENT_NODE && b.contains(cur))) {
      lastMarkerBlock = null;
      convertMarkerBlock(b);
    }
  }
}

async function onPaste(e) {
  const dataUrl = await pasteImage.getImageDataUrl(e);
  if (dataUrl) {
    e.preventDefault();
    let src = dataUrl;
    try {
      // 图片落盘到笔记同目的 .assets 文件夹，避免 base64 胀胀文档；无法落盘时回落为内嵌
      const notePath = onGetNotePathCb ? onGetNotePathCb() : null;
      if (notePath && window.api && window.api.saveImage) {
        const rel = await window.api.saveImage(dataUrl, notePath);
        if (rel) src = rel;
      }
    } catch (err) {}
    document.execCommand('insertHTML', false, '<img src="' + src.replace(/"/g, '&quot;') + '" alt="图片" />');
    return; // input 事件会继续处理
  }
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (text) {
    e.preventDefault();
    document.execCommand('insertText', false, text);
  }
}

// ---------- 生命周期 ----------
function restoreEmptyBlocks(pane) {
  // 序列化时把空段落写成 `<!--  -->`，重开时 markdown-it 渲染成注释节点，这里还原为空段落
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) {
    const p = document.createElement('p');
    p.textContent = ZWSP;
    c.parentNode.replaceChild(p, c);
  }
  // 空 p / li / td 补 ZWSP，保证光标可定位
  const nodes = [];
  const ew = document.createTreeWalker(pane, NodeFilter.SHOW_ELEMENT);
  while (ew.nextNode()) nodes.push(ew.currentNode);
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if ((tag === 'p' || tag === 'div' || tag === 'li' || tag === 'td' || tag === 'th') &&
        !normText(el.textContent) && !el.querySelector('img, input, br')) {
      el.appendChild(document.createTextNode(ZWSP));
    }
  }
}

function init(handlers) {
  onChangeCb = handlers.onChange;
  onSaveCb = handlers.onSave;
  onGetNotePathCb = handlers.onGetNotePath || null;
  const pane = getPane();
  pane.addEventListener('input', onInput);
  pane.addEventListener('keydown', onKeyDown);
  pane.addEventListener('keyup', onKeyUp);
  pane.addEventListener('compositionstart', () => { composing = true; });
  pane.addEventListener('compositionend', () => {
    composing = false;
    const node = caretNode();
    const pre = node ? closestTag(node, 'pre') : null;
    if (pre) scheduleHighlight(pre);
    scheduleSerialize(100);
  });
  pane.addEventListener('blur', () => {
    tryCommitMarker();
    flush();
  });
  pane.addEventListener('click', onClick);
  pane.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      const paneEl = getPane();
      const kids = paneEl.children;
      const lastChild = kids.length ? kids[kids.length - 1] : paneEl.lastChild;
      if (lastChild) {
        const rng = document.createRange();
        rng.selectNodeContents(lastChild);
        const r = rng.getBoundingClientRect();
        const cs = getComputedStyle(kids.length ? lastChild : paneEl);
        const margin = parseFloat(cs.marginBottom) || 0;
        // 点击内容下方空白：直接把光标放置到文档末尾（Typora 尾部可编辑，回车不是唯一新建方式）
        if (e.clientY > r.bottom + margin) {
          e.preventDefault();
          const from = caretBlock();
          const p = ensureEndParagraph();
          placeCaretAtEnd(p);
          lastMarkerBlock = null;
          if (isMarkerLine(from)) convertMarkerBlock(from);
        }
      } else {
        // 空文档：点击任意位置创建并居中光标到末尾空段落
        const from = caretBlock();
        const p = ensureEndParagraph();
        placeCaretAtEnd(p);
        lastMarkerBlock = null;
        if (isMarkerLine(from)) convertMarkerBlock(from);
      }
    }
    const b = caretBlock();
    lastMarkerBlock = isMarkerLine(b) ? b : null;
  });
  pane.addEventListener('paste', onPaste);
  document.addEventListener('click', onDocClickForLangMenu, true);
}

function load(content) {
  // 打开即清洗：旧版本残留的 \u0001 / 其它控制符 / BOM / 孤立代理对不再显示到编辑区
  content = cleanMarkdown(content);
  doc.setDoc(content);
  dirty = false;
  undoStack.length = 0;
  redoStack.length = 0;
  clearTimeout(serializeTimer);
  const pane = getPane();
  pane.innerHTML = preview.render(content, { includeTitle: false }).html;
  stripWhitespaceTextNodes(pane);
  restoreEmptyBlocks(pane);
  for (const pre of pane.querySelectorAll('pre')) {
    ensureCodeToolbar(pre);
    ensureCodeLangPicker(pre);
    if (codeLinesEnabled) addCodeGutter(pre);
  }
  syncCodeGutters();
  pane.scrollTop = 0;
  placeCaretAtEnd(pane);
}

module.exports = { init, load, flush, cleanMarkdown, setCodeLines };
