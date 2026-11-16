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
  const row = value as Record<string, unknown>;
  if (row.kind === "target") {
    return typeof row.sessionId === "string" && typeof row.threadId === "string" && typeof row.reason === "string";
  }
  if (row.kind === "key") {
    return (
      typeof row.key === "string" &&
      typeof row.title === "string" &&
      typeof row.reason === "string" &&
      (row.note === undefined || typeof row.note === "string")
    );
  }
  if (row.kind === "skip") {
    return typeof row.reason === "string" && row.reason.startsWith("claimed by thread ");
  }
  return false;
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

// The vectors format can assert a return value, not a throw. These two
// malformed-input cases (Part A forbids them in practice; the type system
// cannot) go beside the vector walk instead.
describe("resolveDestination's throw paths", () => {
  it("throws for a new-mode subscription rule with no event", () => {
    const input: DestinationInput = {
      rule: { id: "rule-x", kind: "subscription", name: "No event", policy: { mode: "new" } },
      binding: null,
      claim: null,
    };
    expect(() => resolveDestination(input)).toThrow("A new-mode destination for an event needs the event.");
  });

  it("throws for a new-mode schedule rule with no fireAt", () => {
    const input: DestinationInput = {
      rule: { id: "sched-x", kind: "schedule", name: "No fire time", policy: { mode: "new" } },
      binding: null,
      claim: null,
    };
    expect(() => resolveDestination(input)).toThrow("A new-mode destination for a schedule needs fireAt.");
  });
});

describe("new-mode keys across deliveries", () => {
  const rule: DestinationInput["rule"] = { id: "rule-msg", kind: "subscription", name: "Deploy questions", policy: { mode: "new" } };
  const at = (event: NonNullable<DestinationInput["event"]>) => resolveDestination({ rule, event, binding: null, claim: null });
  const base = { summary: "s", naturalSubject: null, conversational: false };

  it("gives a retry of one delivery the same key (INV-D4)", () => {
    const event = { ...base, deliveryId: "del-1", conversationKey: "slack:C1:1712345678.000100" };
    expect(at(event)).toEqual(at({ ...event }));
  });

  it("keeps one key per delivery for an event with no channel conversation", () => {
    const first = at({ ...base, deliveryId: "del-1" });
    const second = at({ ...base, deliveryId: "del-2" });
    expect(first).toMatchObject({ kind: "key", key: "sub:rule-msg:del-1" });
    expect(second).toMatchObject({ kind: "key", key: "sub:rule-msg:del-2" });
  });

  it("gives two Slack threads in one channel two keys", () => {
    const one = at({ ...base, deliveryId: "del-1", conversationKey: "slack:C1:1712345678.000100" });
    const two = at({ ...base, deliveryId: "del-2", conversationKey: "slack:C1:1712349999.000200" });
    expect(one).not.toEqual(two);
  });
});
