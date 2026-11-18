import { describe, expect, it } from "vitest";
import { commitAuthor, commitSubject, gitObjectId, planCommitChain, unsignedRewrite, withSignature } from "./commits.js";
import {
  EMAIL,
  PUBLIC_HEX,
  SIGNED_1,
  SIGNED_1_SHA,
  SIGNED_2_SHA,
  UNSIGNED_1,
  signWithTestKey,
  unsigned2,
} from "./test-helpers/commit-fixtures.js";

describe("gitObjectId", () => {
  it("matches git's id for a signed commit", () => {
    expect(gitObjectId(SIGNED_1)).toBe(SIGNED_1_SHA);
  });
});

describe("planCommitChain", () => {
  const commits = [
    { sha: gitObjectId(UNSIGNED_1), object: UNSIGNED_1 },
    { sha: "", object: "" },
  ];
  commits[1] = { sha: gitObjectId(unsigned2(commits[0]!.sha)), object: unsigned2(commits[0]!.sha) };

  it("signs a chain one commit at a time and reproduces git's signed objects", () => {
    const signatures: Buffer[] = [];
    let plan = planCommitChain({ commits, committerEmail: EMAIL, signatures, publicKeyHex: PUBLIC_HEX });
    expect(plan.rewritten).toEqual([]);
    expect(plan.nextSubject).toBe("first commit");
    while (plan.nextPayload) {
      signatures.push(signWithTestKey(plan.nextPayload));
      plan = planCommitChain({ commits, committerEmail: EMAIL, signatures, publicKeyHex: PUBLIC_HEX });
    }
    expect(plan.rewritten.map((c) => c.newSha)).toEqual([SIGNED_1_SHA, SIGNED_2_SHA]);
    expect(plan.rewritten[0]!.object).toBe(SIGNED_1);
    expect(plan.rewritten[1]!.object).toContain(`parent ${SIGNED_1_SHA}\n`);
    expect(plan.rewritten.map((c) => c.oldSha)).toEqual(commits.map((c) => c.sha));
  });

  it("refuses more signatures than commits", () => {
    const sig = Buffer.alloc(64);
    expect(() => planCommitChain({ commits: commits.slice(0, 1), committerEmail: EMAIL, signatures: [sig, sig], publicKeyHex: PUBLIC_HEX })).toThrow();
  });
});

describe("unsignedRewrite", () => {
  it("remaps both parents of a merge, strips an old signature, and keeps committer name and time", () => {
    const merge = `tree t1\nparent aaa\nparent bbb\nauthor A <a@x> 1 +0000\ncommitter C <c@x> 2 +0100\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nmerge\n`;
    const out = unsignedRewrite(merge, new Map([["aaa", "111"], ["bbb", "222"]]), "n@users.noreply.github.com");
    expect(out).toBe(`tree t1\nparent 111\nparent 222\nauthor A <a@x> 1 +0000\ncommitter C <n@users.noreply.github.com> 2 +0100\n\nmerge\n`);
  });

  it("keeps a parent outside the chain", () => {
    expect(unsignedRewrite("tree t\nparent base\ncommitter C <c@x> 2 +0000\n\nm\n", new Map(), "e@x")).toContain("parent base\n");
  });
});

describe("labels", () => {
  it("reads the subject and author", () => {
    expect(commitSubject(unsigned2("p"))).toBe("second commit");
    expect(commitAuthor(UNSIGNED_1)).toBe("Valet Test <valet@example.com>");
    expect(withSignature("tree t\n\nm\n", "A\nB\n")).toBe("tree t\ngpgsig A\n B\n\nm\n");
  });
});
