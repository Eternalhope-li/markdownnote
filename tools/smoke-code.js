// 运行于渲染进程的冒烟测试（--smoke 模式）。String.raw 模板字符串保证 \u200b 等转义原样传给执行环境。
module.exports = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (n) => console.log("[smoke] step " + n);
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (document.querySelectorAll('.file-item').length > 0) break;
    await sleep(200);
  }
  const pane = document.getElementById('editorPane');
  const out = { hasPane: !!pane, hasApi: !!window.api, notes: document.querySelectorAll('.file-item').length };
  if (!pane) return out;
  const lib = (await window.api.readConfig()).library || (await window.api.getAppInfo()).defaultLibrary;
  const notePath = (window.__test && window.__test.currentPath && window.__test.currentPath()) || (lib + '/' + document.getElementById('fileName').textContent);
  let origContent = null;
  try { origContent = await window.api.readFile(notePath); } catch (e) {}
  const reset = async () => {
    if (origContent !== null) {
      await window.api.writeFile(notePath, origContent);
      if (window.__test && window.__test.openNote) await window.__test.openNote(notePath);
    }
  };
  const caretEnd = () => {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(pane);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const type = async (text, wait) => {
    pane.focus();
    document.execCommand('insertText', false, text);
    pane.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(wait == null ? 60 : wait);
  };
  const enter = async () => {
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(60);
  };
  const arrow = async (key) => {
    pane.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    await sleep(60);
  };
  const backspace = async () => {
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    await sleep(60);
  };
  const typeKey = async (key) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    if (pane.dispatchEvent(ev)) document.execCommand('insertText', false, key);
    pane.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
  };
  const fresh = () => {
    pane.focus();
    pane.innerHTML = '';
    caretEnd();
  };
  // 模拟“光标离开本块”（方向键移出本行）：keydown 时记录标记行，随后把光标移到下一块，keyup 触发提交
  const commitLeave = async () => {
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const np = document.createElement('p');
    np.textContent = '\u200b';
    pane.appendChild(np);
    const s = window.getSelection();
    const r = document.createRange();
    r.setStart(np.firstChild, 1);
    r.collapse(true);
    s.removeAllRanges();
    s.addRange(r);
    pane.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await sleep(80);
  };
  const save = async () => { if (window.__test && window.__test.save) await window.__test.save(); await sleep(200); };
  const read = async () => { try { return await window.api.readFile(notePath); } catch (e) { return ''; } };
  const plain = () => (pane.textContent || '').replace(/\u200b/g, '');
  const hText = () => ((pane.querySelector('h1') || {}).textContent || '').replace(/\u200b/g, '');
  const liText = () => ((pane.querySelector('li') || {}).textContent || '').replace(/\u200b/g, '');
  const paneText = () => plain();
  const selOffset = () => {
    const s = window.getSelection();
    if (!s.rangeCount) return -1;
    const r = s.getRangeAt(0);
    const pre = r.cloneRange();
    pre.selectNodeContents(pane);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  };
  const ctrlOf = (s) => { const m = []; for (const ch of (s || '')) { const c = ch.codePointAt(0); if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) m.push(c.toString(16)); } return m.join(','); };
  const pending = (t) => !!pane.querySelector('[data-md-pending="' + t + '"]');

  try {
    // 1) 块级两段式（WYSIWYG）：输入 "#" 不转换；空格后进入编辑预览（井号虚化、文字仅加粗）；
    //    光标仍在行内不渲染，移出本行才正式渲染为标题/列表/引用
    fresh(); await type('#'); out.h1Pending = !pane.querySelector('h1');
    await type(' ');
    out.h1Space = !pane.querySelector('h1') && pending('h1');
    await type('\u4e00\u7ea7\u6807\u9898');
    out.h1Text = plain().indexOf('# \u4e00\u7ea7\u6807\u9898') !== -1 && !pane.querySelector('h1');
    await commitLeave();
    out.h1Commit = !!pane.querySelector('h1') && hText() === '\u4e00\u7ea7\u6807\u9898';
    fresh(); await type('## '); out.h2Marker = pending('h2');
    fresh(); await type('- '); out.ulMarker = pending('ul');
    await type('\u5217\u8868\u9879'); out.ulText = plain().indexOf('\u5217\u8868\u9879') !== -1;
    await commitLeave(); out.ulCommit = !!pane.querySelector('ul li') && liText() === '\u5217\u8868\u9879';
    fresh(); await type('1. '); out.olMarker = pending('ol');
    fresh(); await type('> '); out.quoteMarker = pending('quote');
    fresh(); await type('- [ ] '); out.taskMarker = pending('task');
    await type('\u5f85\u529e'); out.taskText = plain().indexOf('\u5f85\u529e') !== -1;
    await commitLeave(); out.taskCommit = !!pane.querySelector('input[type=checkbox]') && !pane.querySelector('input[type=checkbox]').checked;

    // 2) 行内语法：闭合即即时完整渲染（与块级两段式不同）
    fresh(); await type('**\u52a0\u7c97**'); out.boldInline = !!pane.querySelector('strong');
    fresh(); await type('*\u659c\u4f53*'); out.italicInline = !!pane.querySelector('em');
    fresh(); await type('~~\u5220\u9664~~'); out.strikeInline = !!(pane.querySelector('del') || pane.querySelector('s'));
    fresh(); await type('\`\u5185\u8054\`'); out.codeInline = !!pane.querySelector('code');
    fresh(); await type('[\u94fe\u63a5](https://example.com)'); out.linkInline = !!pane.querySelector('a[href="https://example.com"]');
    fresh(); await type('![\u56fe](https://example.com/a.png)'); out.imageInline = !!pane.querySelector('img[src="https://example.com/a.png"]');

    // 3) 回车：提交并换行；代码围栏 / 分割线 / 表格回车触发
    fresh(); await type('#'); await enter(); out.h1Enter = !!pane.querySelector('h1');
    fresh(); await type('# \u6807\u9898\u6587\u672c');
    out.h1ContentPending = !pane.querySelector('h1') && pending('h1');
    await enter(); out.h1ContentEnter = !!pane.querySelector('h1') && hText() === '\u6807\u9898\u6587\u672c';
    fresh(); await type('- \u5217\u8868\u5185\u5bb9'); await enter();
    out.liContentEnter = !!pane.querySelector('li') && liText() === '\u5217\u8868\u5185\u5bb9';
    fresh(); await type('# \u6807\u9898\u6587\u672c'); await enter();
    out.h1ContentNewline = !!pane.querySelector('h1') && hText() === '\u6807\u9898\u6587\u672c' && pane.querySelectorAll('p').length === 1;
    fresh(); await type('- \u5217\u8868\u5185\u5bb9'); await enter();
    out.liContentNewline = pane.querySelectorAll('li').length === 2 && liText() === '\u5217\u8868\u5185\u5bb9';
    fresh(); await type('> \u5f15\u7528'); await enter();
    out.quoteContentNewline = pane.querySelectorAll('blockquote p').length === 2;
    // 光标位置变动：仍在行内 → 保持预览；移出本行 → 提交
    fresh(); await type('#'); await arrow('ArrowRight');
    out.hashArrowStay = !pane.querySelector('h1');
    fresh(); await type('# \u6807\u9898\u6587\u672c'); await arrow('ArrowRight');
    out.contentArrowStay = !pane.querySelector('h1') && pending('h1');
    fresh(); await type('# \u6807\u9898\u6587\u672c'); await commitLeave();
    out.contentLeaveCommit = !!pane.querySelector('h1') && hText() === '\u6807\u9898\u6587\u672c';
    fresh(); await type('\`\`\`js'); await enter();
    out.fenceEnter = !!pane.querySelector('pre code.language-js');
    fresh(); await type('\`\`\`'); await enter();
    out.fenceEnterNoLang = !!pane.querySelector('pre code') && !pane.querySelector('code.language-');
    fresh(); await type('---'); await enter(); out.hrEnter = !!pane.querySelector('hr');
    fresh(); await type('| \u52171 | \u52172 |'); await enter();
    const tbl = pane.querySelector('table');
    out.tableEnter = !!tbl && !!tbl.querySelector('thead th') && !!tbl.querySelector('tbody tr');
    await enter();
    out.tableExit = !pane.querySelector('table') && !!pane.querySelector('p');
    fresh(); await type('---'); await enter();
    await backspace();
    out.hrUndo = !pane.querySelector('hr') && (pane.textContent || '').indexOf('---') !== -1;

    // 4) 悬停标记退格：标记失效还原为普通文本
    fresh(); await type('# ');
    out.emptyHeading = pending('h1');
    await backspace();
    out.headingUndo = !pane.querySelector('[data-md-pending]') && plain() === '#';

    // 5) 回车行为：列表拆项 / 空项退出 / 引用 / 标题拆分
    fresh(); await type('- '); await type('a'); await enter();
    out.listSplit = pane.querySelectorAll('li').length === 2;
    await enter(); out.listExit = !!pane.querySelector('p') && pane.querySelectorAll('li').length === 1;
    fresh(); await type('> '); await type('q'); await enter();
    out.quoteNewline = pane.querySelectorAll('blockquote p').length === 2;
    await enter(); out.quoteExit = pane.querySelectorAll('blockquote p').length === 1 && pane.querySelectorAll('p').length === 2;
    fresh(); await type('# '); await type('t'); await enter();
    out.headingSplit = !!pane.querySelector('h1') && !!pane.querySelector('p');

    // 6) 空列表项：回车退出列表
    fresh(); await type('- ');
    await enter();
    out.enterEmptyLi = pane.querySelectorAll('li').length === 1;
    await enter();
    out.exitEmptyLi = pane.querySelectorAll('li').length === 0 && !!pane.querySelector('p');
    await backspace();
    out.backspaceEmptyLi = pane.querySelectorAll('li').length === 0 && !!pane.querySelector('p');

    // 7) Ctrl 快捷 / 行首标记转换已有内容
    fresh(); await type('\u65e2\u6709\u5185\u5bb9');
    const lsr = document.createRange();
    lsr.setStart(pane.firstChild, 0);
    lsr.collapse(true);
    const lss = window.getSelection();
    lss.removeAllRanges();
    lss.addRange(lsr);
    await type('# ');
    out.lineStartHeading = pending('h1') && plain().indexOf('\u65e2\u6709\u5185\u5bb9') !== -1;
    await commitLeave();
    out.lineStartHeadingCommit = !!pane.querySelector('h1') && hText() === '\u65e2\u6709\u5185\u5bb9';
    fresh(); await type('\u6bb5\u843d\u6587\u5b57');
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(80);
    out.ctrl1 = !!pane.querySelector('h1') && hText() === '\u6bb5\u843d\u6587\u5b57';
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(80);
    out.ctrl0 = !pane.querySelector('h1') && !!pane.querySelector('p');
    fresh(); await type('\u52a0\u7c97');
    const bsr = document.createRange();
    bsr.selectNodeContents(pane);
    const bss = window.getSelection();
    bss.removeAllRanges();
    bss.addRange(bsr);
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(80);
    out.ctrlB = !!(pane.querySelector('strong') || pane.querySelector('b'));
    fresh(); await type('- [x] ');
    out.taskChecked = pending('task');
    await commitLeave();
    out.taskCheckedCommit = !!pane.querySelector('input[type=checkbox]') && pane.querySelector('input[type=checkbox]').checked;

    // 7b) 退格降级：非空列表项行首退格 -> 段落；引用首块行首退格 -> 退出引用
    fresh(); await type('- '); await type('\u5217\u8868\u6587\u5b57'); await commitLeave();
    const liFirstTxt = pane.querySelector('li').firstChild;
    const liR2 = document.createRange();
    liR2.setStart(liFirstTxt, 0); liR2.collapse(true);
    const liSel2 = window.getSelection();
    liSel2.removeAllRanges(); liSel2.addRange(liR2);
    await backspace();
    out.backspaceStartLi = !pane.querySelector('ul') && !!pane.querySelector('p') &&
      (pane.querySelector('p').textContent || '').replace(/\u200b/g, '') === '\u5217\u8868\u6587\u5b57';
    fresh(); await type('> '); await type('\u5f15\u7528\u6587\u5b57'); await commitLeave();
    const bqFirstTxt = pane.querySelector('blockquote p').firstChild;
    const bqR2 = document.createRange();
    bqR2.setStart(bqFirstTxt, 0); bqR2.collapse(true);
    const bqSel2 = window.getSelection();
    bqSel2.removeAllRanges(); bqSel2.addRange(bqR2);
    await backspace();
    out.backspaceStartQuote = !pane.querySelector('blockquote') && !!pane.querySelector('p') &&
      (pane.querySelector('p').textContent || '').replace(/\u200b/g, '') === '\u5f15\u7528\u6587\u5b57';
    fresh(); await type('***\u7c97\u659c***');
    out.boldItalicInline = !!pane.querySelector('strong em');
    fresh(); await type('__\u52a0\u7c97__');
    out.underscoreBold = !!pane.querySelector('strong');
    fresh(); await type('_\u659c\u4f53_');
    out.underscoreItalic = !!pane.querySelector('em');

    // 7c) Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z：转换类操作快照撤销/重做
    const ctrlKey = (key, opts) => pane.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, ctrlKey: true, bubbles: true, cancelable: true }, opts || {})));
    fresh(); await typeKey('#'); await typeKey(' ');
    out.undoH1Before = pending('h1');
    ctrlKey('z'); await sleep(80);
    out.undoH1 = !pane.querySelector('[data-md-pending]') && plain() === '#';
    ctrlKey('y'); await sleep(80);
    out.redoH1 = pending('h1');
    ctrlKey('z'); await sleep(80);
    ctrlKey('z', { shiftKey: true }); await sleep(80);
    out.redoShiftZ = pending('h1');
    fresh(); await type('**\u52a0\u7c97**');
    out.undoBoldBefore = !!pane.querySelector('strong');
    ctrlKey('z'); await sleep(80);
    out.undoBold = !pane.querySelector('strong') && plain().indexOf('**\u52a0\u7c97**') !== -1;
    fresh(); await type('- '); await type('\u5217\u8868\u6587\u5b57'); await commitLeave();
    const liT3 = pane.querySelector('li').firstChild;
    const liR3 = document.createRange();
    liR3.setStart(liT3, 0); liR3.collapse(true);
    const liS3 = window.getSelection();
    liS3.removeAllRanges(); liS3.addRange(liR3);
    await backspace();
    out.demoteDone = !pane.querySelector('ul');
    ctrlKey('z'); await sleep(80);
    out.undoDemote = !!pane.querySelector('ul li');

    // 7d) 自动配对括号：() [] {} "" '' \`\`；闭括号跳过；退格一次删配对
    fresh(); await typeKey('(');
    out.autoPairParen = paneText() === '()' && selOffset() === 1;
    await typeKey('[');
    out.autoPairBracket = paneText() === '([])';
    await typeKey(']');
    out.autoPairSkip = paneText() === '([])' && selOffset() === 3;
    fresh(); await typeKey('"');
    out.autoPairQuote = paneText() === '""' && selOffset() === 1;
    fresh(); await typeKey('['); await type('\u94fe\u63a5'); await typeKey(']'); await typeKey('('); await type('https://example.com'); await typeKey(')');
    out.autoPairLink = !!pane.querySelector('a[href="https://example.com"]');
    fresh(); await typeKey('\`'); await type('\u4ee3\u7801'); await typeKey('\`');
    out.autoPairCode = !!pane.querySelector('code');
    fresh(); await typeKey('(');
    out.backspacePairBefore = paneText() === '()';
    await backspace();
    out.backspacePair = paneText() === '';

    // 7e) 逐字输入 "- [ ] "：悬停升级为待办，移出本行提交为勾选框
    fresh(); await type('- '); await typeKey('['); await typeKey(' '); await typeKey(']'); await type(' ');
    out.taskTyping = pending('task') && !pane.querySelector('input[type=checkbox]');
    await type('\u5f85\u529e\u6d4b\u8bd5'); await commitLeave();
    out.taskTypingCommit = !!pane.querySelector('input[type=checkbox]') && !pane.querySelector('input[type=checkbox]').checked && liText() === '\u5f85\u529e\u6d4b\u8bd5';
    fresh(); await type('- '); await typeKey('['); await type('x'); await typeKey(']'); await type(' ');
    await type('\u5b8c\u6210\u9879'); await commitLeave();
    out.taskTypingChecked = !!pane.querySelector('input[type=checkbox]') && pane.querySelector('input[type=checkbox]').checked;

    // 7f) 行首标记在已提交的列表 / 标题 / 引用内立即改变块类型
    fresh(); await type('- '); await type('\u5217\u8868\u5185\u5bb9'); await commitLeave();
    const liT = pane.querySelector('li').firstChild;
    const liR = document.createRange(); liR.setStart(liT, 0); liR.collapse(true);
    const liS = window.getSelection(); liS.removeAllRanges(); liS.addRange(liR);
    await typeKey('#'); await typeKey(' ');
