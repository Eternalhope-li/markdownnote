let notes = [];
const contentCache = new Map(); // 搜索内容缓存：按需读取，避免列表加载时全量读取

function rebuild(list) { notes = list || []; contentCache.clear(); }
function init(list) { notes = list || []; }
function cacheNote(path, content) {
  if (path) contentCache.set(path, content);
}

async function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const n of notes) {
    let content = contentCache.get(n.path);
    if (content === undefined) {
      try { content = await window.api.readFile(n.path); } catch { content = ''; }
      contentCache.set(n.path, content);
    }
    const lower = content.toLowerCase();
    let score = 0;
    let snippet = '';
    const nameHit = n.name.toLowerCase().includes(q);
    const titleHit = (n.title || '').toLowerCase().includes(q);
    const tagHit = (n.tags || []).some(t => t.toLowerCase().includes(q));
    if (nameHit) score += 200;
    if (titleHit) score += 150;
    if (tagHit) score += 100;
    const idx = lower.indexOf(q);
    if (idx >= 0) {
      let count = 0;
      let i = -1;
      while ((i = lower.indexOf(q, i + 1)) !== -1) count++;
      score += Math.min(count, 20) * 5;
      snippet = (idx > 30 ? '…' : '') + content.slice(Math.max(0, idx - 30), idx + 80).replace(/\n/g, ' ') + (idx + 80 < content.length ? '…' : '');
    }
    if (score > 0) {
      results.push({ path: n.path, name: n.name, title: n.title, tags: n.tags, score, snippet });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 20);
}

module.exports = { init, rebuild, search, cacheNote };