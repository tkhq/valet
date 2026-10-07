import { describe, expect, it } from "vitest";
import { terminalOutcome } from "../src/builtin-tools/terminal-outcome.js";
import { toolOutcome } from "../src/thread.js";

describe("terminalOutcome", () => {
  it("confirms a created PR from a successful gh create result", () => {
    expect(terminalOutcome("gh pr create --fill", "https://github.com/acme/repo/pull/42\n", 0)).toEqual({
      kind: "pull_request_created", url: "https://github.com/acme/repo/pull/42",
    });
    expect(terminalOutcome("cd /repo && gh pr create --fill", "https://github.com/acme/repo/pull/43\n", 0)?.kind).toBe("pull_request_created");
  });

  it("records a terminal PR comment by the comment URL gh prints", () => {
    expect(terminalOutcome('gh pr comment 42 --body "Fixed"', "https://github.com/acme/repo/pull/42#issuecomment-901\n", 0)).toEqual({
      kind: "pull_request_comment", url: "https://github.com/acme/repo/pull/42#issuecomment-901",
    });
    expect(terminalOutcome('gh pr comment 42 --body "Fixed"', "no URL", 0)).toBeUndefined();
  });

  it("records a comment by its URL whatever shell syntax surrounds it", () => {
    const url = "https://github.com/acme/repo/pull/42#issuecomment-902";
    for (const command of [
      "gh pr comment 42 --body 'a | b'",
      "gh pr comment 42 --body 'CI & lint pass'",
      "git push && gh pr comment 42 --body done",
      "gh api repos/acme/repo/issues/42/comments -f body=done",
    ]) expect(terminalOutcome(command, `{"html_url":"${url}"}`, 0)).toEqual({ kind: "pull_request_comment", url });
    // Recorded even when a later command in the chain failed: the comment exists.
    expect(terminalOutcome("gh pr comment 42 --body done; false", url, 1)).toEqual({ kind: "pull_request_comment", url });
    // Not a CLI call in command position.
    expect(terminalOutcome("echo gh pr comment 42", url, 0)).toBeUndefined();
    // A read lists other people's comments; it is not a write.
    expect(terminalOutcome("gh api repos/acme/repo/issues/42/comments", `[{"html_url":"${url}"}]`, 0)).toBeUndefined();
    expect(terminalOutcome("gh api -X POST repos/acme/repo/issues/42/comments --input body.json", url, 0)).toEqual({ kind: "pull_request_comment", url });
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

describe("toolOutcome", () => {
  it("forwards every outcome kind the terminal reports to tool_end", () => {
    const commands = [
      ["gh pr create --fill", "https://github.com/acme/repo/pull/42\n"],
      ["gh pr review 42 --approve", ""],
      ['gh pr comment 42 --body "Fixed"', "https://github.com/acme/repo/pull/42#issuecomment-901\n"],
    ] as const;
    const kinds = commands.map(([command, output]) => {
      const outcome = terminalOutcome(command, output, 0);
      expect(outcome).toBeDefined();
      expect(toolOutcome({ details: { outcome } })).toEqual({ outcome });
      return outcome?.kind;
    });
    expect(kinds).toEqual(["pull_request_created", "review_submitted", "pull_request_comment"]);
    expect(toolOutcome({ details: { outcome: { kind: "review_submitted", startedAt: 1234 } } })).toEqual({
      outcome: { kind: "review_submitted", startedAt: 1234 },
    });
    expect(toolOutcome({ details: { outcome: { kind: "review_submitted", startedAt: "bad" } } })).toEqual({
      outcome: { kind: "review_submitted" },
    });
    expect(toolOutcome({ details: { outcome: { kind: "unknown" } } })).toEqual({});
  });
});
