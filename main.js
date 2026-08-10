const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, powerMonitor, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_LIBRARY = () => {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'notes');
  }
  return path.join(__dirname, 'notes');
};
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const ICON_PATH = () => path.join(__dirname, 'dist', 'icon.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let allowClose = false;
let quitSaveTimer = null;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8'));
  } catch {
    return { library: null, theme: 'light', window: null };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('save config failed:', err);
  }
}

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu', action);
  }
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload); } catch (err) {}
  }
}
// 外部修改检测：记录自身写入时间，避免把应用自己的保存当成外部修改
const lastOwnWrite = new Map();
// 当前笔记文件监听（按目录+文件名过滤，原子写替换文件后仍有效）
const noteWatchers = new Map();
let dirWatchTimer = null;
const dirWatchers = new Map();

function watchNoteFile(filePath) {
  unwatchNoteFile(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    const w = fs.watch(dir, { persistent: false }, (_ev, fn) => {
      if (fn !== base) return;
      const ownTs = lastOwnWrite.get(filePath) || 0;
      if (Date.now() - ownTs < 1500) return;
      notifyRenderer('file:external-change', { path: filePath });
    });
    noteWatchers.set(filePath, w);
  } catch (err) {}
}
function unwatchNoteFile(filePath) {
  const w = noteWatchers.get(filePath);
  if (w) { try { w.close(); } catch (err) {} noteWatchers.delete(filePath); }
}
function unwatchAllDirs() {
  for (const [, w] of dirWatchers) { try { w.close(); } catch (err) {} }
  dirWatchers.clear();
}
function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// 退出前强制保存：通知渲染进程立即落盘，超时或失败则强制结束全部进程
function forceSaveAndQuit() {
  isQuitting = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    app.exit(0);
    return;
  }
  allowClose = true;
  clearTimeout(quitSaveTimer);
  quitSaveTimer = setTimeout(() => {
    try { mainWindow.destroy(); } catch (err) {}
    app.exit(0);
  }, 1500);
  try {
    // 通知渲染进程立即保存未落盘内容，完成后回调 app:before-quit-done
    mainWindow.webContents.send('app:before-quit');
  } catch (err) {
    try { mainWindow.destroy(); } catch (err2) {}
    app.exit(0);
  }
}

