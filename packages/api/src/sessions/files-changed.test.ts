/**
 * The diff parser behind `GET /api/sessions/:id/files-changed` (V1 port #4).
 *
 * The counts must agree with `git diff --numstat` on the same diff, because
 * that is what a reader would check them against. The fixtures below are
 * shaped like real `git diff` output: header pair, mode lines, hunks.
 */
import { describe, it, expect } from "vitest";
import { buildFilesChangedResponse, mergePatches, parseHunkHeader, parseUnifiedDiff } from "./files-changed.js";

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { one } from "one";
-const removed = 1;
+const added = 1;
+const alsoAdded = 2;
 export {};
`;

const ADDED = `diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# Title
+Body.
`;

const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
`;

const RENAMED = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 92%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 export {};
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

/**
 * Verbatim `git diff -M` output for a pure rename of an unchanged file next
 * to a binary change. Copied from a real repository, not written by hand: a
 * pure rename carries NO `---`/`+++` pair and no hunk at all, which is the
 * shape a parser driven by the header pair alone would miss.
 */
const REAL_RENAME_AND_BINARY = `diff --git a/logo.png b/logo.png
index cd404bb..b0fb808 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/keep.ts b/src/moved.ts
similarity index 100%
rename from src/keep.ts
rename to src/moved.ts
`;

