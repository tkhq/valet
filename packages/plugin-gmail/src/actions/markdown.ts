import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
});

// Keep the Docs parser configuration while preserving visible newlines from
// existing plain-text bodies. This affects only Markdown soft breaks; blank
// lines, headings, lists, and other block syntax keep their normal semantics.
parser.renderer.rules.softbreak = () => '<br>\n';

/** Render an email body as safe HTML while preserving the Markdown source separately. */
export function renderMarkdownToHtml(markdown: string): string {
  return parser.render(markdown);
}
