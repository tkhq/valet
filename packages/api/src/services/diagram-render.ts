/**
 * `render_diagram`: render Mermaid source to a PNG in the session sandbox and
 * save it as a thread file, the store `file_attach` writes. The web chat shows
 * the PNG inline; a Slack turn posts it with `slack.reply_file_to_origin`.
 *
 * The render runs in the sandbox, not the api: Mermaid lays out text through a
 * browser, and every sandbox image ships Chromium (`valet-chromium` on the
 * kubernetes image, `chromium` on the docker image). mermaid-cli comes from
 * npm on first use and stays in the sandbox's npm cache after that.
 */
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { sniffImageMediaType, type ToolDef } from "@valet/engine";
import { attachResultText, generatedFileOrigin } from "./generated-files.js";

/** Pinned so a new mermaid-cli release cannot change renders without a code change. */
export const MERMAID_CLI_PACKAGE = "@mermaid-js/mermaid-cli@11.17.0";
export const DIAGRAM_SOURCE_LIMIT = 50_000;
/** The first render downloads mermaid-cli, so it gets more time than a cached one needs. */
const RENDER_TIMEOUT_MS = 180_000;
const OUTPUT_DIR = "/workspace/diagrams";

/** Exit codes the render script uses for a missing tool, so the error names the fix. */
const NO_BROWSER_EXIT = 64;
const NO_NPX_EXIT = 65;

/** A filename stem from the caller's name or title: lowercase words joined by dashes. */
export function diagramFileStem(label: string | undefined, source: string): string {
  const slug = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "diagram";
  return `${slug}-${createHash("sha256").update(source).digest("hex").slice(0, 8)}`;
}

/** The shell script that renders `dir/in.mmd` and prints the PNG path as its last line. */
export function diagramRenderScript(dir: string, stem: string): string {
  return [
    "set -e",
    `dir='${dir}'`,
    `out_dir='${OUTPUT_DIR}'`,
    // A sandbox without the working directory keeps the PNG next to its source.
    'mkdir -p "$out_dir" 2>/dev/null || out_dir="$dir"',
    `out="$out_dir/${stem}.png"`,
    'chrome="$(command -v valet-chromium || command -v chromium || command -v chromium-browser || command -v google-chrome || true)"',
    `if [ -z "$chrome" ]; then echo "no Chromium in this sandbox" >&2; exit ${NO_BROWSER_EXIT}; fi`,
    `if ! command -v npx >/dev/null 2>&1; then echo "no npx in this sandbox" >&2; exit ${NO_NPX_EXIT}; fi`,
    `printf '{"executablePath":"%s","args":["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"]}' "$chrome" > "$dir/puppeteer.json"`,
    `PUPPETEER_SKIP_DOWNLOAD=1 npx --yes ${MERMAID_CLI_PACKAGE} --quiet -i "$dir/in.mmd" -o "$out" -p "$dir/puppeteer.json" -b white -s 2`,
    'echo "$out"',
  ].join("\n");
}

function renderError(exitCode: number, stderr: string, timedOut: boolean | undefined): string {
  if (timedOut) return "The diagram render timed out. Simplify the diagram, or retry once: the first render downloads mermaid-cli.";
  if (exitCode === NO_BROWSER_EXIT) return "This sandbox has no Chromium, so it cannot render diagrams. Send the Mermaid source in a ```mermaid code block instead.";
  if (exitCode === NO_NPX_EXIT) return "This sandbox has no npx, so it cannot install mermaid-cli. Send the Mermaid source in a ```mermaid code block instead.";
  const detail = stderr.trim().split("\n").slice(-12).join("\n").slice(-1500);
  return `Mermaid could not render the diagram. Fix the source and retry. If npm could not download ${MERMAID_CLI_PACKAGE}, the sandbox has no network access; send a \`\`\`mermaid code block instead.\n${detail}`;
}

export function buildDiagramRenderTool(configuredPublicUrl?: string): ToolDef {
  const publicOrigin = generatedFileOrigin(configuredPublicUrl);
  const parameters = Type.Object({
    source: Type.String({ minLength: 1, maxLength: DIAGRAM_SOURCE_LIMIT, description: "Mermaid source: flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, pie, and the other Mermaid types." }),
    alt: Type.String({ minLength: 1, maxLength: 1000, description: "What the diagram shows, for screen readers and Slack alt text." }),
    title: Type.Optional(Type.String({ maxLength: 255, description: "A short caption, also the PNG filename." })),
  });
  const tool: ToolDef<typeof parameters> = {
    name: "render_diagram",
    description: "Render a Mermaid diagram to a PNG and show it inline in the chat, saved as a download in this thread. Use it when a person needs the diagram as an image: for Slack, which cannot draw Mermaid, or to download. In the web chat alone, a ```mermaid code block already draws the diagram.",
    parameters,
    execute: async ({ source, alt, title }, ctx) => {
      if (!source.trim()) return { text: "The diagram source is empty. Send Mermaid source and retry.", ok: false };
      if (!ctx.threadFiles) return { text: "This run cannot save files to the thread, so it cannot show a rendered diagram. Send a ```mermaid code block instead.", ok: false };
      const dir = `/tmp/valet-diagram-${randomUUID()}`;
      const stem = diagramFileStem(title, source);
      try {
        await ctx.sandbox.mkdir(dir);
        await ctx.sandbox.writeFile(`${dir}/in.mmd`, source);
        const result = await ctx.sandbox.exec(diagramRenderScript(dir, stem), { timeout: RENDER_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
        if (result.exitCode !== 0 || result.timedOut) return { text: renderError(result.exitCode, result.stderr, result.timedOut), ok: false };
        const path = result.stdout.trim().split("\n").at(-1) ?? "";
        const data = await ctx.sandbox.readBinary(path);
        if (sniffImageMediaType(data) !== "image/png") return { text: "The render did not produce a PNG. Check the Mermaid source and retry.", ok: false };
        const file = await ctx.threadFiles.save({ name: `${stem}.png`, mimeType: "image/png", data });
        return { text: attachResultText(file, { path, alt, title, origin: ctx.origin, publicOrigin }), ok: true };
      } catch (error) {
        // The store's errors name their fix (a full store, an oversized file).
        return { text: error instanceof Error && error.message ? error.message : "Could not render the diagram. Retry render_diagram.", ok: false };
      } finally {
        await ctx.sandbox.rm(dir, { recursive: true }).catch(() => undefined);
      }
    },
  };
  return tool;
}
