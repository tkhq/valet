import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
});

/** Render an email body as safe HTML while preserving the Markdown source separately. */
export function renderMarkdownToHtml(markdown: string): string {
  return parser.render(markdown);
}