describe("parseUnifiedDiff", () => {
  it("counts additions and deletions for a modified file", () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toEqual([
      { path: "src/app.ts", additions: 2, deletions: 1, status: "modified", binary: false },
    ]);
  });

  it("marks a new file as added and counts every line", () => {
    expect(parseUnifiedDiff(ADDED)).toEqual([
      { path: "docs/new.md", additions: 2, deletions: 0, status: "added", binary: false },
    ]);
  });

  it("keeps the old path for a deleted file and counts its lines as deletions", () => {
    expect(parseUnifiedDiff(DELETED)).toEqual([
      { path: "old.txt", additions: 0, deletions: 2, status: "deleted", binary: false },
    ]);
  });

  it("records a rename with the previous path", () => {
    expect(parseUnifiedDiff(RENAMED)).toEqual([
      {
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        additions: 1,
        deletions: 1,
        status: "renamed",
        binary: false,
      },
    ]);
  });

  it("flags a binary change and leaves its counts at zero", () => {
    expect(parseUnifiedDiff(BINARY)).toEqual([
      { path: "logo.png", additions: 0, deletions: 0, status: "modified", binary: true },
    ]);
  });

  it("does not count the +++/--- header pair as changed lines", () => {
    // The regression this guards: a naive `startsWith("+")` counts `+++
    // b/path` as an addition, which inflates every file by one.
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
  });

  it("parses several files from one diff", () => {
    const files = parseUnifiedDiff([MODIFIED, ADDED, DELETED].join(""));
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "docs/new.md", "old.txt"]);
    expect(files.map((f) => f.status)).toEqual(["modified", "added", "deleted"]);
  });

  it("reads a path that contains a space", () => {
    const diff = `diff --git a/my docs/a b.md b/my docs/a b.md
--- a/my docs/a b.md
+++ b/my docs/a b.md
@@ -1 +1 @@
-old
+new
`;
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "my docs/a b.md", additions: 1, deletions: 1, status: "modified", binary: false },
    ]);
  });

  it("reads a quoted path", () => {
    const diff = `diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"
--- "a/caf\\303\\251.md"
+++ "b/caf\\303\\251.md"
@@ -1 +1 @@
-old
+new
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.path.endsWith(".md")).toBe(true);
  });

  it("reads a pure rename, which carries no hunk and no +++/--- pair", () => {
    const files = parseUnifiedDiff(REAL_RENAME_AND_BINARY);
    expect(files).toEqual([
      { path: "logo.png", additions: 0, deletions: 0, status: "modified", binary: true },
      {
        path: "src/moved.ts",
        previousPath: "src/keep.ts",
        additions: 0,
        deletions: 0,
        status: "renamed",
        binary: false,
      },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("ignores hunk context lines, which start with a space", () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    // Two context lines are present in the fixture and neither is counted.
    expect((file?.additions ?? 0) + (file?.deletions ?? 0)).toBe(3);
  });
});

describe("mergePatches", () => {
  it("takes the newest patch whole, because each patch is a full workspace diff", () => {
    // If merging summed the patches, `src/app.ts` would read 4 additions
    // rather than 2 — the same lines counted twice.
    const files = mergePatches([MODIFIED, MODIFIED + ADDED]);
    const app = files.find((f) => f.path === "src/app.ts");
    expect(app?.additions).toBe(2);
    expect(files.map((f) => f.path)).toEqual(["docs/new.md", "src/app.ts"]);
  });

  it("drops a file the newest patch no longer touches", () => {
    // A file changed and then reverted disappears from the diff, so it must
    // disappear from the list.
    expect(mergePatches([ADDED, MODIFIED]).map((f) => f.path)).toEqual(["src/app.ts"]);
  });

  it("sorts by path so the list does not reorder between reads", () => {
    expect(mergePatches([DELETED + ADDED + MODIFIED]).map((f) => f.path)).toEqual([
      "docs/new.md",
      "old.txt",
      "src/app.ts",
    ]);
  });

  it("returns nothing when there are no patches", () => {
    expect(mergePatches([])).toEqual([]);
  });
});

describe("buildFilesChangedResponse", () => {
  it("totals the per-file counts", () => {
    const body = buildFilesChangedResponse({ files: mergePatches([MODIFIED + ADDED]), truncated: false });
    expect(body.additions).toBe(4);
    expect(body.deletions).toBe(1);
    expect(body.unavailable).toBeUndefined();
  });

  it("names the corrective action for every unavailable reason", () => {
    for (const reason of ["no_repository", "no_patches_yet", "capture_failed", "storage_unavailable"] as const) {
      const body = buildFilesChangedResponse({ files: [], unavailable: reason, truncated: false });
      expect(body.unavailable).toBe(reason);
      // Every message must tell the reader what happens next, not only that
      // something is missing.
      expect(body.unavailableMessage).toBeTruthy();
      expect((body.unavailableMessage ?? "").length).toBeGreaterThan(20);
    }
  });

  it("carries the truncation flag so the totals are not read as complete", () => {
    expect(buildFilesChangedResponse({ files: [], truncated: true }).truncated).toBe(true);
  });
});

/**
 * Real `git diff` output, captured from a scratch repository built to hold
 * every line shape that can be mistaken for structure. `GIT_NUMSTAT` below
 * is the `git diff --numstat` for the same commit, verbatim, which is the
 * contract this parser owes its reader.
 *
 * The cases that matter:
 *
 * - `m.sql` deletes two `-- ` SQL comments, so each reaches the parser as
 *   `--- a sql comment`. This repository edits `.sql` migrations in place,
 *   so it is ordinary work, not a curiosity.
 * - `c.cpp` adds three lines, two of which start `++ `, so they reach the
 *   parser as `+++ i;`.
 * - `diffheaderish.txt` adds five lines that imitate `diff --git`, the
 *   `---`/`+++` pair, a hunk header, and a binary marker.
 * - `eof.txt` carries the `\ No newline at end of file` marker on both
 *   sides, which belongs to neither line count.
 */
const REAL_GIT_DIFF = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..858e580
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand new
+second line
diff --git a/bin.dat b/bin.dat
new file mode 100644
index 0000000..c94be36
Binary files /dev/null and b/bin.dat differ
diff --git a/c.cpp b/c.cpp
index 02028a8..b833d78 100644
--- a/c.cpp
+++ b/c.cpp
@@ -1,3 +1,6 @@
 int main(){
+++ i;
+++ j;
+gamma
   return 0;
 }
diff --git a/diffheaderish.txt b/diffheaderish.txt
index 4cb29ea..c70f057 100644
--- a/diffheaderish.txt
+++ b/diffheaderish.txt
@@ -1,3 +1,8 @@
 one
+diff --git a/fake b/fake
+--- a/fake
++++ b/fake
+@@ -9,9 +9,9 @@
+Binary files a/x and b/x differ
 two
 three
diff --git a/eof.txt b/eof.txt
index 69db55d..0165cff 100644
--- a/eof.txt
+++ b/eof.txt
@@ -1 +1 @@
-no trailing newline
\\ No newline at end of file
+no trailing newline changed
\\ No newline at end of file
diff --git a/m.sql b/m.sql
index 901fbd4..fbbee86 100644
--- a/m.sql
+++ b/m.sql
@@ -1,4 +1,2 @@
 alpha
--- a sql comment
--- second comment
 beta
diff --git a/removed.txt b/removed.txt
deleted file mode 100644
index d55c06e..0000000
--- a/removed.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
diff --git a/renamed_from.txt b/renamed_to.txt
similarity index 100%
rename from renamed_from.txt
rename to renamed_to.txt
`;

/** `git diff --numstat` for REAL_GIT_DIFF. `-` means binary. */
const GIT_NUMSTAT: ReadonlyArray<{ path: string; additions: string; deletions: string }> = [
  { path: "added.txt", additions: "2", deletions: "0" },
  { path: "bin.dat", additions: "-", deletions: "-" },
  { path: "c.cpp", additions: "3", deletions: "0" },
  { path: "diffheaderish.txt", additions: "5", deletions: "0" },
  { path: "eof.txt", additions: "1", deletions: "1" },
  { path: "m.sql", additions: "0", deletions: "2" },
  { path: "removed.txt", additions: "0", deletions: "2" },
  // numstat writes this row as `renamed_from.txt => renamed_to.txt`; the
  // parser keys the file by its new path.
  { path: "renamed_to.txt", additions: "0", deletions: "0" },
];

describe("parseUnifiedDiff against real git output", () => {
  it("agrees with git diff --numstat on every file", () => {
    const parsed = parseUnifiedDiff(REAL_GIT_DIFF);
    const actual = [...parsed]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        path: f.path,
        additions: f.binary ? "-" : String(f.additions),
        deletions: f.binary ? "-" : String(f.deletions),
      }));
    expect(actual).toEqual([...GIT_NUMSTAT]);
  });

  it("counts a deleted `-- ` SQL comment instead of reading it as a --- header", () => {
    // Before the parser tracked hunk budgets, `-` + `-- a sql comment`
    // matched the `--- ` header test and both deletions vanished.
    const file = parseUnifiedDiff(REAL_GIT_DIFF).find((f) => f.path === "m.sql");
    expect(file).toEqual({
      path: "m.sql",
      additions: 0,
      deletions: 2,
      status: "modified",
      binary: false,
    });
  });

  it("counts an added `++ ` line and keeps counting the rest of its hunk", () => {
    // `+` + `++ i;` matched the `+++ ` header test, which also cleared the
    // in-hunk flag — so the miscount was not one line, it was the whole
    // remainder of the hunk. `gamma` is the third addition that proves the
    // hunk kept being read.
    const file = parseUnifiedDiff(REAL_GIT_DIFF).find((f) => f.path === "c.cpp");
    expect(file?.additions).toBe(3);
    expect(file?.deletions).toBe(0);
  });

  it("treats content that imitates diff structure as content", () => {
    const file = parseUnifiedDiff(REAL_GIT_DIFF).find((f) => f.path === "diffheaderish.txt");
    expect(file?.additions).toBe(5);
    // The imitation `diff --git a/fake b/fake` line must not open a file.
    expect(parseUnifiedDiff(REAL_GIT_DIFF).some((f) => f.path === "fake")).toBe(false);
  });

  it("charges the no-newline marker to neither side", () => {
    const file = parseUnifiedDiff(REAL_GIT_DIFF).find((f) => f.path === "eof.txt");
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });
});

