import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDestination, type Destination, type DestinationInput } from "./destination.js";

interface Vector {
  name: string;
  input: DestinationInput;
  expected: Destination;
}

function isDestinationShaped(value: unknown): value is Destination {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "target" || kind === "key" || kind === "skip";
}

function isVectorArray(value: unknown): value is Vector[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== "object" || row === null) return false;
      const candidate = row as Record<string, unknown>;
      return (
        typeof candidate.name === "string" &&
        typeof candidate.input === "object" &&
        candidate.input !== null &&
        isDestinationShaped(candidate.expected)
      );
    })
  );
}

const vectorsPath = fileURLToPath(new URL("./destination.vectors.json", import.meta.url));
const parsed: unknown = JSON.parse(readFileSync(vectorsPath, "utf8"));
if (!isVectorArray(parsed)) {
  throw new Error("destination.vectors.json does not hold an array of { name, input, expected } rows.");
}
const vectors = parsed;

describe("resolveDestination", () => {
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(resolveDestination(vector.input)).toEqual(vector.expected);
    });
  }
});
