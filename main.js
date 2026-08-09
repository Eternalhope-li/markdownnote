const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
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
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendMenu('toggle-theme') },
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
    allowClose = true;
    clearTimeout(quitSaveTimer);
    // 防止死锁：渲染进程未响应时强制关闭
    quitSaveTimer = setTimeout(() => {
      try { mainWindow.destroy(); } catch (err) {}
    }, 1500);
    try {
      // 通知渲染进程立即保存未落盘内容，完成后回调 app:before-quit-done
      mainWindow.webContents.send('app:before-quit');
    } catch (err) {
      try { mainWindow.destroy(); } catch (err2) {}
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) console.log('[renderer-error]', message);
  });

  mainWindow.webContents.on('did-finish-load', () => {
            if (process.argv.includes('--repro')) {
      setTimeout(() => {
        require('./tools/roundtrip-code.js').length; mainWindow.webContents.executeJavaScript(require('./tools/roundtrip-code')).then((r) => {
          require('fs').writeFileSync(path.join(app.getPath('temp'), 'markdownnote-repro.json'), JSON.stringify(r, null, 1), 'utf-8');
          console.log('[REPRO] done');
          app.exit(0);
        }).catch((err) => {
          require('fs').writeFileSync(path.join(app.getPath('temp'), 'markdownnote-repro.json'), JSON.stringify({ fatal: String(err && err.stack || err) }), 'utf-8');
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
    // 滚动备份：覆盖前把现有文件复制为 *.bak
    // （排除 .bak 自身的写入，避免 .bak.bak 链式备份）
    try {
      if (fs.existsSync(filePath) && !/\.bak($|\.)/i.test(path.basename(filePath))) {
        fs.copyFileSync(filePath, filePath + '.bak');
      }
    } catch (err) {}
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
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
        'Typora 式所见即所得 Markdown 笔记编辑器\n' +
        '功能：实时排版 · 图片粘贴嵌入 · 标签 · 全文搜索 · 导出 PDF/HTML\n' +
        '技术栈：Electron + markdown-it + turndown'
    });
    return true;
  });
}


app.setName('MarkdownNote');

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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});




