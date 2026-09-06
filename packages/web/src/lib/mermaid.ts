import type { MermaidConfig } from "mermaid";

export type MermaidTheme = "default" | "dark";

const SAFE_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: 100_000,
  secure: [
    "securityLevel",
    "startOnLoad",
    "suppressErrorRendering",
    "htmlLabels",
    "flowchart",
    "themeCSS",
    "themeVariables",
    "maxTextSize",
  ],
};

let renderQueue = Promise.resolve();
let mermaidModule: Promise<typeof import("mermaid")> | undefined;

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidModule ??= import("mermaid");
  return mermaidModule;
}

/**
 * Render one untrusted Mermaid source with strict Mermaid settings.
 * Mermaid configuration is global, so renders run in sequence to stop
 * concurrent light and dark diagrams from changing each other's theme.
 */
export function renderMermaid(source: string, id: string, theme: MermaidTheme): Promise<string> {
  const render = async (): Promise<string> => {
    const { default: mermaid } = await loadMermaid();
    mermaid.initialize({ ...SAFE_CONFIG, theme });
    const { svg } = await mermaid.render(id, source);
    return sanitizeMermaidSvg(svg);
  };
  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Remove executable and remote-loading SVG features after Mermaid's strict
 * renderer runs. This is a second boundary before the SVG enters app DOM.
 */
export function sanitizeMermaidSvg(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new Error("Mermaid returned invalid SVG.");
  }

  const executable = root.querySelectorAll(
    "script,foreignObject,iframe,object,embed,image,video,audio,link,animate,animateMotion,animateTransform,set,mpath",
  );
  for (const element of executable) element.remove();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        /^(?:javascript|data\s*:\s*text\/html)/i.test(value) ||
        ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) ||
        (name === "style" && /(?:@import|url\s*\(|image-set\s*\(|https?:|data:|\/\/)/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of root.querySelectorAll("style")) {
    if (/(?:@import|url\s*\(|image-set\s*\(|https?:|data:|\/\/)/i.test(style.textContent ?? "")) {
      style.remove();
    }
  }
  return new XMLSerializer().serializeToString(root);
}
