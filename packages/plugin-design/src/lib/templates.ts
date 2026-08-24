/**
 * Template starter access. Starters are static assets in this package
 * (`templates/<name>/starter.dc.html` + `prompt.md`) — fixed for v1 per
 * spec Decision 7.
 *
 * Every read below is a module-load `readFileSync(fileURLToPath(new
 * URL("<literal>", import.meta.url)), "utf8")` — the EXACT shape the api
 * bundle's inline-assets plugin rewrites to a string literal. Do NOT
 * refactor these into a loop or a path helper: a dynamic path resolves
 * against the single-file bundle's own location at runtime and every
 * design-session create would 500 with ENOENT in bundle deploys. In dev
 * (tsx from src/) and in dist/ builds the relative path resolves to the
 * package's templates/ directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_TEMPLATES, isDesignTemplate, type DesignTemplate } from "./dc-html.js";

export interface TemplateStarter {
  template: DesignTemplate;
  /** The starter .dc.html document. */
  starter: string;
  /** Authoring guidance for the design session (injected as system
   * context at session build — see the api host's design wiring). */
  prompt: string;
}

const STARTERS: Record<DesignTemplate, { starter: string; prompt: string }> = {
  blank: {
    starter: readFileSync(fileURLToPath(new URL("../../templates/blank/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/blank/prompt.md", import.meta.url)), "utf8"),
  },
  document: {
    starter: readFileSync(fileURLToPath(new URL("../../templates/document/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/document/prompt.md", import.meta.url)), "utf8"),
  },
  slides: {
    starter: readFileSync(fileURLToPath(new URL("../../templates/slides/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/slides/prompt.md", import.meta.url)), "utf8"),
  },
  wireframe: {
    starter: readFileSync(fileURLToPath(new URL("../../templates/wireframe/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/wireframe/prompt.md", import.meta.url)), "utf8"),
  },
  resume: {
    starter: readFileSync(fileURLToPath(new URL("../../templates/resume/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/resume/prompt.md", import.meta.url)), "utf8"),
  },
  "html-email": {
    starter: readFileSync(fileURLToPath(new URL("../../templates/html-email/starter.dc.html", import.meta.url)), "utf8"),
    prompt: readFileSync(fileURLToPath(new URL("../../templates/html-email/prompt.md", import.meta.url)), "utf8"),
  },
};

export function listTemplates(): readonly DesignTemplate[] {
  return DESIGN_TEMPLATES;
}

/**
 * Return a template's starter file and prompt. Throws with a corrective
 * message for unknown template names.
 */
export function readTemplateStarter(template: string): TemplateStarter {
  if (!isDesignTemplate(template)) {
    throw new Error(
      `Unknown design template "${template}". Valid templates: ${DESIGN_TEMPLATES.join(", ")}.`,
    );
  }
  return { template, ...STARTERS[template] };
}
