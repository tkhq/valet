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
  PIVOT_COORDINATOR_PERSONA,
  RECONCILE_PERSONA,
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
      "reconcile",
      "pivot-coordinator",
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

describe("pivot-coordinator persona (v1 spec, Part 05)", () => {
  it("loads non-empty markdown, names discover and resolve modes, and forbids findings", () => {
    const persona = bundledPersona(PIVOT_COORDINATOR_PERSONA);
    expect(persona).not.toBeNull();
    const md = persona!.roleMarkdown;
    expect(md.length).toBeGreaterThan(400);
    // Two modes.
    expect(md).toMatch(/discover mode/i);
    expect(md).toMatch(/resolve mode/i);
    // Auto-catalog patterns it MAY execute (three L3 + two L4 named in the role).
    expect(md).toContain("scope-auto-include");
    expect(md).toContain("propagate-session");
    expect(md).toContain("rerun-with-existing-loot");
    // It reports NO findings; the role's Forbidden section lists that rule.
    expect(md).toMatch(/emit(ting)? findings/i);
    // The two virtual paths it writes.
    expect(md).toContain("/pivot.yml");
    expect(md).toContain("/human_setup_ask.md");
  });

  it("is not in LIVE_PERSONAS (it does not act against the target)", () => {
    expect(isLivePersona(PIVOT_COORDINATOR_PERSONA)).toBe(false);
  });
});

describe("reconcile persona (re-scan v2)", () => {
  it("loads non-empty and names the three paths and the fixed/recurring outcomes", () => {
    const persona = bundledPersona(RECONCILE_PERSONA);
    expect(persona).not.toBeNull();
    const md = persona!.roleMarkdown;
    expect(md.length).toBeGreaterThan(400);
    // The three incremental paths.
    expect(md).toMatch(/unchanged/i); // carried finding, file unchanged
    expect(md).toMatch(/in the diff|changed/i); // carried finding, file changed
    expect(md).toMatch(/new/i); // new vulns are the sweeps' job, not reconcile
    // The two outcomes.
    expect(md).toMatch(/\bfixed\b/i);
    expect(md).toMatch(/recurring/i);
    // It uses the review tool and reports no new findings.
    expect(md).toContain("sec_finding_review");
    expect(md).toMatch(/no.*new finding|report NO|report no/i);
  });
});
