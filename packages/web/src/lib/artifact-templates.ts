import type { ArtifactFormatWire } from "@valet/api/wire";

export interface ArtifactTemplateSource {
  title: string;
  format: ArtifactFormatWire;
  content: string;
}

export interface ArtifactTemplate {
  id: "document" | "html-page";
  label: string;
  description: string;
  defaultTitle: string;
  build: (title: string) => ArtifactTemplateSource;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const documentTemplate: ArtifactTemplate = {
  id: "document",
  label: "Document",
  description: "A project brief with a problem, approach, and next steps.",
  defaultTitle: "Project brief",
  build: (title) => ({
    title,
    format: "markdown",
    content: `# ${title.replace(/[\\`*_{}\[\]<>()#!|]/g, "\\$&").replace(/[\r\n]+/g, " ")}

## Problem

Describe the problem, who it affects, and why it matters now.

## Approach

Explain the proposed solution. List the main decisions and the result you expect.

## Next steps

1. Confirm the goal and the people responsible.
2. Test the approach with a small example.
3. Review the result and decide what to change.
`,
  }),
};

const htmlPageTemplate: ArtifactTemplate = {
  id: "html-page",
  label: "HTML Page",
  description: "A styled page with an overview, approach, and next steps.",
  defaultTitle: "Project overview",
  build: (title) => ({
    title,
    format: "html",
    content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--artifact-bg, #ffffff); color: var(--artifact-fg, #16181d); font: 16px/1.65 system-ui, sans-serif; }
    main { max-width: 960px; margin: 0 auto; padding: clamp(24px, 6vw, 72px); }
    header { padding-bottom: 32px; border-bottom: 1px solid var(--artifact-line, #e3e5ea); }
    .eyebrow { color: var(--artifact-accent, #3d6b4f); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 12px 0; font-size: clamp(32px, 6vw, 60px); line-height: 1.1; letter-spacing: -.04em; }
    h2 { font-size: 22px; line-height: 1.3; }
    p { color: var(--artifact-muted, #5b6270); }
    .sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 24px; margin-top: 32px; }
    section { border: 1px solid var(--artifact-line, #e3e5ea); border-radius: 16px; padding: 24px; }
    ol { padding-left: 20px; }
    li { margin: 12px 0; }
    footer { margin-top: 32px; color: var(--artifact-muted, #5b6270); font-size: 14px; }
  </style>
</head>
<body>
  <main data-vdid="project-page">
    <header data-vdid="page-header">
      <span class="eyebrow" data-vdid="page-eyebrow">Project overview</span>
      <h1 data-vdid="page-title">${escapeHtml(title)}</h1>
      <p data-vdid="page-summary">Turn a clear goal into a plan your team can act on.</p>
    </header>
    <div class="sections" data-vdid="page-sections">
      <section data-vdid="problem-section">
        <h2 data-vdid="problem-title">The problem</h2>
        <p data-vdid="problem-copy">Describe who needs help, what blocks them, and why this work matters now.</p>
      </section>
      <section data-vdid="approach-section">
        <h2 data-vdid="approach-title">Our approach</h2>
        <p data-vdid="approach-copy">Explain the solution and the result you expect. Start with one useful change.</p>
      </section>
      <section data-vdid="next-steps-section">
        <h2 data-vdid="next-steps-title">Next steps</h2>
        <ol data-vdid="next-steps-list">
          <li data-vdid="next-step-1">Confirm the goal and owner.</li>
          <li data-vdid="next-step-2">Test a small example.</li>
          <li data-vdid="next-step-3">Review the result together.</li>
        </ol>
      </section>
    </div>
    <footer data-vdid="page-footer">Project brief · Ready for your next idea</footer>
  </main>
</body>
</html>`,
  }),
};

export const artifactTemplates: readonly ArtifactTemplate[] = [documentTemplate, htmlPageTemplate];
