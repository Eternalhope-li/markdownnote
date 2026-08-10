const { getState, setState } = require('./state');
const { parseFrontmatter, setTagsInContent } = require('./frontmatter');
const doc = require('./doc');
const editor = require('./editor');
const search = require('./search');

let onRefreshCb = null;
let onOpenNoteCb = null;
let autosaveTimer = null;

const $ = (id) => document.getElementById(id);
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

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
  const paths = [];
  if (library) paths.push(...await walk(library, 0));
  for (const p of (getState().externalNotes || [])) {
    if (p && !paths.includes(p)) paths.push(p);
  }
  paths.sort();
  const notes = [];
  for (const p of paths) {
    try {
      const head = editor.cleanMarkdown(await window.api.readFileHead(p, 8192));
      const fm = parseFrontmatter(head);
      notes.push({ path: p, name: baseName(p), title: fm.title, tags: fm.tags });
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

function isInsideLibrary(p) {
  const lib = getState().library;
  if (!lib || !p) return false;
  const libNorm = lib.replace(/[\\/]+$/, '');
  const pNorm = p.replace(/[\\/]+$/, '');
  return pNorm === libNorm || pNorm.startsWith(libNorm + '\\') || pNorm.startsWith(libNorm + '/');
}

async function addExternalNote(p) {
  const list = (getState().externalNotes || []).slice();
  if (!list.includes(p)) list.push(p);
  setState({ externalNotes: list });
  const config = { ...(getState().config || {}), externalNotes: list };
  setState({ config });
  await window.api.saveConfig(config);
}

async function setLibrary(dir) {
  await window.api.ensureDir(dir);
  setState({ library: dir });
  const config = { ...(getState().config || {}), library: dir };
  setState({ config });
  await window.api.saveConfig(config);
  const libNameEl = $('libName');
  if (libNameEl) libNameEl.textContent = dir.split(/[\\/]/).pop() || dir;
  $('statLib').textContent = dir;
  try { await window.api.watchDir(dir); } catch (err) {}
  await refreshNotes();
}

// ---------- 多标签 ----------
function addTab(path) {
  const tabs = (getState().openTabs || []).slice();
  if (!tabs.includes(path)) tabs.push(path);
  setState({ openTabs: tabs });
  const dirtyTabs = { ...(getState().dirtyTabs || {}) };
  if (dirtyTabs[path] == null) dirtyTabs[path] = false;
  setState({ dirtyTabs });
  renderTabs();
}

function removeTab(path) {
  setState({ openTabs: (getState().openTabs || []).filter((p) => p !== path) });
  const dirtyTabs = { ...(getState().dirtyTabs || {}) };
  delete dirtyTabs[path];
  setState({ dirtyTabs });
  renderTabs();
}

function isDirtyTab(path) {
  return !!(getState().dirtyTabs || {})[path];
}

function renderTabs() {
  const bar = $('tabBar');
  if (!bar) return;
  const tabs = getState().openTabs || [];
  bar.innerHTML = '';
  if (!tabs.length) { bar.hidden = true; return; }
  bar.hidden = false;
  for (const p of tabs) {
    const isActive = p === getState().currentPath;
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (isActive ? ' active' : '');
    tab.title = p;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = baseName(p).replace(/\.(md|markdown|txt)$/i, '');
    const dot = document.createElement('span');
    dot.className = 'tab-dirty';
    dot.style.display = isDirtyTab(p) ? '' : 'none';
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签';
    close.onclick = (e) => { e.stopPropagation(); closeTab(p); };
    tab.appendChild(label);
    tab.appendChild(dot);
    tab.appendChild(close);
    tab.onclick = () => { if (!isActive) switchTab(p); };
    bar.appendChild(tab);
  }
}

// ---------- 最近文件 ----------
async function addRecent(path) {
  const config = { ...(getState().config || {}) };
  const recent = (config.recent || []).filter((p) => p !== path);
  recent.unshift(path);
  config.recent = recent.slice(0, 10);
  config.lastNote = path;
  setState({ config, recent: config.recent.slice(0, 6) });
  await window.api.saveConfig(config);
  renderRecent();
}

async function removeRecent(path) {
  const config = { ...(getState().config || {}) };
  config.recent = (config.recent || []).filter((p) => p !== path);
  setState({ config, recent: config.recent.slice(0, 6) });
  await window.api.saveConfig(config);
  renderRecent();
}

function renderRecent() {
  const panel = $('recentPanel');
  if (!panel) return;
  const recent = getState().recent || [];
  if (!recent.length) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="side-panel-title">最近<span class="recent-clear" title="清空最近列表">清空</span></div>';
  const clearBtn = panel.querySelector('.recent-clear');
  clearBtn.onclick = async () => {
    const config = { ...(getState().config || {}) };
    config.recent = [];
    setState({ config, recent: [] });
    await window.api.saveConfig(config);
    renderRecent();
  };
  for (const p of recent) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    row.title = p;
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = baseName(p).replace(/\.(md|markdown|txt)$/i, '');
    const del = document.createElement('span');
    del.className = 'recent-del';
    del.textContent = '×';
    del.onclick = (e) => { e.stopPropagation(); removeRecent(p); };
    row.appendChild(name);
    row.appendChild(del);
    row.onclick = () => callOpenNote(p);
    panel.appendChild(row);
  }
}

// ---------- 打开 / 保存 ----------
async function openNote(path) {
  let content;
  try {
    content = editor.cleanMarkdown(await window.api.readFile(path));
  } catch (err) {
    showToast('无法打开文件：' + baseName(path));
    removeTab(path);
    return;
  }
  const fm = parseFrontmatter(content);
  const st = await window.api.stat(path);
  setState({ currentPath: path, currentContent: content, dirty: false, diskMtime: st ? st.mtimeMs : null });
  doc.setDoc(content);
  editor.load(content);
  search.cacheNote(path, content);
  addTab(path);
  addRecent(path);
  $('fileName').textContent = baseName(path);
  updateSaveState();
  updateWordCount(content);
  renderTagBar();
  renderFileList();
  renderTabs();
  renderRecent();
  try { await window.api.watchFile(path); } catch (err) {}
}

async function switchTab(path) {
  if (path === getState().currentPath) return;
  // 切换前先保存当前标签的未落盘修改
  if (getState().dirty) await saveCurrent();
  await openNote(path);
}

async function closeTab(path) {
  const tabs = (getState().openTabs || []).slice();
  const idx = tabs.indexOf(path);
  if (idx < 0) return;
  const isActive = path === getState().currentPath;
  if (isActive && getState().dirty) {
    const r = await window.api.confirmDialog({
      type: 'question',
      title: '保存更改',
      message: '「' + baseName(path) + '」有未保存的更改',
      detail: '保存后关闭，还是放弃这些更改？',
      buttons: ['取消', '放弃更改', '保存'],
      defaultId: 2,
      cancelId: 0
    });
    if (!r || r.response === 0) return;
    if (r.response === 2) await saveCurrent();
  }
  removeTab(path);
  try { await window.api.unwatchFile(path); } catch (err) {}
  if (isActive) {
    const remaining = getState().openTabs || [];
    const next = remaining[idx] || remaining[idx - 1];
    if (next) await openNote(next);
    else clearEditor();
  }
  // 文件列表高亮同步
  renderFileList();
}

function clearEditor() {
  setState({ currentPath: null, currentContent: '', dirty: false, diskMtime: null });
  doc.setDoc('');
  editor.load('');
  $('fileName').textContent = '未命名.md';
  updateSaveState();
  updateWordCount('');
  renderTagBar();
  renderTabs();
}

function onDocChanged(content) {
  setState({ dirty: true });
  const dirtyTabs = { ...(getState().dirtyTabs || {}), [getState().currentPath]: true };
  setState({ dirtyTabs });
  updateSaveState();
  updateWordCount(content);
  renderTabs();
  scheduleAutosave(content);
  const st = getState();
  if (st.currentPath) {
    const note = st.notes.find((n) => n.path === st.currentPath);
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

// manual=true 时（Ctrl+S / 菜单保存）显示“保存成功”提示；自动保存 / 失焦 / 退出不弹
async function saveCurrent(manual) {
  const st = getState();
  if (!st.currentPath) {
    if (manual) showToast('没有可保存的文件');
    return;
  }
  let cleaned;
  if (st.sourceMode) {
    // 源码视图：直接取 textarea 内容，避免用隐藏的编辑面板序列化
    cleaned = editor.cleanMarkdown($('sourcePane').value);
    doc.setDoc(cleaned);
  } else {
    editor.flush();
    cleaned = editor.cleanMarkdown(doc.getDoc());
  }
  try {
    // 外部修改检测：打开后文件被其他程序改动过，覆盖前先备份盘面版本
    const statNow = await window.api.stat(st.currentPath);
    if (statNow && st.diskMtime != null && Math.abs(statNow.mtimeMs - st.diskMtime) > 1) {
      const bak = await window.api.backupExternal(st.currentPath);
      if (bak) updateSaveState('✓ 已保存（检测到外部修改，已备份原文件）');
    }
    const ok = await window.api.writeFile(st.currentPath, cleaned);
    const statAfter = await window.api.stat(st.currentPath);
    setState({
      dirty: false,
      currentContent: cleaned,
      diskMtime: statAfter ? statAfter.mtimeMs : (statNow ? statNow.mtimeMs : null),
      lastOwnSaveTs: Date.now()
    });
    const dirtyTabs = { ...(getState().dirtyTabs || {}), [st.currentPath]: false };
    setState({ dirtyTabs });
    updateSaveState();
    renderTabs();
    if (manual) {
      if (ok === false) showToast('✕ 保存失败（磁盘写入错误）');
      else showToast('✓ 保存成功：' + baseName(st.currentPath));
    }
  } catch (err) {
    if (manual) showToast('✕ 保存失败');
  }
}

let toastTimer = null;
function showToast(text) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

async function newNote() {
  const p = await window.api.saveFileDialog('新笔记.md', getLibrary());
  if (!p) return;
  const template = '---\ntitle: 新笔记\ntags: []\n---\n\n# 新笔记\n\n在这里开始写作…\n';
  await window.api.writeFile(p, template);
  if (!isInsideLibrary(p)) await addExternalNote(p);
  await refreshNotes();
  await callOpenNote(p);
}

async function openViaDialog() {
  const p = await window.api.openFileDialog();
  if (!p) return;
  if (!isInsideLibrary(p)) await addExternalNote(p);
  await refreshNotes();
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
  const cleaned = editor.cleanMarkdown(content);
  $('statWords').textContent = cleaned.replace(/\s+/g, '').length + ' 字';
}

function renderFileList() {
  const list = $('fileList');
  const filter = getState().tagFilter;
  let items = getState().notes;
  if (filter) items = items.filter((n) => (n.tags || []).includes(filter));
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
    item.dataset.path = n.path;
    const title = document.createElement('div');
    title.className = 'file-title';
    title.textContent = n.title || n.name.replace(/\.(md|markdown|txt)$/i, '');
    item.appendChild(title);
    if (n.tags && n.tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'file-tags';
      tagRow.textContent = n.tags.map((t) => '#' + t).join(' ');
      item.appendChild(tagRow);
    }
    item.onclick = () => callOpenNote(n.path);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      if (window.api && window.api.fileContextMenu) window.api.fileContextMenu({ path: n.path });
    };
    list.appendChild(item);
  }
}

// ---------- 文件右键动作（主进程菜单回调） ----------
async function handleFileContextAction(payload) {
  const path = payload && payload.path;
  if (!path) return;
  if (payload.action === 'open') {
    await callOpenNote(path);
    return;
  }
  if (payload.action === 'reveal') {
    if (window.api.openInExplorer) window.api.openInExplorer(path);
    return;
  }
  if (payload.action === 'rename') {
    startRename(path);
    return;
  }
  if (payload.action === 'delete') {
    await deleteNote(path);
  }
}

function startRename(path) {
  const item = Array.from(document.querySelectorAll('.file-item')).find((el) => el.dataset.path === path);
  if (!item) return;
  const oldName = baseName(path);
  const input = document.createElement('input');
  input.className = 'file-rename-input';
  input.value = oldName.replace(/\.(md|markdown|txt)$/i, '');
  item.querySelector('.file-title').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== oldName.replace(/\.(md|markdown|txt)$/i, '')) {
      const dir = path.substring(0, path.length - oldName.length);
      const newName = /\.(md|markdown|txt)$/i.test(name) ? name : name + '.md';
      const newPath = dir + newName;
      const r = await window.api.renameFile(path, newPath);
      if (r && r.ok) {
        // 更新标签 / 最近 / 外部列表中的路径
        setState({
          externalNotes: (getState().externalNotes || []).map((p) => p === path ? newPath : p),
          openTabs: (getState().openTabs || []).map((p) => p === path ? newPath : p)
        });
        const dirtyTabs = { ...(getState().dirtyTabs || {}) };
        if (path in dirtyTabs) { dirtyTabs[newPath] = dirtyTabs[path]; delete dirtyTabs[path]; }
        setState({ dirtyTabs });
        if (getState().currentPath === path) setState({ currentPath: newPath });
        const config = { ...(getState().config || {}) };
        if (config.recent) config.recent = config.recent.map((p) => p === path ? newPath : p);
        if (config.lastNote === path) config.lastNote = newPath;
        setState({ config });
        await window.api.saveConfig(config);
        await refreshNotes();
        if (getState().currentPath === newPath) {
          $('fileName').textContent = newName;
          renderTabs();
        }
        showToast('✓ 已重命名为 ' + newName);
      } else {
        showToast('✕ 重命名失败：' + ((r && r.reason) || '未知错误'));
        renderFileList();
      }
    } else {
      renderFileList();
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteNote(path) {
  const r = await window.api.deleteFile(path);
  if (!r || r.canceled || !r.ok) return;
  const tabs = (getState().openTabs || []).slice();
  if (tabs.includes(path)) {
    if (getState().currentPath === path) {
      const remaining = tabs.filter((p) => p !== path);
      const idx = tabs.indexOf(path);
      const next = remaining[idx] || remaining[idx - 1];
      await removeTab(path);
      if (next) await openNote(next);
      else clearEditor();
    } else {
      await removeTab(path);
    }
  }
  const recent = (getState().config && getState().config.recent || []).filter((p) => p !== path);
  const config = { ...(getState().config || {}), recent };
  if (config.lastNote === path) delete config.lastNote;
  setState({ config, recent: recent.slice(0, 6) });
  await window.api.saveConfig(config);
  renderRecent();
  await refreshNotes();
  showToast('✓ 已删除');
}

// ---------- 启动恢复 / 崩溃恢复 ----------
// 打开上次笔记；若 .bak 比主文件新（断电/崩溃中断写入），提示用备份恢复
async function restoreLastSession() {
  const cfg = getState().config || {};
  const lastNote = cfg.lastNote;
  if (!lastNote) return;
  const bakSt = await window.api.stat(lastNote + '.bak');
  const mainSt = await window.api.stat(lastNote);
  if (bakSt && (!mainSt || bakSt.mtimeMs > mainSt.mtimeMs)) {
    const r = await window.api.confirmDialog({
      type: 'warning',
      title: '检测到未保存的版本',
      message: '「' + baseName(lastNote) + '」上次可能未保存成功',
      detail: '系统检测到较新的备份文件（.bak），可能是断电或异常退出时留下的。是否用备份恢复？',
      buttons: ['忽略', '用备份恢复'],
      defaultId: 1,
      cancelId: 0
    });
    if (r && r.response === 1) {
      const ok = await window.api.restoreBak(lastNote);
      if (ok) showToast('✓ 已从备份恢复');
    }
  }
  if (mainSt || await window.api.stat(lastNote)) {
    await callOpenNote(lastNote);
  }
}

// ---------- 标签栏 ----------
function renderTagBar() {
  const bar = $('tagBar');
  if (!bar) return;
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
  editor.load(md);
  onDocChanged(md);
  renderTagBar();
}

function removeTag(tag) {
  if (!getState().currentPath) return;
  const fm = parseFrontmatter(doc.getDoc());
  const tags = (fm.tags || []).filter(t => t !== tag);
  const md = setTagsInContent(doc.getDoc(), tags);
  doc.setDoc(md);
  editor.load(md);
  onDocChanged(md);
  renderTagBar();
}

module.exports = {
  init, setLibrary, getLibrary, getNotes, refreshNotes,
  openNote, openViaDialog, newNote, saveCurrent, onDocChanged,
  switchTab, closeTab, renderTabs, renderRecent, removeRecent,
  handleFileContextAction, restoreLastSession, updateSaveState
};
