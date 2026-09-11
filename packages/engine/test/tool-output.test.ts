import { describe, expect, it } from "vitest";
import { encodeToolOutput } from "../src/tool-output.js";

describe("encodeToolOutput", () => {
  it("returns TOON for structured data", () => {
    expect(encodeToolOutput({ items: [{ id: 1 }] })).toBe("items[1]{id}:\n  1");
  });

  it("falls back to pretty JSON when TOON encoding throws", () => {
    let calls = 0;
    const data = {
      toJSON() {
        calls += 1;
        if (calls === 1) throw new Error("TOON failure");
        return { ok: true };
      },
    };
    expect(encodeToolOutput(data)).toBe('{\n  "ok": true\n}');
  });
});
