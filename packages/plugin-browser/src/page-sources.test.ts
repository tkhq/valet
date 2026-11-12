import { describe, expect, it } from "vitest";
import type { BrowserCellReceipt, BrowserOperationReceipt } from "@valet/shared";
import { pageExcerpt, pageSources } from "./page-sources.js";

function cell(operations: BrowserOperationReceipt[]): BrowserCellReceipt {
  return { cellId: "c", invocationId: "i", runtimeId: "r", threadId: "t", status: "completed", operations };
}
function read(method: string, result: unknown, status: BrowserOperationReceipt["status"] = "completed"): BrowserOperationReceipt {
  return { operationId: method, cellId: "c", method, hash: "h", status, result };
}
const page = (url: string, title = "Docs") => ({ url, title, text: '- heading "Install" [ref=e1]', capturedAt: 0 });

describe("pageSources", () => {
  it("reads observations from both observation methods and skips other receipts", () => {
    const sources = pageSources(cell([
      read("tab.getAXState", page("https://a.example/docs")),
      read("tab.getAXStateAndScreenshot", { observation: page("https://b.example/", "") , artifact: {} }),
      read("tab.title", "Not a page read"),
      read("tab.getAXState", page("https://c.example/"), "failed"),
      { operationId: "x", cellId: "c", method: "tab.getAXState", hash: "h", status: "completed", resultTruncated: true },
    ]));
    expect(sources).toEqual([
      { service: "web", title: "Docs", url: "https://a.example/docs", snippet: "Install", location: "Read 1970-01-01 00:00 UTC" },
      { service: "web", title: "b.example", url: "https://b.example/", snippet: "Install", location: "Read 1970-01-01 00:00 UTC" },
    ]);
  });
  it("lists a page once and refuses links that are not http(s)", () => {
    const sources = pageSources(cell([
      read("tab.getAXState", page("https://a.example/")),
      read("tab.getAXState", page("https://a.example/")),
      read("tab.getAXState", page("file:///etc/passwd")),
      read("tab.getAXState", page("about:blank")),
    ]));
    expect(sources.map(source => source.url)).toEqual(["https://a.example/"]);
  });
});

describe("pageExcerpt", () => {
  it("keeps names and text values without roles, references, or properties", () => {
    const snapshot = [
      "- generic [ref=e1]:",
      '  - heading "Example Domain" [level=1] [ref=e2]',
      "  - paragraph [ref=e3]: This domain is for examples.",
      '  - link "More \\"info\\"" [ref=e4] [cursor=pointer]:',
      "    - /url: https://www.iana.org/domains/example",
      "  - text: Footer",
    ].join("\n");
    expect(pageExcerpt(snapshot)).toBe('Example Domain This domain is for examples. More "info" Footer');
  });
  it("stops near 300 characters", () => {
    const snapshot = Array.from({ length: 50 }, (_, i) => `- paragraph [ref=e${i}]: ${"word ".repeat(10)}${i}`).join("\n");
    expect(pageExcerpt(snapshot).length).toBeLessThan(400);
  });
});
