import { describe, expect, it } from "vitest";
import { KNOWN_SCANNERS, isKnownScanner } from "./scanners.js";

describe("KNOWN_SCANNERS", () => {
  it("names the eight scanners the preflight probe installs or checks", () => {
    expect(KNOWN_SCANNERS).toEqual([
      "gitleaks",
      "semgrep",
      "trufflehog",
      "bandit",
      "gosec",
      "brakeman",
      "eslint",
      "cargo-audit",
    ]);
  });

  it("accepts a bare scanner name", () => {
    expect(isKnownScanner("gitleaks")).toBe(true);
    expect(isKnownScanner("cargo-audit")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKnownScanner("Semgrep")).toBe(true);
    expect(isKnownScanner("GOSEC")).toBe(true);
  });

  it("matches on the first token, so a rule pack or version suffix passes", () => {
    expect(isKnownScanner("semgrep p/owasp-top-ten")).toBe(true);
    expect(isKnownScanner("gitleaks 8.18.0")).toBe(true);
    expect(isKnownScanner("  eslint  --config .eslintrc  ")).toBe(true);
  });

  it("rejects an unknown tool", () => {
    expect(isKnownScanner("nmap")).toBe(false);
    expect(isKnownScanner("my-scanner")).toBe(false);
    expect(isKnownScanner("")).toBe(false);
  });
});
