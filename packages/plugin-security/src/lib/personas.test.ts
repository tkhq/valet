import { describe, expect, it } from "vitest";
import {
  ATTACK_TREE_PERSONA,
  bundledPersona,
  BUNDLED_PERSONAS,
  bundledPersonaIds,
  CODE_REVIEW_PERSONA,
  REPORT_PERSONA,
  DAST_PERSONA,
  EXPLOIT_PERSONA,
  FUZZ_PERSONA,
  isLivePersona,
  LIVE_PERSONAS,
  SAST_PERSONA,
  THREAT_MODEL_PERSONA,
} from "./personas.js";

describe("BUNDLED_PERSONAS", () => {
  it("registers the code-review, triad, model, report, and live personas", () => {
    expect(bundledPersonaIds()).toEqual([
      "code-review",
      "architect",
      "verifier",
      "threat-model",
      "attack-tree",
      "sast",
      "report",
      "dast",
      "fuzz",
      "exploit",
    ]);
  });

  it("the live personas (M-P4b) load and name authorized-scope discipline", () => {
    for (const id of [DAST_PERSONA, FUZZ_PERSONA, EXPLOIT_PERSONA]) {
      const persona = bundledPersona(id);
      expect(persona).not.toBeNull();
      expect(persona?.roleMarkdown.length).toBeGreaterThan(400);
      // Every live persona names the authorized scope and forbids acting outside it.
      expect(persona?.roleMarkdown.toLowerCase()).toContain("authorized scope");
      expect(persona?.roleMarkdown.toLowerCase()).toMatch(/running target|proof of concept/);
      expect(persona?.roleMarkdown).toContain("## Forbidden");
    }
    // The exploit persona holds the non-destructive READ/RESTORE rule.
    expect(bundledPersona(EXPLOIT_PERSONA)?.roleMarkdown).toMatch(/READ.*RESTORE/s);
  });

  it("isLivePersona flags exactly the live personas", () => {
    expect(LIVE_PERSONAS).toEqual(["dast", "fuzz", "exploit"]);
    expect(isLivePersona("dast")).toBe(true);
    expect(isLivePersona("fuzz")).toBe(true);
    expect(isLivePersona("exploit")).toBe(true);
    expect(isLivePersona("code-review")).toBe(false);
    expect(isLivePersona("sast")).toBe(false);
  });

  it("loads non-empty role markdown for every bundled persona", () => {
    for (const p of BUNDLED_PERSONAS) {
      expect(p.roleMarkdown.length).toBeGreaterThan(400);
      // The role frontmatter names the persona; the body is real guidance.
      expect(p.roleMarkdown).toContain(`name: ${p.id}`);
    }
  });

  it("grounds each model persona in its own contract", () => {
    expect(bundledPersona(THREAT_MODEL_PERSONA)?.roleMarkdown).toContain("STRIDE");
    expect(bundledPersona(ATTACK_TREE_PERSONA)?.roleMarkdown).toMatch(/AND\/OR|attack tree/i);
    expect(bundledPersona(SAST_PERSONA)?.roleMarkdown).toContain("scanner");
  });

  it("gives every model persona a display label", () => {
    for (const id of [THREAT_MODEL_PERSONA, ATTACK_TREE_PERSONA, SAST_PERSONA, REPORT_PERSONA]) {
      expect(bundledPersona(id)?.label).toBeTruthy();
    }
  });

  it("grounds the report persona in the report artifact tool", () => {
    expect(bundledPersona(REPORT_PERSONA)?.roleMarkdown).toContain("sec_report_write");
  });

  it("returns null for an unknown persona id", () => {
    expect(bundledPersona("nope")).toBeNull();
    // A known one round-trips.
    expect(bundledPersona(CODE_REVIEW_PERSONA)?.id).toBe(CODE_REVIEW_PERSONA);
  });
});
