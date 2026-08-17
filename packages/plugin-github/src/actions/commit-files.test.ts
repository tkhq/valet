/**
 * Unit suite for the parts of `github.commit_files` that decide WITHOUT
 * talking to GitHub: what the request may hold, and create-or-update against
 * the state of the branch. The end-to-end suite in `actions.test.ts` drives
 * the same code over a real HTTP fixture.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_COMMIT_FILES,
  planFiles,
  validateInput,
  type CommitFileInput,
  type CommitFilesInput,
  type ExistingPath,
} from "./commit-files.js";

function input(files: CommitFileInput[], extra: Partial<CommitFilesInput> = {}): CommitFilesInput {
  return {
    owner: "acme",
    repo: "handbook",
    branch: "feat/notes",
    message: "add notes",
    files,
    ...extra,
  };
}

const HELLO: CommitFileInput = { path: "docs/notes.md", content: "hello" };

describe("commit_files input validation", () => {
  it("accepts a normal single-file request", () => {
    expect(validateInput(input([HELLO]))).toBeNull();
  });

  it("refuses an empty branch and names the fix", () => {
    const error = validateInput(input([HELLO], { branch: "  " }));
    expect(error).toContain("Name the branch");
  });

  // The `{+branch}` route form reaches the URL unencoded, so a name with a
  // dot segment addresses a different ref than the one the default-branch
  // guard compares. These names are refused before any request goes out.
  describe("branch names the URL parser would re-address", () => {
    const traversals = ["../heads/main", "..", "a/../../heads/main", "%2e%2e/heads/main", "main#x", "main?x=1"];

    it.each(traversals)('refuses "%s" and names the fix', (branch) => {
      const error = validateInput(input([HELLO], { branch }));
      expect(error).toContain("is not a usable branch name");
      expect(error).toContain("github.create_branch");
    });

    it("accepts the branch names real work uses", () => {
      for (const branch of ["main", "feat/notes", "release/1.2.3", "user/fix-404", "v2.x"]) {
        expect(validateInput(input([HELLO], { branch }))).toBeNull();
      }
    });

    it("refuses the rest of what git check-ref-format refuses", () => {
      for (const branch of ["feat/", "/feat", "feat//x", ".hidden", "feat/.x", "x.lock", "feat/x.lock", "x ", "a:b", "a~1", "a^", "a?", "a*", "a[1]", "a\\b", "@", "HEAD@{1}", "trailing."]) {
        expect(validateInput(input([HELLO], { branch }))).toContain("is not a usable branch name");
      }
    });
  });

  it("refuses an empty commit message", () => {
    const error = validateInput(input([HELLO], { message: "" }));
    expect(error).toContain("commit message is empty");
  });

  it("refuses an empty file list", () => {
    expect(validateInput(input([]))).toContain("at least one file");
  });

  it("refuses more files than one commit takes, and says to split", () => {
    const many = Array.from({ length: MAX_COMMIT_FILES + 1 }, (_, i) => ({
      path: `docs/f${i}.md`,
      content: "x",
    }));
    const error = validateInput(input(many));
    expect(error).toContain(String(MAX_COMMIT_FILES));
    expect(error).toContain("Split the change");
  });

  it("refuses the same path twice, because one commit writes it once", () => {
    const error = validateInput(
      input([
        { path: "docs/notes.md", content: "first" },
        { path: "docs/notes.md", content: "second" },
      ]),
    );
    expect(error).toContain("listed twice");
    expect(error).toContain("merge the two entries");
  });

  it.each([
    ["/docs/notes.md", "starts with a slash"],
    ["docs/", "names a directory"],
    ["../secrets.md", '".." segment'],
    [".git/config", "reserved by Git"],
    ["", "the path is empty"],
  ])("refuses the path %j", (path, expected) => {
    expect(validateInput(input([{ path, content: "x" }]))).toContain(expected);
  });

  it("refuses content that claims base64 but is not", () => {
    const error = validateInput(input([{ path: "logo.png", content: "not b4$e", encoding: "base64" }]));
    expect(error).toContain("not valid base64");
  });

  it("accepts real base64", () => {
    const content = Buffer.from("binary bytes").toString("base64");
    expect(validateInput(input([{ path: "logo.png", content, encoding: "base64" }]))).toBeNull();
  });
});

describe("commit_files create-or-update planning", () => {
  const existingBlob = (sha: string, mode = "100644"): ExistingPath => ({ kind: "blob", sha, mode });

  it("creates a file when the path is free and no expectedSha was given", () => {
    const result = planFiles(input([HELLO]), new Map());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual([
      { path: "docs/notes.md", mode: "100644", status: "created", content: "hello", encoding: "utf-8" },
    ]);
  });

  it("updates a file when expectedSha matches the blob on the branch", () => {
    const result = planFiles(
      input([{ ...HELLO, expectedSha: "abc123" }]),
      new Map([["docs/notes.md", existingBlob("abc123")]]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan[0].status).toBe("updated");
  });

  it("refuses a stale expectedSha, names the live SHA, and commits nothing", () => {
    // The whole point of the guard. The caller read the file at abc123 and
    // somebody else committed since, so writing would drop their change.
    const result = planFiles(
      input([{ ...HELLO, expectedSha: "abc123" }]),
      new Map([["docs/notes.md", existingBlob("def456")]]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("nothing was committed");
    expect(result.error).toContain("now at blob SHA def456");
    expect(result.error).toContain("abc123");
    expect(result.error).toContain("github.read_repo_file");
  });

  it("refuses a create onto a path that already holds a file", () => {
    // Omitting expectedSha on an existing path is the silent-overwrite case.
    // The error carries the live SHA, so the repair is one more call.
    const result = planFiles(input([HELLO]), new Map([["docs/notes.md", existingBlob("abc123")]]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already exists at blob SHA abc123");
    expect(result.error).toContain('expectedSha "abc123"');
  });

  it("refuses an expectedSha for a path that holds no file", () => {
    const result = planFiles(input([{ ...HELLO, expectedSha: "abc123" }]), new Map());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("matches nothing");
    expect(result.error).toContain("Drop expectedSha");
  });

  it("reports every conflicting file in one message", () => {
    const result = planFiles(
      input([
        { path: "docs/a.md", content: "a" },
        { path: "docs/b.md", content: "b", expectedSha: "stale" },
        { path: "docs/c.md", content: "c" },
      ]),
      new Map([
        ["docs/a.md", existingBlob("sha-a")],
        ["docs/b.md", existingBlob("sha-b")],
      ]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("2 files conflict");
    expect(result.error).toContain("docs/a.md");
    expect(result.error).toContain("docs/b.md");
    // docs/c.md is writable, but a partial commit is not on offer.
    expect(result.error).toContain("nothing was committed");
  });

  it("keeps the executable bit on a file that has it", () => {
    const result = planFiles(
      input([{ path: "scripts/run.sh", content: "#!/bin/sh\n", expectedSha: "sha-x" }]),
      new Map([["scripts/run.sh", existingBlob("sha-x", "100755")]]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan[0].mode).toBe("100755");
  });

  it("refuses to write over a path that is not a regular file", () => {
    const result = planFiles(
      input([{ path: "vendor/lib", content: "x" }]),
      new Map([["vendor/lib", { kind: "other", description: "a submodule" }]]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("a submodule");
    expect(result.error).toContain("Choose another path");
  });
});
