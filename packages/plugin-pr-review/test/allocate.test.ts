import { describe, expect, it } from "vitest";
import { allocateReview, parseNumstat, type AllocationOptions, type ChangedFile } from "../src/allocate.js";

const opts: AllocationOptions = { model: "m", lightModel: "s", deepModel: "l" };
const file = (path: string, additions: number, deletions = 0): ChangedFile => ({ path, additions, deletions });

describe("allocateReview", () => {
  it("gives a docs-only change a light review with no focused passes", () => {
    const a = allocateReview([file("README.md", 300), file("docs/guide.md", 80)], { ...opts, focuses: ["tests"] });
    expect(a).toEqual({ depth: "light", model: "s", focuses: [], reason: "only docs and tests" });
  });

  it("gives a small code change a light review", () => {
    const a = allocateReview([file("src/util.ts", 12, 3), file("src/util.test.ts", 90)], opts);
    expect(a.depth).toBe("light");
    expect(a.reason).toBe("15 changed lines of code");
  });

  it("does not count lockfiles or generated files", () => {
    const a = allocateReview([file("src/util.ts", 10), file("pnpm-lock.yaml", 5000), file("api/types.gen.ts", 4000)], opts);
    expect(a.depth).toBe("light");
  });

  it("keeps the line's model and focuses for a normal change", () => {
    const a = allocateReview([file("src/handler.ts", 120, 40)], { ...opts, focuses: ["failure"] });
    expect(a).toEqual({ depth: "standard", model: "m", focuses: ["failure"], reason: "160 changed lines of code" });
  });

  it("gives a change to a risky path a deep review with every focus, however small", () => {
    const a = allocateReview([file("db/migrations/0042_users.sql", 3)], opts);
    expect(a.depth).toBe("deep");
    expect(a.model).toBe("l");
    expect(a.focuses).toEqual(["failure", "concurrency", "tests"]);
    expect(a.reason).toBe("touches `db/migrations/0042_users.sql`");
  });

  it("keeps the line's own focuses for a deep review when it has some", () => {
    expect(allocateReview([file("src/auth/session.ts", 3)], { ...opts, focuses: ["concurrency"] }).focuses).toEqual(["concurrency"]);
  });

  it("reads the team's risk paths and the path before a rename", () => {
    expect(allocateReview([file("deploy/values.yaml", 2)], { ...opts, riskPaths: ["deploy/**"] }).depth).toBe("deep");
    expect(allocateReview([{ path: "src/a.ts", previousPath: "src/oauth/a.ts", additions: 1, deletions: 1 }], opts).depth).toBe("deep");
  });

  it("names at most two risky paths", () => {
    const a = allocateReview([file("src/auth/a.ts", 1), file("src/auth/b.ts", 1), file("src/auth/c.ts", 1), file("src/auth/d.ts", 1)], opts);
    expect(a.reason).toBe("touches `src/auth/a.ts`, `src/auth/b.ts` and 2 more risky paths");
  });

  it("gives a large or over-budget change a deep review", () => {
    expect(allocateReview([file("src/big.ts", 900, 200)], opts)).toMatchObject({ depth: "deep", reason: "1100 changed lines" });
    expect(allocateReview([file("src/a.ts", 100)], { ...opts, truncated: true })).toMatchObject({ depth: "deep", reason: "the diff is over the review budget" });
  });

  it("does not count tests, docs or UI sessions as risky code", () => {
    expect(allocateReview([file("src/auth/session.test.ts", 30), file("docs/auth.md", 30)], opts).depth).toBe("light");
    expect(allocateReview([file("web/components/session/composer.tsx", 120)], opts).depth).toBe("standard");
  });

  it("keeps the line's model for light and deep when none is set", () => {
    const line: AllocationOptions = { model: "m", lightModel: "" };
    expect(allocateReview([file("README.md", 10)], line)).toMatchObject({ depth: "light", model: "m", focuses: [] });
    expect(allocateReview([file("src/auth/a.ts", 10)], line)).toMatchObject({ depth: "deep", model: "m" });
  });

  it("does not treat a test-only change as risky by size alone", () => {
    expect(allocateReview([file("tests/test_load.py", 600)], opts).depth).toBe("light");
  });
});

describe("parseNumstat", () => {
  it("reads counts, binary files and both rename forms", () => {
    const text = ["12\t3\tsrc/a.ts", "-\t-\tlogo.png", "4\t4\tsrc/{old => new}/b.ts", "1\t0\told.txt => new.txt", ""].join("\n");
    expect(parseNumstat(text)).toEqual([
      { path: "src/a.ts", additions: 12, deletions: 3 },
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "src/new/b.ts", previousPath: "src/old/b.ts", additions: 4, deletions: 4 },
      { path: "new.txt", previousPath: "old.txt", additions: 1, deletions: 0 },
    ]);
  });
});
