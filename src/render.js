import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const md = new MarkdownIt({
  html: false, // don't allow raw HTML — content may come from AI conversations
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    // Mermaid diagrams: emit a raw block for the client to render into SVG.
    // markdown-it escapes the text so it's safe; mermaid reads textContent.
    if (lang === 'mermaid') {
      return '<pre class="mermaid">' + md.utils.escapeHtml(str) + '</pre>';
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>';
      } catch { /* fall through */ }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  },
});

/** Render a markdown body string to HTML. */
export function renderMarkdown(body) {
  return md.render(body || '');
}
