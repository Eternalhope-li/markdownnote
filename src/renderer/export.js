const { getState } = require('./state');
const doc = require('./doc');
const preview = require('./preview');
const hljsCss = require('highlight.js/styles/github.css');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function currentName(ext) {
  const name = (getState().currentPath || '笔记').split(/[\\/]/).pop().replace(/\.(md|markdown|txt)$/i, '');
  return name + '.' + ext;
}

function buildStandaloneHtml() {
  const content = doc.getDoc();
  const { html } = preview.render(content);
  const clean = html.replace(/\sdata-line="\d+"/g, '');
  const current = getState().notes.find(n => n.path === getState().currentPath);
  const title = (current && current.title) || 'MarkdownNote 导出';
  const htmlDoc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { max-width: 820px; margin: 0 auto; padding: 32px 20px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.7; color: #24292f; }
h1, h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto; }
code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-family: Consolas, monospace; }
pre code { background: transparent; padding: 0; }
table { border-collapse: collapse; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; }
blockquote { border-left: 4px solid #0969da; margin: 0; padding: 2px 12px; color: #57606a; background: #f6f8fa; }
img { max-width: 100%; }
.task-checkbox { margin-right: 4px; }
@media print { body { padding: 0; max-width: none; } }
${hljsCss}
</style>
</head>
<body>
${clean}
</body>
</html>`;
  return htmlDoc;
}

async function exportHtml() {
  const p = await window.api.saveFileDialog(currentName('html'));
  if (!p) return;
  await window.api.writeFile(p, buildStandaloneHtml());
}

async function exportPdf() {
  const p = await window.api.exportPdf({ html: buildStandaloneHtml(), defaultName: currentName('pdf') });
  if (p) console.log('PDF 已导出:', p);
}

async function exportPng() {
  const p = await window.api.exportPng({ html: buildStandaloneHtml(), defaultName: currentName('png') });
  if (p) console.log('PNG 已导出:', p);
}

async function printDoc() {
  await window.api.printDoc({ html: buildStandaloneHtml() });
}

module.exports = { exportHtml, exportPdf, exportPng, printDoc };