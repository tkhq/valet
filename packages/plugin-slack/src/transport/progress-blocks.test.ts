import { describe, expect, it } from "vitest";
import type { TurnProgress } from "@valet/engine";
import { progressBlocks } from "./progress-blocks.js";

const progress: TurnProgress = {
  turnId: "turn1", title: "Prepare the release", status: "in_progress", revision: "1", updatedAt: 1,
  tasks: [{ id: "read", title: "Read the changelog", status: "complete" }, { id: "group", title: "Group changes", status: "in_progress" }],
  omittedTasks: 0,
};

describe("native Slack progress", () => {
  it("groups stable task IDs in a native plan", () => {
    const view = progressBlocks(progress, "key");
    expect(view.blocks[0]).toMatchObject({ type: "plan", title: "Prepare the release · Working", tasks: [
      { task_id: "read", title: "Read the changelog", status: "complete" },
      { task_id: "group", title: "Group changes", status: "in_progress" },
    ] });
    expect(view.text).toContain("Group changes");
  });

  it("marks interruption explicitly and leaves completed work complete", () => {
    const view = progressBlocks({ ...progress, status: "interrupted", tasks: [progress.tasks[0], { ...progress.tasks[1], status: "interrupted" }] }, "key");
    expect(JSON.stringify(view)).toContain("Interrupted");
    expect(view.blocks[0]).toMatchObject({ tasks: [{ status: "complete" }, { status: "error" }] });
  });

  it("leaves unfinished steps neutral after a successful turn", () => {
    const view = progressBlocks({ ...progress, status: "complete", tasks: [...progress.tasks, { id: "ship", title: "Ship", status: "pending" }] }, "key");
    expect(view.blocks[0]).toMatchObject({ tasks: [{ task_id: "read", status: "complete" }] });
    expect(JSON.stringify(view.blocks)).not.toContain('"in_progress"');
    expect(JSON.stringify(view.blocks)).not.toContain('"error"');
    expect(view.blocks[1]).toMatchObject({ type: "context", elements: [{ text: "2 more steps not done in this turn." }] });
  });

  it("marks unfinished steps not completed after a failed turn", () => {
    const view = progressBlocks({ ...progress, status: "error" }, "key");
    expect(view.blocks[0]).toMatchObject({ tasks: [{ status: "complete" }, { task_id: "group", status: "error" }] });
    expect(JSON.stringify(view.blocks)).toContain("Not completed in this turn");
  });

  it("shows the current step and counts pending steps instead of spinning them", () => {
    const view = progressBlocks({ ...progress, tasks: [...progress.tasks, { id: "a", title: "Write notes", status: "pending" }, { id: "b", title: "Post", status: "pending" }] }, "key");
    expect(view.blocks[0]).toMatchObject({ tasks: [{ task_id: "read" }, { task_id: "group", status: "in_progress" }] });
    expect(JSON.stringify(view.blocks[0])).not.toContain("Write notes");
    expect(view.blocks[1]).toMatchObject({ type: "context", elements: [{ text: "2 more steps planned." }] });
  });

  it("shows waiting and includes omitted tasks without a second message", () => {
    const view = progressBlocks({ ...progress, status: "waiting", tasks: [], omittedTasks: 12 }, "key");
    expect(view.text).toContain("Waiting");
    expect(JSON.stringify(view.blocks)).toContain("12 more tasks");
  });

  it("bounds task count and neutralizes mentions in notification text", () => {
    const tasks = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, title: "<!channel> <@U123>", status: "complete" as const }));
    const view = progressBlocks({ ...progress, title: "<!here>", tasks }, "key");
    expect(view.text).not.toContain("<!here>");
    expect(JSON.stringify(view.blocks)).not.toContain("<!channel>");
    const block = view.blocks[0];
    expect(block.type).toBe("plan");
    expect(Array.isArray(block.tasks) && block.tasks.length <= 50).toBe(true);
  });

  it("keeps a failed turn visible even when its tools completed", () => {
    const view = progressBlocks({ ...progress, status: "error", tasks: [{ id: "read", title: "Read", status: "complete" }] }, "key");
    expect(JSON.stringify(view.blocks)).toContain('"status":"error"');
  });

  it("keeps response preparation active after tools complete", () => {
    const view = progressBlocks({ ...progress, tasks: [{ id: "read", title: "Read", status: "complete" }] }, "key");
    expect(JSON.stringify(view.blocks)).toContain("Continue work");
  });

  it("uses supported native states for queued and future tasks", () => {
    const view = progressBlocks({ ...progress, status: "pending", tasks: [{ id: "future", title: "Check", status: "pending" }] }, "key");
    expect(JSON.stringify(view.blocks)).not.toContain('"status":"pending"');
    expect(JSON.stringify(view.blocks)).toContain("Not started");
  });

  it("changes block IDs per revision while keeping task IDs stable", () => {
    const first = progressBlocks(progress, "key").blocks[0];
    const second = progressBlocks({ ...progress, revision: "2" }, "key").blocks[0];
    expect(first.block_id).not.toBe(second.block_id);
    expect(first.tasks).toEqual(second.tasks);
  });
});
