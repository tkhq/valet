import { createHash } from "node:crypto";
import type { ProgressStatus, ProgressTask, TurnProgress } from "@valet/engine";
import { neutralizeSlackMentions } from "./format.js";

const LABEL: Record<ProgressStatus, string> = {
  pending: "Queued", in_progress: "Working", waiting: "Waiting", complete: "Complete", error: "Failed", interrupted: "Interrupted",
};

function publicText(value: string, limit = 500): string {
  return Array.from(neutralizeSlackMentions(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""))).slice(0, limit).join("");
}

function richText(text: string): Record<string, unknown> {
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: publicText(text, 1200) }] }] };
}

function source(source: { url: string; title: string }): Record<string, unknown> | undefined {
  try {
    const url = new URL(source.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return { type: "url", url: url.href, text: publicText(source.title, 200) };
  } catch { return undefined; }
}

function taskBlock(task: ProgressTask): Record<string, unknown> {
  // A task_card accepts only in_progress, complete, and error. A pending
  // plan step never gets a card; the context line counts it. Only the state
  // row of a queued turn can still be pending here.
  const status = task.status === "interrupted" ? "error" : task.status === "waiting" || task.status === "pending" ? "in_progress" : task.status;
  const details = task.status === "interrupted" ? "Interrupted. This task did not finish."
    : task.status === "pending" ? "Not started."
    : task.status === "waiting" ? task.details ?? "Waiting for your response."
    : task.details;
  const sources = task.sources?.slice(0, 8).map(source).filter(value => value !== undefined);
  return {
    task_id: task.id.length <= 200 ? task.id : createHash("sha256").update(task.id).digest("hex"),
    title: publicText(task.title, 200), status,
    ...(details ? { details: richText(details) } : {}),
    ...(task.output ? { output: richText(task.output) } : {}),
    ...(sources?.length ? { sources } : {}),
  };
}

const UNFINISHED: readonly ProgressStatus[] = ["pending", "in_progress", "waiting"];

/** Render the shared snapshot with Slack's native collapsible plan. */
export function progressBlocks(progress: TurnProgress, key: string): { blocks: Record<string, unknown>[]; text: string } {
  const terminal = ["complete", "error", "interrupted"].includes(progress.status);
  const title = `${publicText(progress.title, 180)} · ${LABEL[progress.status]}`;
  // After a successful turn, an unfinished step is neither running nor failed.
  // After a failed turn, it shows as not completed.
  const hidden = (task: ProgressTask) => progress.status === "complete" ? UNFINISHED.includes(task.status) : !terminal && task.status === "pending";
  const shown = progress.tasks.filter(task => !hidden(task)).map(task => terminal && UNFINISHED.includes(task.status)
    ? { ...task, status: "error" as const, details: "Not completed in this turn." } : task);
  const notShown = progress.tasks.length - shown.length;
  const needsState = shown.length > 0 && ["error", "interrupted", "waiting", "in_progress"].includes(progress.status)
    && !shown.some(task => task.status === progress.status);
  const tasks = shown.slice(0, needsState ? 49 : 50);
  const omitted = progress.omittedTasks + Math.max(0, shown.length - tasks.length);
  const displayed: ProgressTask[] = tasks.length ? [...tasks] : [{ id: `${progress.turnId}:state`, title: LABEL[progress.status], status: progress.status }];
  if (needsState) displayed.push({ id: `${progress.turnId}:state`, title: progress.status === "in_progress" ? "Continue work" : LABEL[progress.status], status: progress.status });
  const blockId = createHash("sha256").update(`${key}:${progress.revision}`).digest("hex");
  const blocks: Record<string, unknown>[] = [{
    type: "plan", block_id: `progress-${blockId}`, title,
    tasks: displayed.map(taskBlock),
  }];
  const notes = [
    ...(notShown > 0 ? [progress.status === "complete" ? `${notShown} more ${notShown === 1 ? "step" : "steps"} not done in this turn.` : `${notShown} more ${notShown === 1 ? "step" : "steps"} planned.`] : []),
    ...(omitted > 0 ? [`${omitted} more tasks. Open Valet for the full conversation.`] : []),
  ];
  if (notes.length) blocks.push({ type: "context", elements: [{ type: "plain_text", text: notes.join(" ") }] });
  const text = publicText([title, ...tasks.map(task => `${LABEL[task.status]}: ${task.title}`), ...notes].join("\n"), 3500);
  return { blocks, text };
}
