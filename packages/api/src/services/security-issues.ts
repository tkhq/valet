/**
 * Valet Security issue filing (spec §Filing issues, Decisions 10 and 11).
 *
 * Human-only egress: the routes refuse the internal token, and no `sec_*`
 * tool reaches this module — content derived from hostile code leaves Valet
 * only on a human's click (Decision 10). Both providers ride the SAME
 * server-side action-invoker seam a workflow tool node uses
 * (`plugins/action-invoker.ts`), with the ACTING user's credentials:
 * GitHub through `github.create_issue` (plugin-github, `issues:write`),
 * Linear through the Linear MCP integration's runtime-discovered
 * `create_issue` tool. No bespoke API clients (Decision 11).
 *
 * Idempotency lives in `security_finding_links`' unique index
 * `(finding_id, provider)`: filing checks for an existing link FIRST and
 * returns it without touching the provider; a lost insert race re-selects
 * the winner. The digest path writes NO link rows — it is a bulk artifact,
 * not per-finding linkage.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { ActionInvocationContext } from "../plugins/action-invoker.js";
import {
  securityFindingLinks,
  type SecurityEngagementRow,
  type SecurityFindingLinkRow,
  type SecurityFindingRow,
} from "../schema/index.js";

export type IssueProvider = "github" | "linear";

/** The action-invoker seam, narrowed so tests fake it with a call counter. */
export type InvokeAction = (
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
) => Promise<WorkflowInvokeActionResult>;

export interface SecurityIssuesDeps {
  db: AppDb;
  invokeAction: InvokeAction;
  /** Absolute web origin for valet permalinks (no trailing slash needed). */
  webBaseUrl: string;
  now?: () => number;
}

/** The acting human. Filing always runs as a user — never the runner. */
export interface IssueActor {
  userId: string;
  orgId: string;
}

/** The integration is not connected. The message IS the corrective copy —
 * the route relays it verbatim as HTTP 400. */
export class MissingIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingIntegrationError";
  }
}

/** A bad request shape (missing team, malformed repo). Route maps to 400. */
export class IssueRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueRequestError";
  }
}

/** The provider failed after a valid request. Route maps to 502. */
export class IssueProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueProviderError";
  }
}

// ── Pure builders ───────────────────────────────────────────────────────────

/** Permalink back to the finding in Valet. The `finding` query param is the
 * triage surface's deep-link hook (M8). */
export function findingPermalink(webBaseUrl: string, sessionId: string, findingId: string): string {
  const base = webBaseUrl.replace(/\/+$/, "");
  return `${base}/sessions/${encodeURIComponent(sessionId)}?finding=${encodeURIComponent(findingId)}`;
}

/** GitHub blob permalink at the engagement's pinned SHA. */
export function blobPermalink(
  repoFullName: string,
  repoRef: string,
  file: string,
  line: number | null,
): string {
  const base = `https://github.com/${repoFullName}/blob/${repoRef}/${file}`;
  return line !== null ? `${base}#L${line}` : base;
}

export function buildIssueTitle(finding: Pick<SecurityFindingRow, "severity" | "title">): string {
  return `[${finding.severity}] ${finding.title}`;
}

/**
 * The issue body is generated from the finding ALONE — never state docs or
 * peer findings (spec threat 11): severity, a blob-permalinked location,
 * the finding body verbatim under an Evidence heading, and the valet
 * permalink.
 */
export function buildIssueBody(args: {
  finding: SecurityFindingRow;
  repoFullName: string;
  repoRef: string;
  valetPermalink: string;
}): string {
  const { finding } = args;
  const lines: string[] = [`Severity: ${finding.severity}`];
  if (finding.file !== null) {
    const location = finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(
      `Location: [${location}](${blobPermalink(args.repoFullName, args.repoRef, finding.file, finding.line)})`,
    );
  }
  lines.push("", "## Evidence", "", finding.body, "", `Found by Valet Security: ${args.valetPermalink}`);
  return lines.join("\n");
}

export function buildDigestTitle(count: number, repoFullName: string): string {
  return `Valet Security: ${count} finding${count === 1 ? "" : "s"} — ${repoFullName}`;
}

/** One checklist line per finding: severity, title, location, valet permalink. */
export function buildDigestBody(args: {
  findings: SecurityFindingRow[];
  repoFullName: string;
  repoRef: string;
  permalinkFor: (findingId: string) => string;
}): string {
  const lines: string[] = [
    `Findings from the Valet Security engagement on ${args.repoFullName} at \`${args.repoRef}\`:`,
    "",
  ];
  for (const finding of args.findings) {
    const location =
      finding.file !== null
        ? ` (\`${finding.line !== null ? `${finding.file}:${finding.line}` : finding.file}\`)`
        : "";
    lines.push(
      `- [ ] [${finding.severity}] ${finding.title}${location} — [view in Valet](${args.permalinkFor(finding.id)})`,
    );
  }
  return lines.join("\n");
}

// ── Provider invocation (one narrow seam for both providers) ───────────────

