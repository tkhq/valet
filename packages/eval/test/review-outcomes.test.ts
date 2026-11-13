import { describe, expect, it } from "vitest";
import {
  botStatus,
  classifyOutcome,
  codeChange,
  findingFields,
  flaggedWindow,
  loginKey,
  notFound,
  summarizeOutcomes,
  type CommentFacts,
  type OutcomeRow,
} from "../src/review-outcomes.js";

const file = (n: number, edit?: (i: number) => string | undefined): string =>
  Array.from({ length: n }, (_, i) => edit?.(i + 1) ?? `line ${i + 1}`).join("\n");

describe("review outcomes", () => {
  it("reads the flagged line with two lines of context, clipped at the file edges", () => {
    expect(flaggedWindow(file(10), 5)).toEqual(["line 3", "line 4", "line 5", "line 6", "line 7"]);
    expect(flaggedWindow(file(10), 1)).toEqual(["line 1", "line 2", "line 3"]);
    expect(flaggedWindow(file(10), 11)).toBeUndefined();
  });

  it("counts an edit inside the window as a change, and one outside it or a move as none", () => {
    const before = file(20);
    expect(codeChange(before, file(20, (i) => (i === 6 ? "fixed 6" : undefined)), 5)).toBe("changed");
    expect(codeChange(before, file(20, (i) => (i === 12 ? "other" : undefined)), 5)).toBe("unchanged");
    expect(codeChange(before, `header\nheader\n${before}`, 5)).toBe("unchanged");
    expect(codeChange(before, undefined, 5)).toBe("changed");
    expect(codeChange(undefined, before, 5)).toBe("unknown");
  });

  it("classifies by code change first, then by a person's disagreement", () => {
    const facts = (over: Partial<CommentFacts>): CommentFacts => ({ changed: "unchanged", resolvedByPerson: false, thumbsUp: 0, thumbsDown: 0, replies: 0, ...over });
    expect(classifyOutcome(facts({ changed: "changed", thumbsDown: 1 }))).toBe("addressed");
    expect(classifyOutcome(facts({ thumbsDown: 1 }))).toBe("rejected");
    expect(classifyOutcome(facts({ resolvedByPerson: true }))).toBe("rejected");
    expect(classifyOutcome(facts({ botStatus: "withdrawn" }))).toBe("rejected");
    expect(classifyOutcome(facts({ botStatus: "fixed", thumbsUp: 1 }))).toBe("ignored");
    expect(classifyOutcome(facts({ changed: "unknown" }))).toBe("unknown");
  });

  it("tells a file missing at a ref from a read that failed", () => {
    expect(notFound(Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" }))).toBe(true);
    expect(notFound(Object.assign(new Error("Command failed: gh api"), { stderr: "gh: API rate limit exceeded (HTTP 403)" }))).toBe(false);
    expect(notFound(new Error("connect ETIMEDOUT"))).toBe(false);
  });

  it("matches an app's writing and resolving logins, and reads the reviewer's own status", () => {
    expect(loginKey("tkhq-valet-dev[bot]")).toBe(loginKey("TKHQ-valet-dev"));
    expect(botStatus("**Fixed in `abc1234`.** done")).toBe("fixed");
    expect(botStatus("**Withdrawn.** A recheck found")).toBe("withdrawn");
    expect(botStatus("Low · bug")).toBeUndefined();
  });

  it("reads a Valet finding's severity and leaves other comments unrated", () => {
    const body = "Low · bug\n\n<!-- valet-pr-review:finding f1 low bug -->\n**Off by one in loop**\n\nThe loop skips the last item.\n<!-- /valet-pr-review:finding -->";
    expect(findingFields(body)).toEqual({ severity: "low", category: "bug", title: "Off by one in loop" });
    expect(findingFields("Consider renaming this.")).toEqual({ severity: "unrated" });
  });

  it("summarizes the address rate per bot and severity, leaving unknown comments out of the rate", () => {
    const row = (bot: string, severity: string, outcome: OutcomeRow["outcome"]) => ({ bot, severity, outcome }) as OutcomeRow;
    const summary = summarizeOutcomes([row("a", "low", "addressed"), row("a", "low", "ignored"), row("a", "high", "unknown"), row("b", "unrated", "rejected")]);
    expect(summary.find((s) => s.bot === "a" && s.severity === "all")).toMatchObject({ comments: 3, addressed: 1, unknown: 1, addressRate: 0.5 });
    expect(summary.find((s) => s.bot === "a" && s.severity === "low")?.addressRate).toBe(0.5);
    expect(summary.find((s) => s.bot === "b" && s.severity === "all")).toMatchObject({ rejected: 1, addressRate: 0 });
  });
});
