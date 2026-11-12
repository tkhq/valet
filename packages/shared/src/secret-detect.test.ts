import { describe, expect, it } from "vitest";
import { detectSecrets, maskSecret, replaceSecrets } from "./secret-detect.js";

const OPENAI = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";
const ANTHROPIC = "sk-ant-api03-" + "x".repeat(40);
const GITHUB = "ghp_" + "A".repeat(36);

describe("detectSecrets", () => {
  it("finds known key formats with a suggested name", () => {
    const found = detectSecrets(`use ${OPENAI} and ${GITHUB} please`);
    expect(found.map((c) => [c.suggestedName, c.confidence])).toEqual([
      ["OPENAI_API_KEY", "known"],
      ["GITHUB_TOKEN", "known"],
    ]);
    expect(found[0]!.value).toBe(OPENAI);
  });

  it("names an Anthropic key as Anthropic, not OpenAI", () => {
    const [found] = detectSecrets(`key: ${ANTHROPIC}`);
    expect(found?.suggestedName).toBe("ANTHROPIC_API_KEY");
    expect(detectSecrets(`key: ${ANTHROPIC}`)).toHaveLength(1);
  });

  it("finds an assignment by its variable name and takes the name from it", () => {
    const [found] = detectSecrets('export ACME_API_TOKEN="q8w7e6r5t4y3u2i1"');
    expect(found).toMatchObject({ suggestedName: "ACME_API_TOKEN", value: "q8w7e6r5t4y3u2i1", confidence: "assigned" });
  });

  it("finds a PEM private key", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(detectSecrets(`here\n${pem}\nthanks`)[0]?.suggestedName).toBe("PRIVATE_KEY");
  });

  it("ignores commit SHAs, UUIDs, references, and short values", () => {
    const text = [
      "commit 3f9a2c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b",
      "id 550e8400-e29b-41d4-a716-446655440000",
      "OPENAI_API_KEY=secret://personal/OPENAI_API_KEY",
      "GH_TOKEN=$GH_TOKEN",
      "API_KEY=short",
      "sk-tooshort",
    ].join("\n");
    expect(detectSecrets(text)).toEqual([]);
  });
});

describe("replaceSecrets and maskSecret", () => {
  it("replaces each candidate and keeps the rest of the text", () => {
    const text = `a ${OPENAI} b ${GITHUB} c`;
    const found = detectSecrets(text);
    expect(replaceSecrets(text, found.map((candidate) => ({ candidate, with: `<${candidate.suggestedName}>` })))).toBe(
      "a <OPENAI_API_KEY> b <GITHUB_TOKEN> c",
    );
  });

  it("shows the ends of a long value only", () => {
    expect(maskSecret(OPENAI)).toBe("sk-p…s9T0");
    expect(maskSecret("short")).toBe("•••••");
  });
});