export interface CreateIssueRequest {
  provider: IssueProvider;
  actor: IssueActor;
  title: string;
  body: string;
  /** GitHub target, `owner/repo` shaped. Required for provider `github`. */
  repoFullName?: string;
  /** Linear team id. Required for provider `linear`. */
  teamId?: string;
}

/**
 * Create one external issue through the action-invoker seam. Every call
 * mints a FRESH `invocationId`: the durable idempotency guard for filing is
 * the `security_finding_links` unique index, not `action_invocations`.
 */
export async function createIssueViaProvider(
  deps: SecurityIssuesDeps,
  req: CreateIssueRequest,
): Promise<{ externalId: string; url: string }> {
  const ctx: ActionInvocationContext = {
    userId: req.actor.userId,
    orgId: req.actor.orgId,
    // The acting user's credentials, never the session owner's — the person
    // who clicks File is the person the issue posts as (Decision 11).
    owner: { type: "user", id: req.actor.userId },
  };
  if (req.provider === "github") {
    const [owner, repo] = (req.repoFullName ?? "").split("/");
    if (!owner || !repo) {
      throw new IssueRequestError(
        `Repository "${req.repoFullName ?? ""}" is not owner/repo shaped. Send { repo } as "owner/name".`,
      );
    }
    const data = await invokeProvider(deps, "github", ctx, {
      service: "github",
      action: "create_issue",
      params: { owner, repo, title: req.title, body: req.body },
      invocationId: mintInvocationId("github"),
    });
    return githubIssueFromResult(data);
  }
  if (!req.teamId) {
    throw new IssueRequestError("Pick a Linear team for this engagement.");
  }
  const data = await invokeProvider(deps, "linear", ctx, {
    service: "linear",
    // The Linear MCP server resolves its tool list at runtime
    // (mcpActionPlugin.resolveActions → tools/list); `create_issue` is the
    // issue-creation tool it exposes, the sibling of the `list_issues` name
    // plugin-linear's templates verified live. A rename upstream fails here
    // with the invoker's own "unknown action" error, not silently.
    action: "create_issue",
    params: { title: req.title, description: req.body, team: req.teamId },
    invocationId: mintInvocationId("linear"),
  });
  return linearIssueFromResult(data);
}

function mintInvocationId(provider: string): string {
  return `sec:issue:${provider}:${randomUUID()}`;
}

/** How each provider signals "no credential connected" through the invoker:
 * plugin-github's `getOctokit` and the invoker's github token service throw
 * from inside `execute` (mapped to `{ ok: false, error }`); the Linear MCP
 * plugin's `resolveActions` throws before any action exists (propagates as
 * a thrown error); the availability gate returns "not configured". Each
 * match maps to the ONE corrective message the dialog shows. */
function missingIntegrationMessage(provider: IssueProvider, raw: string): string | null {
  if (
    provider === "github" &&
    /missing github access token|no github credential|github is not configured/i.test(raw)
  ) {
    return "Connect the GitHub integration in Settings.";
  }
  if (provider === "linear" && /no credential connected|linear is not configured/i.test(raw)) {
    return "Connect the Linear integration in Settings.";
  }
  return null;
}

