/**
 * Template starter access. Starters are static assets in this package
 * (`templates/<name>/starter.dc.html` + `prompt.md`) — fixed for v1 per
 * spec Decision 7. The path resolves relative to this module so it works
 * from both `src/` (tests, tsx dev) and `dist/` (built plugin): both sit
 * one directory below the package root's sibling `templates/`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_TEMPLATES, isDesignTemplate, type DesignTemplate } from "./dc-html.js";

function templatePath(template: DesignTemplate, file: string): string {
  return fileURLToPath(new URL(`../../templates/${template}/${file}`, import.meta.url));
}

export interface TemplateStarter {
  template: DesignTemplate;
  /** The starter .dc.html document. */
  starter: string;
  /** Authoring guidance injected into the design session's first turn. */
  prompt: string;
}

export function listTemplates(): readonly DesignTemplate[] {
  return DESIGN_TEMPLATES;
}

/**
 * Read a template's starter file and prompt. Throws with a corrective
 * message for unknown template names.
 */
export function readTemplateStarter(template: string): TemplateStarter {
  if (!isDesignTemplate(template)) {
    throw new Error(
      `Unknown design template "${template}". Valid templates: ${DESIGN_TEMPLATES.join(", ")}.`,
    );
  }
  return {
    template,
    starter: readFileSync(templatePath(template, "starter.dc.html"), "utf8"),
    prompt: readFileSync(templatePath(template, "prompt.md"), "utf8"),
  };
}
