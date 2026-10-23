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

function taskBlock(task: ProgressTask, terminal: boolean): Record<string, unknown> {
  const unfinished = terminal && ["pending", "in_progress", "waiting"].includes(task.status);
  const status = unfinished || task.status === "interrupted" ? "error" : task.status === "waiting" || task.status === "pending" ? "in_progress" : task.status;
  const details = task.status === "interrupted" ? "Interrupted. This task did not finish."
    : unfinished ? "Not completed in this turn."
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

/** Render the shared snapshot with Slack's native collapsible plan. */
export function progressBlocks(progress: TurnProgress, key: string): { blocks: Record<string, unknown>[]; text: string } {
  const terminal = ["complete", "error", "interrupted"].includes(progress.status);
  const title = `${publicText(progress.title, 180)} · ${LABEL[progress.status]}`;
  const needsState = progress.tasks.length > 0 && ["error", "interrupted", "waiting", "in_progress"].includes(progress.status)
    && !progress.tasks.some(task => task.status === progress.status);
  const tasks = progress.tasks.slice(0, needsState ? 49 : 50);
  const omitted = progress.omittedTasks + Math.max(0, progress.tasks.length - tasks.length);
  const displayed = tasks.length ? [...tasks] : [{ id: `${progress.turnId}:state`, title: LABEL[progress.status], status: progress.status }];
  if (needsState) displayed.push({ id: `${progress.turnId}:state`, title: progress.status === "in_progress" ? "Continue work" : LABEL[progress.status], status: progress.status });
  const blockId = createHash("sha256").update(`${key}:${progress.revision}`).digest("hex");
  const blocks: Record<string, unknown>[] = [{
    type: "plan", block_id: `progress-${blockId}`, title,
    tasks: displayed.map(task => taskBlock(task, terminal)),
  }];
  if (omitted > 0) blocks.push({ type: "context", elements: [{ type: "plain_text", text: `${omitted} more tasks. Open Valet for the full conversation.` }] });
  const text = publicText([title, ...tasks.map(task => `${LABEL[task.status]}: ${task.title}`), ...(omitted ? [`${omitted} more tasks`] : [])].join("\n"), 3500);
  return { blocks, text };
}
