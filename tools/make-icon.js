const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [64, 128, 256];

app.on('window-all-closed', () => { /* 保持进程存活直到所有尺寸截图完成 */ });

process.on('unhandledRejection', (err) => {
  console.error('[icon] unhandled rejection:', err && err.message);
  app.exit(1);
});

function svgFor(size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 512 512">' +
    '<defs>' +
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#4F6EF7"/>' +
    '<stop offset="0.55" stop-color="#3B82F6"/>' +
    '<stop offset="1" stop-color="#22C1A5"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<rect x="8" y="8" width="496" height="496" rx="112" fill="url(#g)"/>' +
    '<rect x="8" y="8" width="496" height="496" rx="112" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="12"/>' +
    '<text x="256" y="258" font-family="Segoe UI, Arial, sans-serif" font-size="232" font-weight="800" fill="#ffffff" text-anchor="middle" dominant-baseline="central">MD</text>' +
    '<rect x="156" y="338" width="200" height="18" rx="9" fill="#ffffff" opacity="0.92"/>' +
    '</svg>';
}

function pngToIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const p of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
    entry.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(p.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += p.data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const pngs = [];
    for (const size of SIZES) {
      console.log('[icon] capturing ' + size + 'px...');
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head><body>' + svgFor(size) + '</body></html>';
      const tmp = path.join(app.getPath('temp'), 'mdnote-icon-' + size + '.html');
      fs.writeFileSync(tmp, html, 'utf-8');
      const win = new BrowserWindow({
        width: size,
        height: size,
        show: true,
        frame: false,
        alwaysOnTop: false
      });
      try {
        await new Promise((resolve, reject) => {
          win.webContents.once('did-finish-load', resolve);
          win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error('load fail ' + code + ' ' + desc)));
          win.loadFile(tmp);
        });
        await new Promise((r) => setTimeout(r, 300));
        const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
        const png = img.toPNG();
        console.log('[icon] ' + size + 'px captured, png bytes=' + png.length);
        pngs.push({ size, data: png });
      } finally {
        win.destroy();
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
    }
    const big = pngs.find((p) => p.size === 256);
    if (!big) throw new Error('no 256px image captured');
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), big.data);
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), pngToIco(pngs));
    console.log('icon generated ->', path.join(OUT_DIR, 'icon.png'), path.join(OUT_DIR, 'icon.ico'));
    app.quit();
  } catch (err) {
    console.error('[icon] error:', err);
    app.exit(1);
  }
});