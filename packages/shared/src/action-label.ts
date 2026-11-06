/**
 * A past-tense step line for a plugin action that has no label of its own,
 * built from the action name and its key arguments: "Read Linear issue
 * ENG-123", "Searched Gmail for “invoice”". An action with a `label`
 * function keeps that line. This module has no dependencies because the web
 * app also bundles it.
 */
import { serviceDisplayName } from "./service-display-name.js";

/** Past and present tense for the first word of an action name. */
const VERBS: Record<string, [past: string, present: string, tail?: string]> = {
  get: ["Read", "Reading"],
  read: ["Read", "Reading"],
  fetch: ["Read", "Reading"],
  view: ["Read", "Reading"],
  describe: ["Read", "Reading"],
  inspect: ["Read", "Reading"],
  show: ["Read", "Reading"],
  list: ["Listed", "Listing"],
  search: ["Searched", "Searching"],
  find: ["Searched", "Searching"],
  lookup: ["Looked up", "Looking up"],
  query: ["Queried", "Querying"],
  create: ["Created", "Creating"],
  add: ["Added", "Adding"],
  insert: ["Inserted", "Inserting"],
  append: ["Appended", "Appending"],
  save: ["Saved", "Saving"],
  write: ["Wrote", "Writing"],
  update: ["Updated", "Updating"],
  modify: ["Updated", "Updating"],
  set: ["Set", "Setting"],
  rename: ["Renamed", "Renaming"],
  patch: ["Updated", "Updating"],
  edit: ["Edited", "Editing"],
  replace: ["Replaced", "Replacing"],
  apply: ["Applied", "Applying"],
  format: ["Formatted", "Formatting"],
  resize: ["Resized", "Resizing"],
  delete: ["Deleted", "Deleting"],
  remove: ["Removed", "Removing"],
  trash: ["Moved", "Moving", " to trash"],
  clear: ["Cleared", "Clearing"],
  cancel: ["Canceled", "Canceling"],
  ungroup: ["Ungrouped", "Ungrouping"],
  group: ["Grouped", "Grouping"],
  protect: ["Protected", "Protecting"],
  resolve: ["Resolved", "Resolving"],
  send: ["Sent", "Sending"],
  post: ["Posted", "Posting"],
  reply: ["Replied to", "Replying to"],
  react: ["Reacted to", "Reacting to"],
  upload: ["Uploaded", "Uploading"],
  publish: ["Published", "Publishing"],
  move: ["Moved", "Moving"],
  copy: ["Copied", "Copying"],
  duplicate: ["Duplicated", "Duplicating"],
  merge: ["Merged", "Merging"],
  fork: ["Forked", "Forking"],
  join: ["Joined", "Joining"],
  request: ["Requested", "Requesting"],
  trigger: ["Triggered", "Triggering"],
  rerun: ["Re-ran", "Re-running"],
  generate: ["Generated", "Generating"],
  transcribe: ["Transcribed", "Transcribing"],
  download: ["Downloaded", "Downloading"],
  export: ["Exported", "Exporting"],
  freeze: ["Froze", "Freezing"],
  triage: ["Triaged", "Triaging"],
  dm: ["Messaged", "Messaging"],
  start: ["Started", "Starting"],
  stop: ["Stopped", "Stopping"],
  count: ["Counted", "Counting"],
  analyze: ["Analyzed", "Analyzing"],
  retrieve: ["Read", "Reading"],
  open: ["Opened", "Opening"],
  close: ["Closed", "Closing"],
  assign: ["Assigned", "Assigning"],
  archive: ["Archived", "Archiving"],
  invite: ["Invited", "Inviting"],
  approve: ["Approved", "Approving"],
  comment: ["Commented on", "Commenting on"],
  label: ["Labeled", "Labeling"],
  tag: ["Tagged", "Tagging"],
  finalize: ["Finalized", "Finalizing"],
  schedule: ["Scheduled", "Scheduling"],
  draft: ["Drafted", "Drafting"],
  ask: ["Asked", "Asking"],
  resume: ["Resumed", "Resuming"],
  pause: ["Paused", "Pausing"],
  subscribe: ["Subscribed to", "Subscribing to"],
  mark: ["Marked", "Marking"],
  retry: ["Retried", "Retrying"],
  reset: ["Reset", "Resetting"],
  wait: ["Waited for", "Waiting for"],
};

/** Names the plugin id alone gets wrong: Slack's user plugin and Google's sub-services. */
const SERVICE_NAMES: Record<string, string> = {
  "slack-user": "Slack", slack_user: "Slack",
  openai: "OpenAI", drive: "Google Drive", docs: "Google Docs", sheets: "Google Sheets", slides: "Google Slides", calendar: "Google Calendar",
};

/** Arguments that say what the call looked for, most specific first. */
const QUERY_KEYS = ["query", "q", "search", "search_query", "text_query", "keywords", "term", "filter"];
/** Arguments that say which item the call used, most specific first. */
const ITEM_KEYS = [
  "identifier", "issue_id", "issueId", "issueNumber", "pullNumber", "number", "run_id", "job_id", "name", "title", "newTitle", "summary", "subject", "filename", "file_name", "fileName",
  "sheetName", "tagName", "branch", "path", "url", "link", "imageUrl", "id", "messageId", "draftId", "documentId", "spreadsheetId", "presentationId",
  "fileId", "file_id", "folderId", "threadId", "eventId", "commentId", "channel", "channel_id", "email", "to",
];
/** How an item argument joins the line. A key that is not here joins bare, as in "Read Linear issue ENG-123". */
const ITEM_JOIN: Record<string, (value: string, reading: boolean) => string> = {
  name: (v) => `“${v}”`, title: (v) => `“${v}”`, subject: (v) => `“${v}”`, filename: (v) => `“${v}”`, file_name: (v) => `“${v}”`,
  issueNumber: (v) => `#${v}`, pullNumber: (v) => `#${v}`, number: (v) => `#${v}`, run_id: (v) => v, job_id: (v) => `for job ${v}`,
  sheetName: (v) => `“${v}”`, tagName: (v) => v, branch: (v) => v, summary: (v) => `“${v}”`, newTitle: (v) => `“${v}”`, fileName: (v) => `“${v}”`,
  issue_id: (v, reading) => (reading ? v : `on ${v}`), issueId: (v, reading) => (reading ? v : `on ${v}`),
  to: (v) => `to ${v}`, channel: (v) => `in ${v}`, channel_id: (v) => `in ${v}`,
};
const MAX_TARGET = 60;