out.hashInLi = !!pane.querySelector('h1') && hText() === '\u5217\u8868\u5185\u5bb9' && !pane.querySelector('ul');out.hashInLi = !!pane.querySelector('h1') && hText() === '\u5217\u8868\u5185\u5bb9' && !pane.querySelector('ul');
    fresh(); await type('# '); await type('\u6807\u9898'); await commitLeave();
    const hT = pane.querySelector('h1').firstChild;
    const hR = document.createRange(); hR.setStart(hT, 0); hR.collapse(true);
    const hS = window.getSelection(); hS.removeAllRanges(); hS.addRange(hR);
    await typeKey('-'); await typeKey(' ');
    out.dashInHeading = !!pane.querySelector('ul li') && liText() === '\u6807\u9898' && !pane.querySelector('h1');
    fresh(); await type('- '); await type('\u5916\u5c42'); await commitLeave();
    const oT = pane.querySelector('li').firstChild;
    const oR = document.createRange(); oR.setStart(oT, 0); oR.collapse(true);
    const oS = window.getSelection(); oS.removeAllRanges(); oS.addRange(oR);
    await typeKey('-'); await typeKey(' ');
    out.nestedLi = !!pane.querySelector('li > ul > li');
    fresh(); await type('> '); await type('\u5f15\u7528\u6587\u5b57'); await commitLeave();
    const bT = pane.querySelector('blockquote p').firstChild;
    const bR = document.createRange(); bR.setStart(bT, 0); bR.collapse(true);
    const bS = window.getSelection(); bS.removeAllRanges(); bS.addRange(bR);
    await typeKey('#'); await typeKey(' ');
    out.hashInQuote = !!pane.querySelector('h1') && hText() === '\u5f15\u7528\u6587\u5b57' && !pane.querySelector('blockquote');

    // 8) 往返：逐键输入 -> 保存 -> 磁盘 markdown 正确
    fresh();
    await type('# '); await type('\u8fd4\u8fd4\u6807\u9898'); await enter();
    await type('- '); await type('\u5217\u8868\u4e00'); await enter(); await enter();
    await type('- [ ] '); await type('\u5f85\u529e\u4efb\u52a1'); await enter(); await enter();
    await type('> '); await type('\u5f15\u7528'); await enter(); await enter();
    await type('---'); await enter();
    await type('**\u52a0\u7c97**'); await type(' *\u659c\u4f53*'); await type(' ~~\u5220\u9664~~'); await type(' [\u94fe\u63a5](https://example.com)');
    out.noCtrlAfterOps = ctrlOf(pane.textContent) === '';
    await save();
    const saved = await read();
    out.savedCtrlClean = ctrlOf(saved) === '';
    out.roundTrip =
      saved.includes('# \u8fd4\u8fd4\u6807\u9898') &&
      saved.includes('- \u5217\u8868\u4e00') &&
      saved.includes('- [ ] \u5f85\u529e\u4efb\u52a1') &&
      saved.includes('> \u5f15\u7528') &&
      saved.includes('**\u52a0\u7c97**') &&
      saved.includes('*\u659c\u4f53*') &&
      saved.includes('~~\u5220\u9664~~') &&
      saved.includes('[\u94fe\u63a5](https://example.com)') &&
      saved.includes('---');

    // 9) 空段落往返：相邻列表间保留独立段落，重开不合并
    out.emptyMd = (saved.match(/\n<!--  -->\n/g) || []).length;
    if (window.__test && window.__test.openNote) await window.__test.openNote(notePath);
    await sleep(300);
    const uls = pane.querySelectorAll('ul');
    out.emptyRoundtrip = uls.length === 2;
    out.blocksAfterReload = Array.from(pane.children).map((c) => c.tagName).join(',');

    // 10) 性能：1500 段大文档，击键不触发全量渲染
    const big = [];
    for (let i = 0; i < 1500; i++) big.push('<p>\u7b2c ' + i + ' \u6bb5\uff0c\u6253\u5b57\u6d4b\u8bd5\u5185\u5bb9\uff0c\u4e2d\u6587\u5185\u5bb9\uff0c\u591a\u4e00\u4e9b\u6587\u5b57\u3002</p>');
    pane.innerHTML = big.join('');
    caretEnd();
    const t1 = performance.now();
    await type('\u6027\u80fd\u6d4b\u8bd5', 0);
    out.perfInputMs = Math.round((performance.now() - t1) * 10) / 10;
    const t2 = performance.now();
    await save();
    out.perfSaveMs = Math.round((performance.now() - t2) * 10) / 10;
    const bigSaved = await read();
    out.perfDocSize = bigSaved.length;

    // 11) 旧文件防御：含 \u0001 / 控制符 / BOM 的文件打开后必须干净
    await window.api.writeFile(notePath, '\ufeff# \u6807\u9898\u0001\u001f\u007f\n\n\u0001\n\n\u6b63\u5e38\u6bb5\u843d \u0001 \u5185\u5bb9\n');
    if (window.__test && window.__test.openNote) await window.__test.openNote(notePath);
    await sleep(300);
    out.dirtyLoadCtrl = ctrlOf(pane.textContent);
    out.dirtyLoadNoFFFD = (pane.textContent || '').indexOf('\ufffd') === -1;
    out.dirtyLoadHeading = !!pane.querySelector('h1');
    // 12) Ctrl+Shift+C：复制为 Markdown（真实剪贴板路径）
    try { if (navigator.clipboard) await navigator.clipboard.writeText('__sentinel__'); } catch (e) {}
    fresh();
    await type('**bold** and \`code\`', 80);
    const sel12 = window.getSelection();
    const r12 = document.createRange();
    r12.selectNodeContents(pane);
    sel12.removeAllRanges();
    sel12.addRange(r12);
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(180);
    try {
      out.copyAsMd = navigator.clipboard ? await navigator.clipboard.readText() : '(unavailable)';
    } catch (e) { out.copyAsMd = '(read failed)'; }
    // 13) Ctrl+Shift+V：粘贴为 Markdown（富文本来源先转回 Markdown 再渲染）
    fresh();
    await window.api.writeClipboard('', '<p>Hello <strong>bold</strong> world</p>');
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    out.pasteAsMdStrong = !!pane.querySelector('strong');
    out.pasteAsMdText = pane.textContent;
    // 14) 真实粘贴场景：Word/网页样式 span、下划线、真实 Ctrl+V → 保存后是对应的 Markdown
    fresh();
    await window.api.writeClipboard('Hello bold world', '<p>Hello <span style="font-weight:bold">bold</span> world</p>');
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    await save();
    out.pasteWordMd = (await read()).includes('**bold**');
    fresh();
    await window.api.writeClipboard('under', '<p>Hello <u>under</u> line</p>');
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(300);
    await save();
    out.pasteUnderlineMd = (await read()).includes('<u>under</u>');
    fresh();
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>Web <strong>strong</strong> text</p>');
    dt.setData('text/plain', 'Web strong text');
    pane.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(300);
    out.pasteCtrVStrong = !!pane.querySelector('strong');
    await save();
    out.pasteCtrVMd = (await read()).includes('**strong**');
    // 15) 图片缩放：点击选中 → 右下角手柄拖拽 → 保存为 <img width>，重开保留
    fresh();
    const imgTest = document.createElement('img');
    imgTest.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    imgTest.alt = 'pic';
    imgTest.style.width = '100px';
    const pBlock = document.createElement('p');
    pBlock.appendChild(imgTest);
    pane.appendChild(pBlock);
    // 点击图片 → 仅选中（不缩放）
    imgTest.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await sleep(120);
    out.imgSelectedClass = imgTest.classList.contains('img-selected');
    const handles = Array.from(document.querySelectorAll('.img-resize-handle'));
    out.imgHandleCount = handles.length;
    out.imgHandleDirs = handles.map((h) => h.dataset.dir).sort().join(',');
    out.imgHandleShownAll = handles.length === 8 && handles.every((h) => h.style.display === 'block');
    const seHandle = handles.find((h) => h.dataset.dir === 'se');
    const r = imgTest.getBoundingClientRect();
    // 拖动 se 手柄 → 缩放（保持宽高比）
    if (seHandle) {
      seHandle.dispatchEvent(new MouseEvent('mousedown', { clientX: r.right, clientY: r.bottom, bubbles: true, cancelable: true, button: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: r.right + 100, clientY: r.bottom + 100, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    }
    await sleep(250);
    await save();
    const mdImg = await read();
    out.mdImgFull = mdImg;
    out.imgSizeMd = mdImg.includes('<img') && mdImg.includes('width="');
    const mw = /width="(\d+)"/.exec(mdImg);
    out.imgWidthValue = mw ? mw[1] : '(none)';
    // 重开笔记：Markdown 里的 <img width> 应原样渲染回编辑区
    if (window.__test && window.__test.openNote) await window.__test.openNote(notePath);
    await sleep(300);
    out.imgReloadWidth = !!pane.querySelector('img[width]');
    out.imgReloadPane = pane.innerHTML.slice(0, 400);
  } finally {
    await reset();
  }
  return out;
})()`;

