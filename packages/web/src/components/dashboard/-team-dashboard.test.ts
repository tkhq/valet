/**
 * `mergeTeamFeed` — the team dashboard's pure feed merge (team dashboard
 * design): ordering, the cap, attribution, and tone mapping, all testable
 * without queries.
 */
import { describe, expect, it } from "vitest";
import type { GlobalWorkflowRunSummary, TeamChildSummary } from "@valet/api/wire";
import { mergeTeamFeed } from "./team-dashboard";

function child(overrides: Partial<TeamChildSummary> = {}): TeamChildSummary {
  return {
    sessionId: "child-1",
    title: "Audit PR",
    parentThreadId: "th-1",
    status: "settled",
    createdAt: 100,
    assistantId: "asst_1",
    assistantName: "Sentinel",
    ...overrides,
  };
}

function run(overrides: Partial<GlobalWorkflowRunSummary> = {}): GlobalWorkflowRunSummary {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "triage",
    status: "settled",
    outcome: "completed",
    createdAt: 50,
    updatedAt: 50,
    ...overrides,
  };
}

describe("mergeTeamFeed", () => {
  it("merges both kinds newest-first and caps the result", () => {
    const children = [child({ sessionId: "c1", createdAt: 30 }), child({ sessionId: "c2", createdAt: 10 })];
    const runs = [run({ runId: "r1", createdAt: 20 })];
    const feed = mergeTeamFeed(children, runs, 2);
    expect(feed.map((i) => i.key)).toEqual(["child:c1", "run:r1"]);
  });

  it("attributes an assistant run to its assistant, with a fallback for unnamed ones", () => {
    const named = mergeTeamFeed([child()], [])[0];
    expect(named?.actor).toBe("Sentinel");
    expect(named?.title).toBe("Audit PR");

    const unnamed = mergeTeamFeed([child({ assistantName: undefined })], [])[0];
    expect(unnamed?.actor).toBe("Assistant");
  });

  it("maps tones: running children run; failed or cancelled outcomes fail; parked runs still run", () => {
    expect(mergeTeamFeed([child({ status: "running" })], [])[0]?.tone).toBe("running");
    expect(mergeTeamFeed([], [run({ outcome: "failed" })])[0]?.tone).toBe("failed");
    expect(mergeTeamFeed([], [run({ outcome: "cancelled" })])[0]?.tone).toBe("failed");
    expect(mergeTeamFeed([], [run({ status: "parked", outcome: undefined })])[0]?.tone).toBe("running");
    expect(mergeTeamFeed([], [run()])[0]?.tone).toBe("done");
  });

  it("labels a workflow run by its outcome when settled, its status while moving", () => {
    expect(mergeTeamFeed([], [run()])[0]?.statusLabel).toBe("completed");
    expect(mergeTeamFeed([], [run({ status: "running", outcome: undefined })])[0]?.statusLabel).toBe(
      "running",
    );
  });
});
