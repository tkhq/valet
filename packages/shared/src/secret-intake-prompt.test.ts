import { describe, expect, it } from "vitest";
import { parseIntakeVerdicts } from "./secret-intake-prompt.js";

describe("parseIntakeVerdicts", () => {
  it("reads one verdict per candidate from a fenced answer", () => {
    const answer = '```json\n{"results":[{"i":1,"secret":false},{"i":0,"secret":true,"provider":"hetzner"}]}\n```';
    expect(parseIntakeVerdicts(answer, 2)).toEqual([{ secret: true, provider: "hetzner" }, { secret: false }]);
  });

  it("drops a provider that names no provider, so the secret is not named after it", () => {
    const answer = '{"results":[{"i":0,"secret":true,"provider":"unknown"},{"i":1,"secret":true,"provider":"N/A"},{"i":2,"secret":true,"provider":null}]}';
    expect(parseIntakeVerdicts(answer, 3)).toEqual([{ secret: true }, { secret: true }, { secret: true }]);
  });

  it("leaves a candidate undefined when the answer is unreadable or out of range", () => {
    expect(parseIntakeVerdicts("not json", 1)).toEqual([undefined]);
    expect(parseIntakeVerdicts('{"results":[{"i":3,"secret":true}]}', 1)).toEqual([undefined]);
  });
});