async function invokeProvider(
  deps: SecurityIssuesDeps,
  provider: IssueProvider,
  ctx: ActionInvocationContext,
  req: WorkflowInvokeActionRequest,
): Promise<unknown> {
  let result: WorkflowInvokeActionResult;
  try {
    result = await deps.invokeAction(req, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = missingIntegrationMessage(provider, message);
    if (missing) throw new MissingIntegrationError(missing);
    throw new IssueProviderError(message);
  }
  if (!result.ok) {
    const message =
      "error" in result && typeof result.error === "string"
        ? result.error
        : `${provider} issue creation is gated by org policy. Ask an org admin to allow it.`;
    const missing = missingIntegrationMessage(provider, message);
    if (missing) throw new MissingIntegrationError(missing);
    throw new IssueProviderError(message);
  }
  return result.result;
}

function githubIssueFromResult(data: unknown): { externalId: string; url: string } {
  if (typeof data === "object" && data !== null) {
    const rec = data as Record<string, unknown>;
    if (typeof rec.number === "number" && typeof rec.html_url === "string") {
      return { externalId: String(rec.number), url: rec.html_url };
    }
  }
  throw new IssueProviderError(
    "GitHub created the issue but the response carried no number/html_url. Check the repository's issue list on GitHub.",
  );
}

/**
 * The Linear MCP action returns its text content as a STRING (see
 * plugin-linear/src/templates.ts) — sometimes JSON text, sometimes prose.
 * Read structured shapes first, then fall back to scraping the issue URL
 * and identifier out of prose.
 */
function linearIssueFromResult(data: unknown): { externalId: string; url: string } {
  const candidates: unknown[] = [data];
  if (typeof data === "string") {
    try {
      candidates.push(JSON.parse(data));
    } catch {
      // Prose response; the regex fallback below handles it.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const rec = candidate as Record<string, unknown>;
    const issue =
      typeof rec.issue === "object" && rec.issue !== null
        ? (rec.issue as Record<string, unknown>)
        : rec;
    if (typeof issue.url === "string" && issue.url.startsWith("http")) {
      const externalId =
        typeof issue.identifier === "string"
          ? issue.identifier
          : typeof issue.id === "string"
            ? issue.id
            : issue.url;
      return { externalId, url: issue.url };
    }
  }
  if (typeof data === "string") {
    const url = data.match(/https:\/\/linear\.app\/\S+/)?.[0]?.replace(/[).,\]"'>]+$/, "");
    if (url) {
      const externalId = data.match(/\b[A-Z][A-Z0-9]*-\d+\b/)?.[0] ?? url;
      return { externalId, url };
    }
  }
  throw new IssueProviderError(
    "Linear created the issue but the response carried no issue URL. Check the team's issue list in Linear.",
  );
}

// ── Filing ──────────────────────────────────────────────────────────────────

export interface FileFindingIssueArgs {
  engagement: SecurityEngagementRow;
  finding: SecurityFindingRow;
  provider: IssueProvider;
  actor: IssueActor;
  /** GitHub target override, `owner/repo`. Defaults to the engagement repo. */
  repo?: string;
  teamId?: string;
}

/**
 * File one issue for one finding. Idempotency FIRST: an existing
 * `(finding, provider)` link returns as-is without touching the provider —
 * a double-click files one issue, not two.
 */
export async function fileFindingIssue(
  deps: SecurityIssuesDeps,
  args: FileFindingIssueArgs,
): Promise<{ link: SecurityFindingLinkRow; created: boolean }> {
  const existing = await selectLink(deps.db, args.finding.id, args.provider);
  if (existing) return { link: existing, created: false };

  const valetPermalink = findingPermalink(deps.webBaseUrl, args.engagement.sessionId, args.finding.id);
  const created = await createIssueViaProvider(deps, {
    provider: args.provider,
    actor: args.actor,
    title: buildIssueTitle(args.finding),
    body: buildIssueBody({
      finding: args.finding,
      repoFullName: args.engagement.repoFullName,
      repoRef: args.engagement.repoRef,
      valetPermalink,
    }),
    repoFullName:
      args.provider === "github" ? (args.repo ?? args.engagement.repoFullName) : undefined,
    teamId: args.teamId,
  });

  const now = deps.now ?? Date.now;
  try {
    const inserted = await deps.db
      .insert(securityFindingLinks)
      .values({
        id: `lnk_${randomUUID()}`,
        findingId: args.finding.id,
        engagementId: args.engagement.id,
        provider: args.provider,
        externalId: created.externalId,
        url: created.url,
        createdBy: args.actor.userId,
        createdAt: now(),
      })
      .returning();
    return { link: inserted[0], created: true };
  } catch (err) {
    // Two concurrent filings raced past the pre-check; the unique index
    // (finding_id, provider) kept one. Return the winner — the loser's
    // provider issue exists upstream, but the link stays single.
    if (isUniqueViolation(err)) {
      const winner = await selectLink(deps.db, args.finding.id, args.provider);
      if (winner) return { link: winner, created: false };
    }
    throw err;
  }
}

export interface FileDigestIssueArgs {
  engagement: SecurityEngagementRow;
  /** Already validated by the route: every row belongs to the engagement. */
  findings: SecurityFindingRow[];
  provider: IssueProvider;
  actor: IssueActor;
  repo?: string;
  teamId?: string;
}

/**
 * One digest issue from many findings: a checklist with per-finding valet
 * permalinks. Writes NO `security_finding_links` rows — the digest is not
 * per-finding linkage, so it is not idempotent either; each call files a
 * new issue.
 */
export async function fileDigestIssue(
  deps: SecurityIssuesDeps,
  args: FileDigestIssueArgs,
): Promise<{ externalId: string; url: string }> {
  if (args.findings.length === 0) {
    throw new IssueRequestError("Send { findingIds } with at least one finding.");
  }
  const body = buildDigestBody({
    findings: args.findings,
    repoFullName: args.engagement.repoFullName,
    repoRef: args.engagement.repoRef,
    permalinkFor: (findingId) =>
      findingPermalink(deps.webBaseUrl, args.engagement.sessionId, findingId),
  });
  return createIssueViaProvider(deps, {
    provider: args.provider,
    actor: args.actor,
    title: buildDigestTitle(args.findings.length, args.engagement.repoFullName),
    body,
    repoFullName:
      args.provider === "github" ? (args.repo ?? args.engagement.repoFullName) : undefined,
    teamId: args.teamId,
  });
}

async function selectLink(
  db: AppDb,
  findingId: string,
  provider: IssueProvider,
): Promise<SecurityFindingLinkRow | null> {
  const rows = await db
    .select()
    .from(securityFindingLinks)
    .where(
      and(eq(securityFindingLinks.findingId, findingId), eq(securityFindingLinks.provider, provider)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Same shape check as security-engagements.ts — Postgres 23505 or PGlite's
 * "duplicate key" message. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec.code === "23505") return true;
  const message = typeof rec.message === "string" ? rec.message : "";
  return message.includes("duplicate key");
}
