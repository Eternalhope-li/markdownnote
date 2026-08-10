const { getState, setState } = require('./state');
const files = require('./files');
const search = require('./search');
const themes = require('./themes');
const exporter = require('./export');
const editor = require('./editor');
const doc = require('./doc');

const $ = (id) => document.getElementById(id);

// ---------- 大纲 ----------
function renderOutline(items) {
  const panel = $('outlinePanel');
  if (!panel) return;
  if (!items || !items.length) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="side-panel-title">大纲</div>';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'outline-item l' + it.level;
    row.textContent = it.text;
    row.title = it.text;
    row.onclick = () => {
      it.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('editorPane').focus();
    };
    panel.appendChild(row);
  }
}

// ---------- 源码视图 ----------
function toggleSourceMode() {
  const pane = $('editorPane');
  const src = $('sourcePane');
  const btn = $('btnSource');
  if (!getState().sourceMode) {
    editor.flush();
    src.value = doc.getDoc();
    pane.hidden = true;
    src.hidden = false;
    src.focus();
    setState({ sourceMode: true });
    btn.classList.add('active');
  } else {
    doc.setDoc(src.value);
    editor.load(src.value);
    pane.hidden = false;
    src.hidden = true;
    setState({ sourceMode: false });
    btn.classList.remove('active');
    files.onDocChanged(src.value);
  }
}

// ---------- 设置 ----------
function applyEditorStyle(cfg) {
  const pane = $('editorPane');
  if (!pane) return;
  if (cfg.fontSize) pane.style.fontSize = cfg.fontSize + 'px';
  if (cfg.lineHeight) pane.style.lineHeight = cfg.lineHeight;
}

function openSettings() {
  const cfg = getState().config || {};
  $('setFontSize').value = String(cfg.fontSize || 15);
  $('setLineHeight').value = String(cfg.lineHeight || 1.75);
  $('setLibPath').textContent = getState().library || '';
  $('settingsModal').hidden = false;
}

function closeSettings() {
  $('settingsModal').hidden = true;
}

function saveSettings() {
  const cfg = { ...(getState().config || {}) };
  cfg.fontSize = parseInt($('setFontSize').value, 10) || 15;
  cfg.lineHeight = parseFloat($('setLineHeight').value) || 1.75;
  setState({ config: cfg });
  applyEditorStyle(cfg);
  window.api.saveConfig(cfg);
  closeSettings();
}

