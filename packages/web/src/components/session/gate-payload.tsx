/**
 * Previews of what a gated tool call does: the Slack message, the email, the
 * pull request merge. An approval card shows one instead of the raw
 * `tool_id=`/`args=` block that the engine appends to the gate body.
 *
 * A tool with no preview here, or a call without an arg that its preview
 * needs, gets no preview. The card then shows the raw body as before.
 * Arg values come from the model or a third party. They render as text, or
 * through `Markdown`, which allows no raw HTML.
 */
import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { GitMerge, GitPullRequest, Mail, MessageSquare, type LucideIcon } from "lucide-react";
import { Button, cardClass } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { cn } from "~/lib/cn";

export interface GateTool {
  id: string;
  args?: Record<string, unknown>;
}

interface PayloadView {
  icon: LucideIcon;
  heading: string;
  rows?: Array<{ label: string; value: string }>;
  /** The markdown that the call posts or sends. */
  text?: string;
  note?: string;
}

type Args = Record<string, unknown>;

/** A string arg that is not blank. */
function str(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A positive integer arg. The model can send a number as a string ("42"). */
function int(args: Args, key: string): number | undefined {
  const raw = args[key];
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** One address or a list of addresses, blanks dropped. */
function addresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function repository(args: Args): string | undefined {
  const owner = str(args, "owner");
  const repo = str(args, "repo");
  return owner && repo ? `${owner}/${repo}` : undefined;
}

function optionalText(args: Args, key: string): Pick<PayloadView, "text"> {
  const text = str(args, key);
  return text ? { text } : {};
}

const BLOCKS_NOTE = "Slack shows a Block Kit layout instead of this text. Open Details to see it.";

function slackPost(args: Args): PayloadView | null {
  const channel = str(args, "channel");
  const text = str(args, "text");
  if (!channel || !text) return null;
  return {
    icon: MessageSquare,
    heading: `Slack · ${channel}${str(args, "thread_ts") ? " · in a thread" : ""}`,
    text,
    ...(str(args, "blocks") ? { note: BLOCKS_NOTE } : {}),
  };
}

function slackText(heading: string, args: Args): PayloadView | null {
  const text = str(args, "text");
  return text ? { icon: MessageSquare, heading, text } : null;
}

function slackDm(args: Args): PayloadView | null {
  const user = str(args, "user");
  return user ? slackText(`Slack DM · ${user}`, args) : null;
}

function email(label: string, args: Args): PayloadView | null {
  const to = addresses(args.to);
  const { subject, body } = args;
  if (to.length === 0 || typeof subject !== "string" || typeof body !== "string") return null;
  const cc = addresses(args.cc);
  const bcc = addresses(args.bcc);
  return {
    icon: Mail,
    heading: label,
    rows: [
      { label: "To", value: to.join(", ") },
      ...(cc.length > 0 ? [{ label: "Cc", value: cc.join(", ") }] : []),
      ...(bcc.length > 0 ? [{ label: "Bcc", value: bcc.join(", ") }] : []),
      { label: "Subject", value: subject.trim() || "(no subject)" },
    ],
    ...optionalText(args, "body"),
  };
}

function reviewVerdict(event: string | undefined): string {
  switch (event) {
    case "COMMENT":
      return "Comment";
    case "REQUEST_CHANGES":
      return "Request changes";
    case undefined:
      return "Pending, not submitted";
    default:
      return event;
  }
}

/** Preview builders by tool id. A Map, so an id such as "constructor" finds
 * nothing. */
const VIEWS = new Map<string, (args: Args) => PayloadView | null>([
  ["slack.send_message", slackPost],
  ["slack_user.post_message", slackPost],
  ["slack.dm_user", slackDm],
  ["slack_user.send_dm", slackDm],
  ["slack.dm_owner", (args) => slackText("Slack DM · owner", args)],
  ["slack.reply_to_origin", (args) => slackText("Slack reply", args)],
  ["slack.update_message", (args) => {
    const channel = str(args, "channel");
    return channel && str(args, "ts") ? slackText(`Edit Slack message · ${channel}`, args) : null;
  }],
  ["gmail.send_email", (args) => email("Email", args)],
  ["gmail.create_draft", (args) => email("Email draft", args)],
  ["gmail.update_draft", (args) => str(args, "draftId") ? email("Email draft", args) : null],
  ["gmail.send_draft", (args) => {
    const draftId = str(args, "draftId");
    return draftId ? { icon: Mail, heading: `Send email draft ${draftId}` } : null;
  }],
  ["github.merge_pull_request", (args) => {
    const repo = repository(args);
    const pr = int(args, "pullNumber");
    if (!repo || pr === undefined) return null;
    const commitTitle = str(args, "commitTitle");
    return {
      icon: GitMerge,
      heading: `Merge ${repo} #${pr}`,
      rows: [
        { label: "Method", value: str(args, "mergeMethod") ?? "merge" },
        ...(commitTitle ? [{ label: "Commit title", value: commitTitle }] : []),
      ],
    };
  }],
  ["github.create_pull_request", (args) => {
    const repo = repository(args);
    const title = str(args, "title");
    const head = str(args, "head");
    const base = str(args, "base");
    if (!repo || !title || !head || !base) return null;
    return {
      icon: GitPullRequest,
      heading: `Open ${args.draft === true ? "draft " : ""}pull request · ${repo}`,
      rows: [{ label: "Title", value: title }, { label: "Branches", value: `${head} → ${base}` }],
      ...optionalText(args, "body"),
    };
  }],
  ["github.create_comment", (args) => {
    const repo = repository(args);
    const issue = int(args, "issueNumber");
    const text = str(args, "body");
    return repo && issue !== undefined && text ? { icon: MessageSquare, heading: `Comment on ${repo} #${issue}`, text } : null;
  }],
  ["github.create_review", (args) => {
    const repo = repository(args);
    const pr = int(args, "pullNumber");
    const { event } = args;
    if (!repo || pr === undefined || (event !== undefined && typeof event !== "string")) return null;
    const lineComments = Array.isArray(args.comments) ? args.comments.length : 0;
    return {
      icon: GitPullRequest,
      heading: `Review ${repo} #${pr}`,
      rows: [
        { label: "Verdict", value: reviewVerdict(event) },
        ...(lineComments > 0 ? [{ label: "Line comments", value: String(lineComments) }] : []),
      ],
      ...optionalText(args, "body"),
    };
  }],
]);

function payloadView(tool: GateTool): PayloadView | null {
  const view = VIEWS.get(tool.id);
  return view && tool.args ? view(tool.args) : null;
}

/** True when `GatePayloadPreview` renders a preview for this call. */
export function hasGatePayloadPreview(tool: GateTool): boolean {
  return payloadView(tool) !== null;
}

/** What the gated call does, or null for a tool with no preview. */
export function GatePayloadPreview({ tool }: { tool: GateTool }) {
  const view = payloadView(tool);
  if (!view) return null;
  const Icon = view.icon;
  return (
    <div role="group" aria-label="Preview" className={cn(cardClass, "min-w-0 px-3 py-2.5 text-sm text-ink")}>
      <p className="flex min-w-0 items-start gap-2 font-medium">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{view.heading}</span>
      </p>
      {view.rows && (
        <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          {view.rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="text-muted">{row.label}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {view.text && <ClampedMarkdown text={view.text} />}
      {view.note && <p className="mt-2 text-xs text-muted">{view.note}</p>}
    </div>
  );
}

/** Markdown cut to about eight lines. A taller text gets a Show all toggle. */
function ClampedMarkdown({ text }: { text: string }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = box.current;
    if (expanded || !element) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [expanded, text]);

  return (
    <>
      <div ref={box} id={id} className={cn("mt-2 min-w-0", !expanded && "max-h-48 overflow-hidden")}>
        <Markdown>{text}</Markdown>
      </div>
      {(overflows || expanded) && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mt-1"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      )}
    </>
  );
}

/** A tool approval body split into its summary and the `tool_id=`/`args=`
 * block after it. A body without that block is all summary. */
export function splitGateBody(body: string): { summary?: string; call?: string } {
  const lines = body.split("\n");
  // The args JSON is indented, so no line in it starts with "tool_id=". The
  // last such line starts the block, even when the summary quotes one.
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i]?.startsWith("tool_id=") && lines[i + 1]?.startsWith("args=")) {
      const summary = lines.slice(0, i).join("\n").trim();
      return { ...(summary ? { summary } : {}), call: lines.slice(i).join("\n") };
    }
  }
  const summary = body.trim();
  return summary ? { summary } : {};
}

/** The gate body without the trailing `tool_id=`/`args=` block. */
export function gateSummaryText(body?: string): string | undefined {
  return body === undefined ? undefined : splitGateBody(body).summary;
}
