/**
 * Corpus and baseline hygiene (adversarial-review findings 6, 7, 13):
 * flagged pulls emit loader-compatible baselines plus a runnable case
 * scaffold; live-profile baselines need an explicit opt-in; pruning keeps
 * the newest N records per case and model.
 */
import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, MessageEntry, ValetPlugin } from "@valet/engine";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import {
  flaggedBaselineRecords,
  flaggedCaseScaffold,
  loadLatestBaseline,
  parseCliArgs,
  parseEvalCase,
  pruneBaselines,
  runSuite,
  saveBaseline,
} from "../src/index.js";
import type { BaselineRecord, EvalCase, Trajectory } from "../src/index.js";
import { parse as parseYaml } from "yaml";

function entry(threadId: string, role: "user" | "assistant", content: string, id: string): MessageEntry {
  return {
    id,
    sessionId: "sess-9",
    threadId,
    parentId: null,
    createdAt: Date.now(),
    type: "message",
    role,
    content,
    ...(role === "assistant" ? { model: "anthropic/claude-haiku-4-5" } : {}),
  };
}

const FLAGGED = {
  sessionId: "sess-9",
  rating: "positive" as const,
  title: "Good run",
  ratedAt: 123,
  userId: "u1",
  threads: [
    {
      threadId: "th-1",
      entries: [entry("th-1", "user", "summarize the release notes", "e1"), entry("th-1", "assistant", "done: ...", "e2")],
    },
  ],
};

describe("flagged corpus round trip", () => {
  it("emits loader-compatible baseline records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-corpus-"));
    const records = flaggedBaselineRecords(FLAGGED, "2026-09-02T00:00:00.000Z");
    expect(records).toHaveLength(1);
    expect(records[0].caseId).toBe("flagged-sess-9-th-1");
    expect(records[0].status).toBe("pass");

    await saveBaseline(dir, records[0]);
    const loaded = await loadLatestBaseline(dir, "flagged-sess-9-th-1", "anthropic/claude-haiku-4-5");
    expect(loaded).not.toBeNull();
    expect(loaded?.trajectory.prompt).toBe("summarize the release notes");
  });

  it("a negative rating becomes a fail-status baseline", () => {
    const records = flaggedBaselineRecords({ ...FLAGGED, rating: "negative" }, "2026-09-02T00:00:00.000Z");
    expect(records[0].status).toBe("fail");
  });

  it("the case scaffold is valid YAML that the loader accepts", () => {
    const record = flaggedBaselineRecords(FLAGGED, "2026-09-02T00:00:00.000Z")[0];
    const scaffold = flaggedCaseScaffold(record);
    const parsed = parseEvalCase(parseYaml(scaffold), "scaffold.yaml");
    expect(parsed.id).toBe("flagged-sess-9-th-1");
    expect(parsed.turns[0].content).toBe("summarize the release notes");
    expect(parsed.checks).toContainEqual({ type: "judge_equivalence" });
  });
});

describe("live-baseline guard", () => {
  const fakePlugin: ValetPlugin = {
    name: "fake",
    version: "0.0.1",
    description: "fake",
    actions: [
      {
        service: "fake",
        actions: [
          {
            id: "fake.read",
            name: "Read",
            description: "reads",
            riskLevel: "low",
            parameters: Type.Object({}),
            execute: async () => ({ success: true, data: "LIVE PRIVATE DATA" }),
          },
        ],
      } satisfies ActionPlugin,
    ],
  };

  function liveCase(): EvalCase {
    return {
      id: "live-case",
      profile: "integration",
      turns: [{ role: "user", content: "read the thing" }],
      checks: [{ type: "no_errors" }],
    };
  }

  it("refuses to save integration baselines by default and says so", async () => {
    const faux = registerFauxProvider({ provider: "hygiene-1" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-corpus-"));

    const result = await runSuite([liveCase()], {
      model: faux.getModel(),
      baselinesDir: dir,
      realPlugins: [fakePlugin],
      credentials: { fake: "tok" },
      saveBaselines: true,
    });

    expect(result.savedBaselinePaths).toEqual([]);
    expect(result.skippedLiveBaselineCaseIds).toEqual(["live-case"]);
    expect(await readdir(dir)).toEqual([]);
    faux.unregister();
  });

  it("saves them with the explicit opt-in", async () => {
    const faux = registerFauxProvider({ provider: "hygiene-2" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-corpus-"));

    const result = await runSuite([liveCase()], {
      model: faux.getModel(),
      baselinesDir: dir,
      realPlugins: [fakePlugin],
      credentials: { fake: "tok" },
      saveBaselines: true,
      allowLiveBaselines: true,
    });

    expect(result.savedBaselinePaths).toHaveLength(1);
    expect(result.skippedLiveBaselineCaseIds).toEqual([]);
    faux.unregister();
  });

  it("parses the CLI flags", () => {
    expect(parseCliArgs([]).allowLiveBaselines).toBe(false);
    expect(parseCliArgs(["--allow-live-baselines"]).allowLiveBaselines).toBe(true);
    expect(parseCliArgs(["--prune-baselines", "3"]).pruneBaselinesKeep).toBe(3);
    expect(() => parseCliArgs(["--prune-baselines", "zero"])).toThrow(/--prune-baselines/);
  });
});

describe("pruneBaselines", () => {
  function record(caseId: string, model: string, savedAt: string): BaselineRecord {
    const trajectory: Trajectory = {
      caseId,
      prompt: "p",
      model,
      turns: [],
      toolCalls: [],
      finalOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      durationMs: 0,
    };
    return { caseId, model, savedAt, status: "pass", trajectory };
  }

  it("keeps the newest N per case and model and leaves flagged/ alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-corpus-"));
    await saveBaseline(dir, record("case-a", "m/one", "2026-08-30T00:00:00.000Z"));
    await saveBaseline(dir, record("case-a", "m/one", "2026-08-31T00:00:00.000Z"));
    await saveBaseline(dir, record("case-a", "m/one", "2026-09-01T00:00:00.000Z"));
    await saveBaseline(dir, record("case-a", "m/two", "2026-08-01T00:00:00.000Z"));

    const deleted = await pruneBaselines(dir, 1);
    expect(deleted).toHaveLength(2);

    const remaining = await readdir(join(dir, "case-a"));
    expect(remaining.sort()).toEqual(["m-one_2026-09-01.json", "m-two_2026-08-01.json"]);
    // The survivor is the newest record.
    const kept = JSON.parse(await readFile(join(dir, "case-a", "m-one_2026-09-01.json"), "utf8")) as BaselineRecord;
    expect(kept.savedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects a non-positive keep", async () => {
    await expect(pruneBaselines("/tmp", 0)).rejects.toThrow(/positive integer/);
  });
});
