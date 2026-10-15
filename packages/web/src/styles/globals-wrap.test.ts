import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Ids, URLs, hashes and emails overflowed cards and popovers across the app
// until the body broke an unbroken word that would overflow its line.
describe("globals.css", () => {
  it("breaks an unbroken word that would overflow its line", () => {
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
    const body = css.match(/\n {2}body \{([^}]*)\}/)?.[1] ?? "";
    expect(body).toContain("overflow-wrap: break-word;");
  });
});