// 系统托盘：单击显隐主窗口；右键菜单：新建 / 打开 / 退出
function createTray() {
  try {
    tray = new Tray(ICON_PATH());
    tray.setToolTip('MarkdownNote');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 MarkdownNote', click: showWindow },
      { type: 'separator' },
      { label: '新建笔记', click: () => sendMenu('new') },
      { label: '打开笔记...', click: () => sendMenu('open') },
      { type: 'separator' },
      { label: '退出', click: forceSaveAndQuit }
    ]));
    tray.on('click', toggleWindow);
  } catch (err) {
    console.error('create tray failed:', err);
  }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建笔记', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: '打开笔记...', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { type: 'separator' },
        { label: '选择笔记库文件夹...', click: () => sendMenu('pick-folder') },
        { label: '在资源管理器中显示笔记库', click: () => sendMenu('open-library') },
        { type: 'separator' },
        { label: '导出 HTML...', click: () => sendMenu('export-html') },
        { label: '导出 PDF...', click: () => sendMenu('export-pdf') },
        { label: '导出为 PNG 长图...', click: () => sendMenu('export-png') },
        { type: 'separator' },
        { label: '打印…', click: () => sendMenu('print') },
        { type: 'separator' },
        { label: '退出', click: forceSaveAndQuit }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '粘贴为 Markdown', accelerator: 'CmdOrCtrl+Shift+V', click: () => sendMenu('paste-md') },
        { label: '复制为 Markdown', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendMenu('copy-md') },
        { type: 'separator' },
        { label: '删除当前行', accelerator: 'CmdOrCtrl+D', click: () => sendMenu('delete-line') },
        { label: '注释 / 取消注释', accelerator: 'CmdOrCtrl+/', click: () => sendMenu('toggle-comment') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenu('toggle-theme') },
        { type: 'separator' },
        { label: '切换源码视图', accelerator: 'CmdOrCtrl+Alt+S', click: () => sendMenu('source-toggle') },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 MarkdownNote', click: () => sendMenu('about') }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const config = loadConfig();
  mainWindow = new BrowserWindow({
    width: config.window?.width || 1280,
    height: config.window?.height || 800,
    x: config.window?.x,
    y: config.window?.y,
    minWidth: 960,
    minHeight: 600,
    title: 'MarkdownNote',
    icon: ICON_PATH(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    const cfg = loadConfig();
    cfg.window = mainWindow.getBounds();
    saveConfig(cfg);
    if (allowClose) return;
    // 测试模式（--smoke / --repro）不拦截，由测试框架自行退出
    if (process.argv.includes('--smoke') || process.argv.includes('--repro')) return;
    e.preventDefault();
    // 非退出流程：点 ✕ 最小化到托盘，后台继续运行
    if (!isQuitting) {
      mainWindow.hide();
      return;
    }
    // 退出流程：先保存再关闭
    allowClose = true;
    clearTimeout(quitSaveTimer);
    quitSaveTimer = setTimeout(() => {
      try { mainWindow.destroy(); } catch (err) {}
      app.exit(0);
    }, 1500);
    try {
      // 通知渲染进程立即保存未落盘内容，完成后回调 app:before-quit-done
      mainWindow.webContents.send('app:before-quit');
    } catch (err) {
      try { mainWindow.destroy(); } catch (err2) {}
      app.exit(0);
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log('[renderer-error]', message);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (process.argv.includes('--repro')) {
      setTimeout(() => {
        mainWindow.webContents.executeJavaScript(require('./tools/roundtrip-code')).then((r) => {
          fs.writeFileSync(path.join(app.getPath('temp'), 'markdownnote-repro.json'), JSON.stringify(r, null, 1), 'utf-8');
          console.log('[REPRO] done');
          app.exit(0);
        }).catch((err) => {
          fs.writeFileSync(path.join(app.getPath('temp'), 'markdownnote-repro.json'), JSON.stringify({ fatal: String(err && err.stack || err) }), 'utf-8');
          console.error('[REPRO] failed', err);
          app.exit(1);
        });
      }, 2000);
      return;
    }
    if (process.argv.includes('--smoke')) {
      setTimeout(() => { console.error('[SMOKE] watchdog fired, forcing exit'); app.exit(2); }, 60000);
      mainWindow.webContents.executeJavaScript(require('./tools/smoke-code')).then((r) => {
        console.log('[SMOKE]', JSON.stringify(r));
        fs.writeFileSync(path.join(app.getPath('temp'), 'markdownnote-smoke.json'), JSON.stringify(r), 'utf-8');
        setTimeout(() => app.quit(), 200);
      }).catch((err) => {
        console.error('[SMOKE] check failed:', err);
        app.quit();
      });
    }
  });
}

function registerIpc() {
  // 由主进程读写系统剪贴板（渲染进程 navigator.clipboard 在无用户手势时会被 Electron 拒绝）
  ipcMain.handle('clipboard:write', (_e, payload) => {
    try {
      if (payload && payload.html) clipboard.write({ text: payload.text || '', html: payload.html });
      else clipboard.writeText(payload?.text || '');
      return true;
    } catch (err) {
      console.error('clipboard write failed:', err);
      return false;
    }
  });

  // 读取系统剪贴板（text/html 都有时交给渲染层转回 Markdown）
  ipcMain.handle('clipboard:read', () => ({ text: clipboard.readText(), html: clipboard.readHTML() }));

  ipcMain.handle('app:info', () => ({
    defaultLibrary: DEFAULT_LIBRARY(),
    version: app.getVersion()
  }));

  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:saveFile', async (_e, payload) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: payload?.defaultName || 'untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // 读取容错：优先按 UTF-8 严格解码（非法字节抛错），失败再按 GBK 解码，
  // 避免 GBK/ANSI 编码的 md 文件被硬读成 UTF-8 而出现 �（U+FFFD 替换符）。
  function readFileSmart(filePath) {
    const buf = fs.readFileSync(filePath);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\ufeff/, '');
    } catch {
      try {
        return new TextDecoder('gbk').decode(buf).replace(/^\ufeff/, '');
      } catch {
        return buf.toString('latin1').replace(/^\ufeff/, '');
      }
    }
  }
  ipcMain.handle('fs:readFile', (_e, filePath) => readFileSmart(filePath));

  ipcMain.handle('fs:writeFile', (_e, filePath, content) => {
    // 滚动备份：覆盖前把现有文件复制为 *.bak（排除 .bak 自身，避免 .bak.bak 链式备份）
    try {
      if (fs.existsSync(filePath) && !/\.bak($|\.)/i.test(path.basename(filePath))) {
        fs.copyFileSync(filePath, filePath + '.bak');
      }
    } catch (err) {}
    // 原子写入：先写临时文件再 rename 覆盖，断电/崩溃不会留下半截主文件
    try {
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, filePath);
      lastOwnWrite.set(filePath, Date.now());
      return true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('fs:stat', (_e, filePath) => {
    try {
      const st = fs.statSync(filePath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  });

  // 只读文件头部（用于列表解析 frontmatter，避免大库全量读取）
  ipcMain.handle('fs:readFileHead', (_e, filePath, maxBytes) => {
    const limit = Math.max(256, Math.min(maxBytes || 8192, 1024 * 1024));
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(limit + 8); // 多读 8 字节，避免截断多字节 UTF-8 字符
      const len = fs.readSync(fd, buf, 0, limit + 8, 0);
      const data = buf.slice(0, len);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        try {
          text = new TextDecoder('gbk').decode(data);
        } catch {
          text = data.toString('latin1');
        }
      }
      return text.replace(/^\ufeff/, '').slice(0, limit);
    } finally {
      fs.closeSync(fd);
    }
  });

  // 外部修改备份：把盘面当前版本复制为 *.bak.external-<ts>
  ipcMain.handle('fs:backupExternal', (_e, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return false;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = filePath + '.bak.external-' + ts;
      fs.copyFileSync(filePath, dest);
      return dest;
    } catch (err) {
      return false;
    }
  });

  // 粘贴图片落盘：保存到笔记同目（同名 .assets 文件夹），返回相对 markdown 引用
  ipcMain.handle('fs:saveImage', (_e, payload) => {
    const dataUrl = payload && payload.dataUrl;
    const notePath = payload && payload.notePath;
    if (!dataUrl || typeof dataUrl !== 'string' || !notePath || typeof notePath !== 'string') return null;
    const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
    if (!m) return null;
    const extMap = { jpeg: 'jpg', 'svg+xml': 'svg' };
    const rawExt = m[1].toLowerCase();
    const ext = extMap[rawExt] || rawExt.replace(/[^a-z0-9]/g, '') || 'png';
    const base = path.basename(notePath, path.extname(notePath));
    const dir = path.join(path.dirname(notePath), base + '.assets');
    fs.mkdirSync(dir, { recursive: true });
    const name = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
    return (base + '.assets/' + name).replace(/\\/g, '/');
  });

  ipcMain.handle('fs:ensureDir', (_e, dir) => {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  });

  ipcMain.handle('fs:listDir', (_e, dir) => {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      out.push({ name, path: full, isDir });
    }
    return out;
  });

  ipcMain.handle('fs:readConfig', () => loadConfig());
  ipcMain.handle('fs:saveConfig', (_e, config) => {
    saveConfig(config);
    return true;
  });
  ipcMain.handle('fs:openInExplorer', (_e, target) => shell.showItemInFolder(target));

  // 通用确认对话框（关闭标签 / 删除等二次确认）
  ipcMain.handle('dialog:confirm', async (_e, payload) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: payload?.type || 'question',
      title: payload?.title || '确认',
      message: payload?.message || '',
      detail: payload?.detail || '',
      buttons: payload?.buttons || ['确定'],
      defaultId: payload?.defaultId != null ? payload.defaultId : 0,
      cancelId: payload?.cancelId != null ? payload.cancelId : 0,
      noLink: true
    });
    return { response: r.response };
  });

  // 重命名笔记（目标已存在时拒绝）
  ipcMain.handle('fs:rename', (_e, oldPath, newPath) => {
    try {
      if (!oldPath || !newPath) return { ok: false, reason: '路径无效' };
      if (!fs.existsSync(oldPath)) return { ok: false, reason: '源文件不存在' };
      if (fs.existsSync(newPath)) return { ok: false, reason: '目标文件已存在' };
      fs.renameSync(oldPath, newPath);
      lastOwnWrite.delete(oldPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  });

  // 删除笔记（主进程弹原生确认框）
  ipcMain.handle('fs:delete', async (_e, filePath) => {
    const name = path.basename(filePath || '');
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '删除笔记',
      message: '确定删除「' + name + '」吗？',
      detail: '删除后不可恢复（同名 .bak 备份会一并删除）。',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (r.response !== 1) return { ok: false, canceled: true };
    try {
      fs.unlinkSync(filePath);
      try { fs.unlinkSync(filePath + '.bak'); } catch (err) {}
      lastOwnWrite.delete(filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  });

  // 崩溃恢复：把 .bak 复制回主文件
  ipcMain.handle('fs:restoreBak', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath + '.bak')) return false;
      fs.copyFileSync(filePath + '.bak', filePath);
      lastOwnWrite.set(filePath, Date.now());
      return true;
    } catch (err) {
      return false;
    }
  });

  // 监听当前笔记文件（外部修改提示）；原子写替换文件后基于目录监听仍有效
  ipcMain.handle('fs:watchFile', (_e, filePath) => { watchNoteFile(filePath); return true; });
  ipcMain.handle('fs:unwatchFile', (_e, filePath) => { unwatchNoteFile(filePath); return true; });

  // 监听笔记库目录（新增/删除/重命名自动刷新文件列表）
  ipcMain.handle('fs:watchDir', (_e, dir) => {
    unwatchAllDirs();
    if (!dir) return true;
    try {
      const w = fs.watch(dir, { recursive: true, persistent: false }, (_ev, fn) => {
        if (!fn) return;
        const name = String(fn);
        if (name.endsWith('.tmp') || name.endsWith('.bak') || /.bak.external-/.test(name)) return;
        clearTimeout(dirWatchTimer);
        dirWatchTimer = setTimeout(() => notifyRenderer('fs:dir-changed', { dir }), 600);
      });
      dirWatchers.set(dir, w);
    } catch (err) {}
    return true;
  });
  ipcMain.handle('fs:unwatchDir', () => { unwatchAllDirs(); return true; });

  // 文件列表右键菜单（原生菜单）
  ipcMain.handle('file:contextMenu', (_e, payload) => {
    const filePath = payload && payload.path;
    if (!filePath) return false;
    const win = BrowserWindow.fromWebContents(_e.sender) || mainWindow;
    const menu = Menu.buildFromTemplate([
      { label: '打开', click: () => notifyRenderer('file:context-action', { action: 'open', path: filePath }) },
      { label: '重命名…', click: () => notifyRenderer('file:context-action', { action: 'rename', path: filePath }) },
      { label: '删除…', click: () => notifyRenderer('file:context-action', { action: 'delete', path: filePath }) },
      { type: 'separator' },
      { label: '在资源管理器中显示', click: () => shell.showItemInFolder(filePath) }
    ]);
    menu.popup({ window: win });
    return true;
  });

  // 打印：隐藏窗口加载导出 HTML 后调起系统打印
  ipcMain.handle('print:doc', async (_e, payload) => {
    const html = payload?.html || '';
    const tmp = path.join(app.getPath('temp'), 'markdownnote-print-' + Date.now() + '.html');
    fs.writeFileSync(tmp, html, 'utf-8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
    try {
      await win.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 250));
      win.webContents.print({ silent: false, printBackground: true }, () => {
        try { win.destroy(); } catch (err) {}
        try { fs.unlinkSync(tmp); } catch (err) {}
      });
      return true;
    } catch (err) {
      try { win.destroy(); } catch (err2) {}
      try { fs.unlinkSync(tmp); } catch (err2) {}
      return false;
    }
  });

  // 导出为 PNG 长图：隐藏窗口按内容高度截图
  ipcMain.handle('export:png', async (_e, payload) => {
    const html = payload?.html || '';
    const defaultName = payload?.defaultName || 'export.png';
    const tmp = path.join(app.getPath('temp'), 'markdownnote-png-' + Date.now() + '.html');
    fs.writeFileSync(tmp, html, 'utf-8');
    const win = new BrowserWindow({
      show: false, width: 900, height: 800,
      backgroundColor: '#ffffff',
      webPreferences: { sandbox: false }
    });
    try {
      await win.loadFile(tmp);
      await new Promise((r) => setTimeout(r, 300));
      const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
      win.setContentSize(900, Math.min(Math.max(h + 60, 400), 20000));
      await new Promise((r) => setTimeout(r, 400));
      const image = await win.webContents.capturePage();
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      });
      if (r.canceled) return null;
      fs.writeFileSync(r.filePath, image.toPNG());
      return r.filePath;
    } finally {
      win.destroy();
      try { fs.unlinkSync(tmp); } catch (err) {}
    }
  });

  ipcMain.handle('export:pdf', async (_e, payload) => {
    const html = payload?.html || '';
    const defaultName = payload?.defaultName || 'export.pdf';
    const tmp = path.join(app.getPath('temp'), `markdownnote-export-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf-8');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
    try {
      await win.loadFile(tmp);
      const data = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { marginType: 'default' }
      });
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (r.canceled) return null;
      fs.writeFileSync(r.filePath, data);
      return r.filePath;
    } finally {
      win.destroy();
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  });

  ipcMain.on('app:before-quit-done', () => {
    clearTimeout(quitSaveTimer);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  });

  ipcMain.handle('app:about', async () => {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '关于 MarkdownNote',
      message: 'MarkdownNote',
      detail:
        '所见即所得 Markdown 笔记编辑器\n' +
        '功能：实时排版 · 图片粘贴嵌入 · 标签 · 全文搜索 · 导出 PDF/HTML\n' +
        '技术栈：Electron + markdown-it + turndown'
    });
    return true;
  });
}

app.setName('MarkdownNote');

// 单实例：重复启动时唤起已有窗口并立即退出，避免多开残留进程
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    if (app.isPackaged) {
      const dest = DEFAULT_LIBRARY();
      if (!fs.existsSync(dest)) {
        try {
          fs.mkdirSync(dest, { recursive: true });
          const src = path.join(process.resourcesPath, 'notes');
          for (const f of fs.readdirSync(src)) {
            fs.copyFileSync(path.join(src, f), path.join(dest, f));
          }
          console.log('示例笔记已复制到', dest);
        } catch (err) {
          console.error('复制示例笔记失败:', err);
        }
      }
    }
    registerIpc();
    buildMenu();
    createTray();
    createWindow();

    // 断电 / 关机 / 注销：先保存再退出，防止未落盘内容丢失
    powerMonitor.on('shutdown', () => forceSaveAndQuit());
    powerMonitor.on('session-end', () => forceSaveAndQuit());

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('window-all-closed', () => {
    // 窗口全部关闭（退出流程）后强制结束全部子进程，托盘后台也不会残留
    app.exit(0);
  });
}
