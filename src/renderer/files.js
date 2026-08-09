const { getState, setState } = require('./state');
const { parseFrontmatter, setTagsInContent } = require('./frontmatter');
const doc = require('./doc');
const typora = require('./typora');
const search = require('./search');

let onRefreshCb = null;
let onOpenNoteCb = null;
let autosaveTimer = null;

const $ = (id) => document.getElementById(id);

function init(cb) {
  onRefreshCb = (cb && cb.onRefresh) || null;
  onOpenNoteCb = (cb && cb.onOpenNote) || null;
}

function callOpenNote(p) {
  if (onOpenNoteCb) return onOpenNoteCb(p);
  return openNote(p);
}

async function walk(dir, depth) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = await window.api.listDir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.isDir) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = await walk(entry.path, depth + 1);
      out.push(...sub);
    } else if (/\.(md|markdown|txt)$/i.test(entry.name)) {
      out.push(entry.path);
    }
  }
  return out;
}

async function refreshNotes() {
  const library = getState().library;
  if (!library) return;
  const paths = await walk(library, 0);
  paths.sort();
  const notes = [];
  for (const p of paths) {
    try {
      // 列表只读文件头部解析 frontmatter（标题/标签），正文在打开/搜索时才读取
      const head = typora.cleanMarkdown(await window.api.readFileHead(p, 8192));
      const fm = parseFrontmatter(head);
      notes.push({ path: p, name: p.split(/[\\/]/).pop(), title: fm.title, tags: fm.tags });
    } catch {
      // 跳过无法读取的文件
    }
  }
  setState({ notes });
  renderFileList();
  if (onRefreshCb) onRefreshCb();
}

function getNotes() { return getState().notes; }
function getLibrary() { return getState().library; }

async function setLibrary(dir) {
  await window.api.ensureDir(dir);
  setState({ library: dir });
  const config = { ...(getState().config || {}), library: dir };
  setState({ config });
  await window.api.saveConfig(config);
  const libNameEl = $('libName');
  if (libNameEl) libNameEl.textContent = dir.split(/[\\/]/).pop() || dir;
  $('statLib').textContent = dir;
  await refreshNotes();
}

async function openNote(path) {
  const content = typora.cleanMarkdown(await window.api.readFile(path));
  const fm = parseFrontmatter(content);
  const st = await window.api.stat(path);
  setState({ currentPath: path, currentContent: content, dirty: false, diskMtime: st ? st.mtimeMs : null });
  doc.setDoc(content);
  typora.load(content);
  search.cacheNote(path, content);
  $('fileName').textContent = path.split(/[\\/]/).pop();
  updateSaveState();
  updateWordCount(content);
  renderTagBar();
  renderFileList();
}

function onDocChanged(content) {
  setState({ dirty: true });
  updateSaveState();
  updateWordCount(content);
  scheduleAutosave(content);
  const st = getState();
  if (st.currentPath) {
    const note = st.notes.find(n => n.path === st.currentPath);
    if (note) {
      const fm = parseFrontmatter(content);
      note.tags = fm.tags;
      note.title = fm.title;
    }
    search.cacheNote(st.currentPath, content);
  }
}

function scheduleAutosave(content) {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (getState().currentPath && getState().dirty) saveCurrent();
  }, 800);
}

async function saveCurrent() {
  const st = getState();
  if (!st.currentPath) return;
  typora.flush();
  const cleaned = typora.cleanMarkdown(doc.getDoc());
  // 外部修改检测：打开后文件被其他程序改动过，覆盖前先备份盘面版本
  const statNow = await window.api.stat(st.currentPath);
  if (statNow && st.diskMtime != null && Math.abs(statNow.mtimeMs - st.diskMtime) > 1) {
    const bak = await window.api.backupExternal(st.currentPath);
    if (bak) updateSaveState('\u2713 \u5df2保存（检测到外部修改，已备份原文件）');
  }
  await window.api.writeFile(st.currentPath, cleaned);
  const statAfter = await window.api.stat(st.currentPath);
  setState({ dirty: false, currentContent: cleaned, diskMtime: statAfter ? statAfter.mtimeMs : (statNow ? statNow.mtimeMs : null) });
  updateSaveState();
}