describe("parseHunkHeader", () => {
  it("reads both line budgets", () => {
    expect(parseHunkHeader("@@ -1,4 +1,2 @@")).toEqual({ old: 4, new: 2 });
  });

  it("defaults an omitted count to one line", () => {
    expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({ old: 1, new: 1 });
    expect(parseHunkHeader("@@ -0,0 +1 @@")).toEqual({ old: 0, new: 1 });
  });

  it("keeps the trailing section heading git adds after the header", () => {
    expect(parseHunkHeader("@@ -10,3 +10,4 @@ function main() {")).toEqual({ old: 3, new: 4 });
  });

  it("returns null for a line that is not a two-way hunk header", () => {
    expect(parseHunkHeader("@@@ -1,2 -1,2 +1,2 @@@")).toBeNull();
    expect(parseHunkHeader("@@ nonsense @@")).toBeNull();
  });
});

/**
 * Real `git diff` for a file with TWO hunks, where the first hunk adds `-- `
 * SQL comment lines. `git diff --numstat` reports `2	3	multi.sql`.
 *
 * Multi-hunk is its own case: the parser has to close one hunk's budget and
 * open the next from the following `@@` header. A parser that stops counting
 * at the first surprise still gets a single-hunk file right.
 */
const REAL_GIT_MULTI_HUNK = `diff --git a/multi.sql b/multi.sql
index 63ba0f7..33c5046 100644
--- a/multi.sql
+++ b/multi.sql
@@ -1,6 +1,7 @@
 line1
 line2
-line3
+-- added comment A
+-- added comment B
 line4
 line5
 line6
@@ -47,8 +48,6 @@ line46
 line47
 line48
 line49
-line50
-line51
 line52
 line53
 line54
`;

describe("parseUnifiedDiff across several hunks", () => {
  it("closes one hunk budget and opens the next", () => {
    const [file] = parseUnifiedDiff(REAL_GIT_MULTI_HUNK);
    expect(file?.path).toBe("multi.sql");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(3);
  });
});
