import { describe, expect, it } from "vitest";
import { KNOWN_PLAYBOOKS, isKnownPlaybook, playbookMarkdown } from "./playbooks.js";

describe("playbooks", () => {
  it("has one playbook per preset cell", () => {
    expect([...KNOWN_PLAYBOOKS]).toEqual([
      "recon",
      "authz",
      "injection",
      "secrets-config",
      "verify",
      "threat-model",
      "attack-tree",
      "sast",
    ]);
  });

  it("loads every known playbook with framework grounding and evidence guidance", () => {
    for (const name of KNOWN_PLAYBOOKS) {
      const md = playbookMarkdown(name);
      expect(md.length).toBeGreaterThan(400);
      // Each playbook cites the standards it draws from, not invented advice.
      expect(md).toContain("Frameworks:");
      expect(md).toMatch(/OWASP|CWE|ASVS|CVSS/);
    }
    // Category-specific grounding is present where it belongs.
    expect(playbookMarkdown("authz")).toContain("BOLA");
    expect(playbookMarkdown("injection")).toContain("CWE-89");
    expect(playbookMarkdown("secrets-config")).toContain("gitleaks");
    expect(playbookMarkdown("verify")).toContain("CVSS");
    // The M-P2c model playbooks cite their frameworks.
    expect(playbookMarkdown("threat-model")).toContain("STRIDE");
    expect(playbookMarkdown("threat-model")).toContain("LINDDUN");
    expect(playbookMarkdown("attack-tree")).toMatch(/attack tree|ATT&CK|kill chain/i);
    expect(playbookMarkdown("sast")).toContain("CWE-89");
    expect(playbookMarkdown("sast")).toContain("gitleaks");
  });

  it("isKnownPlaybook gates names", () => {
    expect(isKnownPlaybook("authz")).toBe(true);
    expect(isKnownPlaybook("nope")).toBe(false);
  });

  it("throws a corrective error on an unknown name", () => {
    expect(() => playbookMarkdown("nope")).toThrow(/Unknown playbook "nope"/);
  });
});
