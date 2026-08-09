const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(content) {
  const m = FM_RE.exec(content);
  if (!m) return { title: null, tags: [], meta: {}, body: content };
  const meta = {};
  const tags = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'tags') {
      const arr = value.replace(/^\[|\]$/g, '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      tags.push(...arr);
    } else {
      meta[key] = value;
    }
  }
  return { title: meta.title || null, tags, meta, body: content.slice(m[0].length) };
}

function setTagsInContent(content, tags) {
  const m = FM_RE.exec(content);
  const tagLine = 'tags: [' + tags.join(', ') + ']';
  if (!m) {
    return '---\n' + tagLine + '\n---\n\n' + content;
  }
  let hasTags = false;
  const next = m[1].split(/\r?\n/).map((line) => {
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (kv && kv[1].trim().toLowerCase() === 'tags') {
      hasTags = true;
      return tagLine;
    }
    return line;
  });
  if (!hasTags) next.push(tagLine);
  return '---\n' + next.join('\n') + '\n---' + content.slice(m[0].length);
}

function getFrontmatterRaw(content) {
  const m = FM_RE.exec(content);
  return m ? m[0] : '';
}

module.exports = { parseFrontmatter, setTagsInContent, getFrontmatterRaw };