async function main() {
  const appInfo = await window.api.getAppInfo();
  const config = await window.api.readConfig();
  setState({ appInfo, config: config || {}, externalNotes: (config && config.externalNotes) || [], recent: ((config && config.recent) || []).slice(0, 6) });

  themes.init();
  applyEditorStyle(config || {});

  const openNoteSmart = (p) => files.openNote(p);

  files.init({
    onRefresh: () => search.rebuild(files.getNotes()),
    onOpenNote: openNoteSmart
  });
  const library = (config && config.library) || appInfo.defaultLibrary;
  await files.setLibrary(library);

  search.init(files.getNotes());

  editor.init({
    onChange: (md) => files.onDocChanged(md),
    onSave: () => files.saveCurrent(true),
    onGetNotePath: () => getState().currentPath,
    onOutline: renderOutline
  });

  // 失焦/隐藏时立即保存：进一步降低断电、崩溃等异常情况下的内容丢失
  // Ctrl+P / Ctrl+F：聚焦全局搜索（近似 WYSIWYG 的快速打开 / 查找）
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'p' || k === 'f') {
        const input = $('searchInput');
        if (input && document.activeElement !== input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    }
    // Ctrl+Alt+S：切换源码视图
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleSourceMode();
    }
  });

  window.addEventListener('blur', () => { if (getState().dirty) files.saveCurrent(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && getState().dirty) files.saveCurrent();
  });

  // 退出前强制保存：防止自动保存防抖窗口内未落盘
  window.api.onBeforeQuit(async () => {
    try {
      await files.saveCurrent();
    } finally {
      window.api.beforeQuitDone();
    }
  });

  // 外部修改提示：当前笔记被其他程序改动
  window.api.onFileExternalChange(async (payload) => {
    if (!payload || payload.path !== getState().currentPath) return;
    const name = String(payload.path).split(/[\\/]/).pop();
    const r = await window.api.confirmDialog({
      type: 'warning',
      title: '文件已在外部修改',
      message: '「' + name + '」已被其他程序修改',
      detail: '重新加载会覆盖当前编辑区的未保存修改，要继续吗？',
      buttons: ['忽略', '重新加载'],
      defaultId: 0,
      cancelId: 0
    });
    if (r && r.response === 1) {
      await files.openNote(payload.path);
    }
  });

  // 笔记库目录变化：自动刷新文件列表（本应用自身写入后 1.2s 内忽略）
  window.api.onDirChanged(() => {
    if (Date.now() - (getState().lastOwnSaveTs || 0) < 1200) return;
    files.refreshNotes();
  });

  // 文件列表右键菜单回调
  window.api.onFileContextAction((payload) => files.handleFileContextAction(payload));

  // 源码视图输入 → 触发自动保存
  $('sourcePane').addEventListener('input', () => {
    files.onDocChanged($('sourcePane').value);
  });

  $('btnNew').onclick = () => files.newNote();
  $('btnExportHtml').onclick = () => exporter.exportHtml();
  $('btnExportPdf').onclick = () => exporter.exportPdf();
  let codeLinesOn = localStorage.getItem('mdn-code-lines') !== '0'; // 默认开启代码行号
  editor.setCodeLines(codeLinesOn);
  const refreshCodeLinesBtn = () => {
    $('btnCodeLines').classList.toggle('active', codeLinesOn);
    $('btnCodeLines').title = codeLinesOn ? '关闭代码行号' : '开启代码行号';
  };
  $('btnCodeLines').onclick = () => {
    codeLinesOn = !codeLinesOn;
    localStorage.setItem('mdn-code-lines', codeLinesOn ? '1' : '0');
    editor.setCodeLines(codeLinesOn);
    refreshCodeLinesBtn();
  };
  refreshCodeLinesBtn();
  $('btnTheme').onclick = () => themes.toggle();
  $('btnSource').onclick = () => toggleSourceMode();
  $('btnSettings').onclick = () => openSettings();
  $('settingsCancelBtn').onclick = () => closeSettings();
  $('settingsOkBtn').onclick = () => saveSettings();
  $('setPickLib').onclick = async () => {
    const dir = await window.api.pickFolder();
    if (dir) {
      await files.setLibrary(dir);
      $('setLibPath').textContent = dir;
    }
  };
  $('settingsModal').addEventListener('mousedown', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });
  $('btnPickFolder').onclick = async () => {
    const dir = await window.api.pickFolder();
    if (dir) await files.setLibrary(dir);
  };

  let searchTimer = null;
  let searchSeq = 0;
  $('searchInput').addEventListener('input', () => {
    const q = $('searchInput').value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const results = await search.search(q);
      if (seq === searchSeq) renderSearchResults(results, q);
    }, 150);
  });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('searchInput').value = '';
      renderSearchResults([], '');
    }
  });

  window.api.onMenu((action) => {
    switch (action) {
      case 'new': files.newNote(); break;
      case 'open': files.openViaDialog(); break;
      case 'save': files.saveCurrent(true); break;
      case 'pick-folder': $('btnPickFolder').click(); break;
      case 'open-library': window.api.openInExplorer(files.getLibrary()); break;
      case 'export-html': exporter.exportHtml(); break;
      case 'export-pdf': exporter.exportPdf(); break;
      case 'export-png': exporter.exportPng(); break;
      case 'print': exporter.printDoc(); break;
      case 'paste-md': editor.pasteAsMarkdown(); break;
      case 'copy-md': editor.copyAsMarkdown(); break;
      case 'delete-line': editor.deleteCurrentBlock(); break;
      case 'toggle-comment': editor.toggleComment(); break;
      case 'source-toggle': toggleSourceMode(); break;
      case 'toggle-theme': themes.toggle(); break;
      case 'about': window.api.about(); break;
      default: break;
    }
  });

  // 启动：恢复上次打开的笔记（含崩溃恢复提示）；无任何笔记时新建
  await files.restoreLastSession();
  if (!getState().currentPath) {
    const notes = files.getNotes();
    if (notes.length > 0) await openNoteSmart(notes[0].path);
    else await files.newNote();
  }

  // 冒烟测试钩子
  window.__test = {
    openNote: (p) => files.openNote(p),
    save: () => files.saveCurrent(),
    currentPath: () => getState().currentPath
  };
}

function renderSearchResults(results, q) {
  const box = $('searchResults');
  $('statSearch').textContent = q ? (results.length ? '找到 ' + results.length + ' 条' : '无结果') : '';
  box.innerHTML = '';
  if (!q) {
    box.classList.remove('show');
    return;
  }
  box.classList.add('show');
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'search-item';
    const head = document.createElement('div');
    head.className = 'search-head';
    head.textContent = r.title || r.name;
    if (r.tags && r.tags.length) {
      const tags = document.createElement('span');
      tags.className = 'search-tags';
      tags.textContent = r.tags.map(t => '#' + t).join(' ');
      head.appendChild(tags);
    }
    item.appendChild(head);
    if (r.snippet) {
      const snip = document.createElement('div');
      snip.className = 'search-snippet';
      snip.textContent = r.snippet;
      item.appendChild(snip);
    }
    item.onclick = () => {
      $('searchInput').value = '';
      renderSearchResults([], '');
      files.openNote(r.path);
    };
    box.appendChild(item);
  }
}

main().catch((err) => {
  console.error('启动失败:', err);
  document.body.innerHTML = '<pre style="padding:20px;white-space:pre-wrap">启动失败：' + String((err && err.stack) || err) + '</pre>';
});
