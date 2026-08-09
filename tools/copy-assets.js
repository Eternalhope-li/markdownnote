const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const dist = path.join(root, 'dist');
const distCss = path.join(dist, 'css');

fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(distCss, { recursive: true });

for (const f of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(src, f), path.join(dist, f));
}

const iconPng = path.join(root, 'build', 'icon.png');
if (fs.existsSync(iconPng)) {
  fs.copyFileSync(iconPng, path.join(dist, 'icon.png'));
}

const hljs = path.join(root, 'node_modules', 'highlight.js', 'styles');
for (const f of ['github.css', 'github-dark.css']) {
  try {
    fs.copyFileSync(path.join(hljs, f), path.join(distCss, f));
  } catch (err) {
    console.warn('skip hljs style: ' + f);
  }
}

console.log('assets copied -> dist/');