import { encode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { structuredResult } from "./types";

const value = { items: [{ id: "one", count: 2 }] };

describe("structuredResult", () => {
  it("decodes JSON and TOON to the same value", () => {
    expect(structuredResult({ text: JSON.stringify(value) })).toEqual(value);
    expect(structuredResult({ content: [{ type: "text", text: encode(value) }] })).toEqual(value);
  });

  it("uses JSON before TOON", () => {
    expect(structuredResult('{"items":[1]}')).toEqual({ items: [1] });
  });
});
