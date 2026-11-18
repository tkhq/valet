import { describe, expect, it } from "vitest";
import { findSecretCandidates, shannonEntropy } from "./secret-candidates.js";

// Random values made for this test, not real keys.
const HETZNER = "q7Rk2PzW9vLmX4cT8bNe1JyH6uFa3GdS0oViKtYw5ZlQrBnMxCe7Ts2PjUh9Wd4A";
const SHA = "3f9c2b7e1a4d8f6c0b5e9a7d2c4f1e8b6a3d9c7e";
const UUID = "5d4c9a2e-7b1f-4e3a-9c8d-2f6b1a7e4c90";

const scored = (text: string, opts?: { credentialRequested?: boolean }) =>
  findSecretCandidates(text, opts).map((c) => ({ value: c.value, score: c.score }));

describe("findSecretCandidates", () => {
  it("flags a formatless key next to a provider name", () => {
    const [c] = findSecretCandidates(`here's my hetzner api key ${HETZNER} can you deploy`);
    expect(c).toMatchObject({ value: HETZNER, provider: "hetzner" });
    expect(c!.score).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps a commit SHA and a UUID below the prompt threshold without a credential word", () => {
    for (const text of [`revert commit ${SHA}`, `the org id is ${UUID}`]) {
      expect(scored(text).every((c) => c.score < 0.5)).toBe(true);
    }
  });

  it("treats a UUID as a candidate when the text calls it a key", () => {
    const [c] = findSecretCandidates(`heroku api key: ${UUID}`);
    expect(c?.value).toBe(UUID);
    expect(c!.score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not count 'public key' as a credential word", () => {
    const pub = "02" + "6ae7f4e1d8ae3b87beeabf3ca94b1d76a6ad45cd0951ae058cb6681d2c539e72";
    expect(scored(`register public key ${pub} on the user`).every((c) => c.score < 0.5)).toBe(true);
  });

  it("takes the password from a database URL and ignores plain URLs", () => {
    const [c] = findSecretCandidates("connect with postgres://app:Xk29fLq8Wm3vPz7RtY4n@db.example.com:5432/app");
    expect(c?.value).toBe("Xk29fLq8Wm3vPz7RtY4n");
    expect(findSecretCandidates("see https://example.com/report?id=abc123DEF456&page=2")).toEqual([]);
  });

  it("finds a short password after a password word, trailing punctuation included", () => {
    expect(findSecretCandidates("the db password is Blue&72!")[0]?.value).toBe("Blue&72!");
  });

  it("skips digests, versions, media data, ids, and secret references", () => {
    for (const text of [
      `pin to ghcr.io/acme/app@sha256:${SHA}${SHA.slice(0, 24)}`,
      "bump to v2.14.0-rc.3+build.20261117",
      "the image data starts with iVBORw0KGgoAAAANSUhEUgAAgKIzE/c9e0n8RdcJaMlZm",
      "continue in th-0o98qio8-h8glnlnf",
      "use secret://personal/HCLOUD_TOKEN for the deploy",
    ]) {
      expect(scored(text).filter((c) => c.score >= 0.5)).toEqual([]);
    }
  });

  it("raises the score when the agent asked for a credential", () => {
    const [plain] = scored(SHA);
    const [asked] = scored(SHA, { credentialRequested: true });
    expect(asked!.score).toBeGreaterThan(plain!.score);
  });

  it("measures entropy in bits per character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});
