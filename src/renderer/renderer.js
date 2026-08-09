const { getState, setState } = require('./state');
const files = require('./files');
const search = require('./search');
const themes = require('./themes');
const exporter = require('./export');
const typora = require('./typora');

const $ = (id) => document.getElementById(id);

async function main() {
  const appInfo = await window.api.getAppInfo();
  const config = await window.api.readConfig();
  setState({ appInfo, config: config || {} });

  themes.init();

  const openNoteSmart = (p) => files.openNote(p);

  files.init({
    onRefresh: () => search.rebuild(files.getNotes()),
    onOpenNote: openNoteSmart
  });
  const library = (config && config.library) || appInfo.defaultLibrary;
  await files.setLibrary(library);

  search.init(files.getNotes());

  typora.init({
    onChange: (md) => files.onDocChanged(md),
    onSave: () => files.saveCurrent(),
    onGetNotePath: () => files.getState().currentPath
  });

  // 退出前强制保存：防止自动保存防抖窗口内未落盘
  window.api.onBeforeQuit(async () => {
    try {
      await files.saveCurrent();
    } finally {
      window.api.beforeQuitDone();
    }
  });

  $('btnNew').onclick = () => files.newNote();
  $('btnExportHtml').onclick = () => exporter.exportHtml();
  $('btnExportPdf').onclick = () => exporter.exportPdf();
  let codeLinesOn = localStorage.getItem('mdn-code-lines') !== '0'; // 默认开启代码行号
  typora.setCodeLines(codeLinesOn);
  const refreshCodeLinesBtn = () => {
    $('btnCodeLines').classList.toggle('active', codeLinesOn);
    $('btnCodeLines').title = codeLinesOn ? '关闭代码行号' : '开启代码行号';
  };
  $('btnCodeLines').onclick = () => {
    codeLinesOn = !codeLinesOn;
    localStorage.setItem('mdn-code-lines', codeLinesOn ? '1' : '0');
    typora.setCodeLines(codeLinesOn);
    refreshCodeLinesBtn();
  };
  refreshCodeLinesBtn();
  $('btnTheme').onclick = () => themes.toggle();
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
      case 'save': files.saveCurrent(); break;
      case 'pick-folder': $('btnPickFolder').click(); break;
      case 'open-library': window.api.openInExplorer(files.getLibrary()); break;
      case 'export-html': exporter.exportHtml(); break;
      case 'export-pdf': exporter.exportPdf(); break;
      case 'toggle-theme': themes.toggle(); break;
      case 'about': window.api.about(); break;
      default: break;
    }
  });

  if (files.getNotes().length > 0) {
    await openNoteSmart(files.getNotes()[0].path);
  } else {
    await files.newNote();
  }

  // 冒烟测试钩子
  window.__test = {
    openNote: (p) => files.openNote(p),
    save: () => files.saveCurrent()
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