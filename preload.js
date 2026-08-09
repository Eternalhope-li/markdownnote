const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (defaultName) => ipcRenderer.invoke('dialog:saveFile', { defaultName }),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  readFileHead: (p, maxBytes) => ipcRenderer.invoke('fs:readFileHead', p, maxBytes),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  backupExternal: (p) => ipcRenderer.invoke('fs:backupExternal', p),
  saveImage: (dataUrl, notePath) => ipcRenderer.invoke('fs:saveImage', { dataUrl, notePath }),
  ensureDir: (d) => ipcRenderer.invoke('fs:ensureDir', d),
  listDir: (d) => ipcRenderer.invoke('fs:listDir', d),
  readConfig: () => ipcRenderer.invoke('fs:readConfig'),
  saveConfig: (c) => ipcRenderer.invoke('fs:saveConfig', c),
  openInExplorer: (t) => ipcRenderer.invoke('fs:openInExplorer', t),
  exportPdf: (o) => ipcRenderer.invoke('export:pdf', o),
  about: () => ipcRenderer.invoke('app:about'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onBeforeQuit: (cb) => ipcRenderer.on('app:before-quit', () => cb()),
  beforeQuitDone: () => ipcRenderer.send('app:before-quit-done')
});