async function newNote() {
  const p = await window.api.saveFileDialog('新笔记.md');
  if (!p) return;
  const template = '---\ntitle: 新笔记\ntags: []\n---\n\n# 新笔记\n\n在这里开始写作…\n';
  await window.api.writeFile(p, template);
  await refreshNotes();
  await callOpenNote(p);
}

async function openViaDialog() {
  const p = await window.api.openFileDialog();
  if (!p) return;
  setState({ currentPath: p });
  await callOpenNote(p);
}

function updateSaveState(message) {
  const el = $('statSave');
  if (getState().dirty && !message) {
    el.textContent = '● 未保存';
    el.className = 'save-state dirty';
  } else {
    el.textContent = message || '✓ 已保存';
    el.className = 'save-state';
  }
}

function updateWordCount(content) {
  const cleaned = typora.cleanMarkdown(content);
  $('statWords').textContent = cleaned.replace(/\s+/g, '').length + ' 字';
}

function renderFileList() {
  const list = $('fileList');
  const filter = getState().tagFilter;
  let items = getState().notes;
  if (filter) items = items.filter(n => (n.tags || []).includes(filter));
  list.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = filter ? '没有带该标签的笔记' : '笔记库为空';
    list.appendChild(empty);
    return;
  }
  for (const n of items) {
    const item = document.createElement('div');
    item.className = 'file-item' + (n.path === getState().currentPath ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'file-title';
    title.textContent = n.title || n.name.replace(/\.(md|markdown|txt)$/i, '');
    item.appendChild(title);
    if (n.tags && n.tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'file-tags';
      tagRow.textContent = n.tags.map(t => '#' + t).join(' ');
      item.appendChild(tagRow);
    }
    item.onclick = () => callOpenNote(n.path);
    list.appendChild(item);
  }
}

function renderTagBar() {
  const bar = $('tagBar');
  bar.innerHTML = '';
  const current = getState().notes.find(n => n.path === getState().currentPath);
  const tags = current ? current.tags : [];
  const filter = getState().tagFilter;
  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (filter === tag ? ' active' : '');
    chip.textContent = tag;
    chip.title = '点击按标签过滤';
    chip.onclick = () => toggleTagFilter(tag);
    const del = document.createElement('span');
    del.className = 'tag-del';
    del.textContent = '✕';
    del.title = '移除标签';
    del.onclick = (e) => { e.stopPropagation(); removeTag(tag); };
    chip.appendChild(del);
    bar.appendChild(chip);
  }
  const add = document.createElement('span');
  add.className = 'tag-chip add';
  add.textContent = '＋ 标签';
  add.onclick = startAddTag;
  bar.appendChild(add);
}

function toggleTagFilter(tag) {
  const cur = getState().tagFilter;
  setState({ tagFilter: cur === tag ? null : tag });
  renderTagBar();
  renderFileList();
}

function startAddTag() {
  const bar = $('tagBar');
  const input = document.createElement('input');
  input.className = 'tag-input';
  input.placeholder = '标签名，回车确认';
  bar.appendChild(input);
  input.focus();
  const finish = () => {
    const value = input.value.trim();
    if (value) addTag(value);
    renderTagBar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); finish(); }
    if (e.key === 'Escape') renderTagBar();
  });
  input.addEventListener('blur', finish);
}

function addTag(tag) {
  if (!getState().currentPath) return;
  const md = setTagsInContent(doc.getDoc(), [tag]);
  doc.setDoc(md);
  typora.load(md);
  onDocChanged(md);
  renderTagBar();
}

function removeTag(tag) {
  if (!getState().currentPath) return;
  const fm = parseFrontmatter(doc.getDoc());
  const tags = (fm.tags || []).filter(t => t !== tag);
  const md = setTagsInContent(doc.getDoc(), tags);
  doc.setDoc(md);
  typora.load(md);
  onDocChanged(md);
  renderTagBar();
}

module.exports = {
  init, setLibrary, getLibrary, getNotes, refreshNotes,
  openNote, openViaDialog, newNote, saveCurrent, onDocChanged
};