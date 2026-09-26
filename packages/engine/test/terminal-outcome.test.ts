import { describe, expect, it } from "vitest";
import { terminalOutcome } from "../src/builtin-tools/terminal-outcome.js";

describe("terminalOutcome", () => {
  it("confirms a created PR from a successful gh create result", () => {
    expect(terminalOutcome("gh pr create --fill", "https://github.com/acme/repo/pull/42\n", 0)).toEqual({
      kind: "pull_request_created", url: "https://github.com/acme/repo/pull/42",
    });
    expect(terminalOutcome("cd /repo && gh pr create --fill", "https://github.com/acme/repo/pull/43\n", 0)?.kind).toBe("pull_request_created");
  });

  it("requires command success and a PR URL", () => {
    expect(terminalOutcome("gh pr create --fill", "https://github.com/acme/repo/pull/42", 1)).toBeUndefined();
    expect(terminalOutcome("gh pr create --fill", "no URL", 0)).toBeUndefined();
    expect(terminalOutcome("echo gh pr create --fill", "https://github.com/acme/repo/pull/42", 0)).toBeUndefined();
  });

  it("counts submitted reviews, not interactive or failed review commands", () => {
    expect(terminalOutcome("gh pr review 42 --approve", "", 0)).toEqual({ kind: "review_submitted" });
    expect(terminalOutcome("valet-gh pr review 42 --request-changes --body 'Fix this'", "", 0)).toEqual({ kind: "review_submitted" });
    expect(terminalOutcome("gh pr review 42", "", 0)).toBeUndefined();
    expect(terminalOutcome("gh pr review 42 --comment", "", 1)).toBeUndefined();
    expect(terminalOutcome("gh pr review 42 --approve || true", "", 0)).toBeUndefined();
  });
});
