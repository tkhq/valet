import type {
  BrowserCellReceipt,
  BrowserObservation,
  SourceInput,
} from "@valet/shared";

/**
 * Sources for the pages a browser cell read. A page read is an accessibility
 * observation (`tab.getAXState`, `tab.getAXStateAndScreenshot`); its receipt
 * holds the page URL without a query, the title, and the snapshot text.
 * Navigation, clicks, and screenshots alone read no page text. A receipt
 * whose result the daemon left out to fit its size limit gives no source.
 */
export function pageSources(cell: BrowserCellReceipt): SourceInput[] {
  const sources: SourceInput[] = [];
  const seen = new Set<string>();
  for (const operation of cell.operations) {
    if (operation.status !== "completed") continue;
    const result: unknown =
      operation.method === "tab.getAXStateAndScreenshot" &&
      typeof operation.result === "object" &&
      operation.result !== null &&
      "observation" in operation.result
        ? operation.result.observation
        : operation.method === "tab.getAXState"
          ? operation.result
          : undefined;
    const page = observation(result);
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    const excerpt = pageExcerpt(page.text);
    sources.push({
      service: "web",
      title: page.title.trim() || new URL(page.url).host,
      url: page.url,
      ...(excerpt ? { snippet: excerpt } : {}),
      ...(Number.isFinite(page.capturedAt)
        ? {
            location: `Read ${new Date(page.capturedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
          }
        : {}),
    });
  }
  return sources;
}

function observation(
  value: unknown,
): Pick<BrowserObservation, "url" | "title" | "text" | "capturedAt"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const url: unknown = Reflect.get(value, "url");
  const title: unknown = Reflect.get(value, "title");
  const text: unknown = Reflect.get(value, "text");
  const capturedAt: unknown = Reflect.get(value, "capturedAt");
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url))
    return undefined;
  return {
    url,
    title: typeof title === "string" ? title : "",
    text: typeof text === "string" ? text : "",
    capturedAt: typeof capturedAt === "number" ? capturedAt : Number.NaN,
  };
}

/**
 * The readable text at the start of an accessibility snapshot: element
 * names and text values, without roles, references, or properties.
 * `- heading "Pricing" [level=1] [ref=e3]` gives "Pricing".
 */
export function pageExcerpt(snapshot: string): string {
  const parts: string[] = [];
  let length = 0;
  for (const line of snapshot.split("\n")) {
    const item = line.trim().replace(/^-\s*/, "");
    if (!item || item.startsWith("/")) continue;
    const name = /^[\w-]+\s+"((?:[^"\\]|\\.)*)"/.exec(item)?.[1];
    const value =
      /\]:\s+(.+)$/.exec(item)?.[1] ?? /^[\w-]+:\s+(.+)$/.exec(item)?.[1];
    for (const part of [name, value]) {
      const text = part?.replace(/\\"/g, '"').trim();
      if (!text || parts[parts.length - 1] === text) continue;
      parts.push(text);
      length += text.length + 1;
    }
    if (length >= 300) break;
  }
  return parts.join(" ");
}
