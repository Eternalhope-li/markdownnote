// build.js —— 重建渲染进程 bundle：拷贝静态资源 + esbuild 打包 src/renderer/renderer.js -> dist/renderer.js
const { execFileSync } = require('child_process');
const path = require('path');
require('./copy-assets.js');
const root = path.join(__dirname, '..');
const cmd = (process.platform === 'win32' ? 'npx.cmd' : 'npx') + ' --yes esbuild ' +
  path.join('src', 'renderer', 'renderer.js') +
  ' --bundle --format=iife --platform=browser' +
  ' --loader:.css=text --sourcemap' +
  ' --outfile=' + path.join('dist', 'renderer.js') +
  ' --log-level=warning';
execFileSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
console.log('bundle built -> dist/renderer.js');