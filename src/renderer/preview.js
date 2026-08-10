const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const { parseFrontmatter } = require('./frontmatter');

// markdown-it 任务列表插件：- [ ] / - [x] → checkbox
function taskListPlugin(md) {
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'inline') continue;
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === 'paragraph_close') j++;
      const next = tokens[j];
      if (!next || next.type !== 'list_item_close') continue;
      const m = /^\[([ xX])\]\s*/.exec(token.content);
      if (!m) continue;
      token.content = token.content.slice(m[0].length);
      const checked = m[1].toLowerCase() === 'x';
      const input = new state.Token('html_inline', '', 0);
      input.content = '<input class="task-checkbox" type="checkbox"' + (checked ? ' checked' : '') + '>';
      const kids = token.children;
      if (kids && kids.length && kids[0].type === 'text') {
        kids[0].content = kids[0].content.slice(m[0].length);
        if (!kids[0].content) kids.shift();
      }
      if (kids) kids.unshift(input);
    }
  });
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight(code, lang) {
    // 去掉围栏内容末尾的换行：否则重载后代码块尾部多一个幽灵空行（WYSIWYG 无此现象）
    const c = String(code).replace(/\n$/, '');
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code class="language-' + md.utils.escapeHtml(lang) + '">' +
          hljs.highlight(c, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
      } catch (err) { /* fall through */ }
    }
    return '<pre class="hljs"><code class="language-' + md.utils.escapeHtml(lang || '') + '">' +
      md.utils.escapeHtml(c) + '</code></pre>';
  }
});
taskListPlugin(md);

// 给块级元素打上 data-line（markdown-it token.map 即源文件行号）
function withDataLine(ruleName) {
  const original = md.renderer.rules[ruleName];
  md.renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.map) token.attrSet('data-line', String(token.map[0]));
    return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

['heading_open', 'paragraph_open', 'blockquote_open', 'list_item_open', 'table_open', 'hr', 'fence', 'code_block'].forEach(withDataLine);

function render(content, opts) {
  const fm = parseFrontmatter(content);
  let html = '';
  if (fm.title && (!opts || opts.includeTitle !== false)) {
    html += '<h1 data-line="0">' + md.utils.escapeHtml(fm.title) + '</h1>\n';
  }
  html += md.render(fm.body);
  return { title: fm.title, tags: fm.tags, html };
}

module.exports = { render };