/**
 * A link or path as a reader needs it: the host and the last path segment,
 * with no credentials, query string or fragment, which can carry tokens.
 */
function shorten(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const last = url.pathname.split("/").filter(Boolean).at(-1);
      return last ? `${url.hostname}/${decodeURIComponent(last)}` : url.hostname;
    } catch {
      return value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i, "").replace(/[?#].*$/, "");
    }
  }
  return value.replace(/[?#].*$/, "");
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > MAX_TARGET ? `${clean.slice(0, MAX_TARGET - 1)}…` : clean;
}

const LINK_KEYS = new Set(["path", "url", "link", "imageUrl", "output_path"]);

function pick(args: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const raw = args[key];
    const value = text(typeof raw === "string" && (LINK_KEYS.has(key) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim())) ? shorten(raw.trim()) : raw);
    if (value) return { key, value };
  }
  return undefined;
}

/** A bare Slack id such as C01ABCDEF2, or a Google file id, says nothing to a reader. */
function isOpaqueId(value: unknown): boolean {
  return typeof value === "string" && (/^[A-Z][A-Z0-9]{8,}$/.test(value) || /^[A-Za-z0-9_-]{20,}$/.test(value));
}

function singular(word: string): string {
  if (/(ss|us|is)$/.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

function splitAction(actionName: string): { verb?: [past: string, present: string, tail?: string]; words: string[] } {
  const words = actionName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const first = words[0];
  if (first && Object.hasOwn(VERBS, first)) return { verb: VERBS[first], words: words.slice(1) };
  return { words };
}

/**
 * The step line for `actionId` ("linear.get_issue", "get_issue"), or
 * undefined when the verb is unknown. `service` is the plugin id or its
 * display name. A leading product word in the action name, as in the Notion
 * tool "notion-fetch", is dropped.
 */
export function deriveActionLabel(service: string, actionId: string, args: unknown, tense: "past" | "present" = "past"): string | undefined {
  const dot = actionId.indexOf(".");
  const prefix = dot > 0 ? actionId.slice(0, dot) : undefined;
  const name = dot > 0 ? actionId.slice(dot + 1) : actionId;
  const product = SERVICE_NAMES[prefix ?? ""] ?? SERVICE_NAMES[service] ?? serviceDisplayName(service);
  const plain = name.toLowerCase();
  const bare = plain.startsWith(`${service.toLowerCase()}-`) || plain.startsWith(`${service.toLowerCase()}_`) ? plain.slice(service.length + 1) : plain;
  const split = splitAction(bare);
  if (!split.verb) return undefined;
  // "lookup_user_by_email" names the user; the email argument says which one.
  const byAt = split.words.indexOf("by");
  const words = byAt > 0 ? split.words.slice(0, byAt) : split.words;
  const at = tense === "past" ? 0 : 1;
  const verb = split.verb[at];
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const first = bare.split(/[^a-z0-9]+/)[0] ?? "";
  const looking = /^(search|find|query|lookup)$/.test(first);
  const reading = split.verb[0] === "Read";
  // One item names its object in the singular; a list or an edit of many keeps the plural.
  const object = (reading ? [...words.slice(0, -1), singular(words.at(-1) ?? "")] : words).join(" ");
  const query = looking || first === "list" ? pick(record, QUERY_KEYS) : undefined;
  // A list with a query is a search, so the step says so.
  const head = [first === "list" && query ? (at === 0 ? "Searched" : "Searching") : verb, product, object].filter(Boolean).join(" ");
  const tail = split.verb[2] ?? "";
  if (query) return `${head} for “${query.value}”${tail}`;
  const item = first === "list" ? undefined : pick(record, ITEM_KEYS.filter((key) => !isOpaqueId(record[key])));
  if (item) return `${head} ${(ITEM_JOIN[item.key] ?? ((v: string) => v))(item.value, reading)}${tail}`;
  const repo = text(record.owner) && text(record.repo) ? `${text(record.owner)}/${text(record.repo)}` : text(record.repo) ?? text(record.repository);
  if (repo) return `${head} in ${repo}${tail}`;
  return `${head}${tail}`;
}

/**
 * The step line for a tool from a connected MCP server, whose names the
 * plugin does not know in advance. A tool with an unknown verb keeps its own
 * name: "Ran Sentry whoami".
 */
export function deriveMcpToolLabel(service: string, toolName: string, args: unknown, tense: "past" | "present" = "past"): string {
  const derived = deriveActionLabel(service, `${service}.${toolName}`, args, tense);
  if (derived) return derived;
  const product = SERVICE_NAMES[service] ?? serviceDisplayName(service);
  const words = toolName.toLowerCase().replace(new RegExp(`^${service.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_]`), "").split(/[^a-z0-9]+/).filter(Boolean).join(" ");
  return `${tense === "past" ? "Ran" : "Running"} ${product}${words ? ` ${words}` : ""}`;
}
