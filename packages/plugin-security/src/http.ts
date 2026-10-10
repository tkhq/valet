import type { PluginHttpRequest, PluginHttpRoute } from "@valet/engine";

// Security issue filing routes (docs/plans/2026-10-09-security-plugin-adoption.md).
// The host authenticates the caller, checks session access, and calls the
// handlers below with a capability for that session. This module parses
// requests and shapes responses only.

export type SecurityIssueProvider = "github" | "linear";

/** One filed issue for one finding, as the host stores it. */
export interface SecurityFindingLink {
  id: string;
  findingId: string;
  provider: SecurityIssueProvider;
  externalId: string;
  url: string;
  createdBy: string;
  createdAt: number;
}

export interface SecurityIssueTarget {
  provider: SecurityIssueProvider;
  /** GitHub `owner/name`. The engagement repository is the default. */
  repo?: string;
  /** Linear team ID. Linear filing requires it. */
  teamId?: string;
}

/** Errors that the caller can correct get `refused`; provider faults get `failed`. */
export type SecurityFilingFailure = { outcome: "refused"; message: string } | { outcome: "failed"; message: string };

export type SecurityFindingIssueResult =
  | { outcome: "filed"; link: SecurityFindingLink; created: boolean }
  | { outcome: "unknown-finding" }
  | SecurityFilingFailure;

export type SecurityDigestIssueResult =
  | { outcome: "filed"; url: string }
  | { outcome: "foreign-findings" }
  | SecurityFilingFailure;

/** Filing for one engagement, as the caller the host authorized. */
export interface SecurityEngagementIssues {
  fileFindingIssue(input: SecurityIssueTarget & { findingId: string }): Promise<SecurityFindingIssueResult>;
  fileDigestIssue(input: SecurityIssueTarget & { findingIds: string[] }): Promise<SecurityDigestIssueResult>;
}

/** The host builds this after the caller passes the session view check. */
export interface SecurityIssuesCapability {
  /** Null when the session has no security engagement. */
  readonly engagement: SecurityEngagementIssues | null;
}

export interface SecurityFileIssueBody {
  link: SecurityFindingLink;
  created: boolean;
}

export interface SecurityDigestIssueBody {
  url: string;
}

const NO_ENGAGEMENT =
  "This session has no security engagement. Create the session with kind 'security' to start one.";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (message: string, status: number) => json({ error: message }, status);

/** A body that is not a JSON object reads as `{}`, so field checks name the fix. */
function readObject(request: PluginHttpRequest): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(request.rawBody));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { ...parsed };
  } catch {
    // Malformed JSON gets the same corrective 400 as a missing field.
  }
  return {};
}

type TargetParse = { target: SecurityIssueTarget } | { failure: Response };

function parseTarget(body: Record<string, unknown>, requireFindingIds: boolean): TargetParse {
  const provider = body.provider;
  if (provider !== "github" && provider !== "linear") {
    return { failure: error("provider must be 'github' or 'linear'.", 400) };
  }
  if (requireFindingIds && !isNonEmptyStringList(body.findingIds)) {
    return { failure: error("Send { findingIds } with at least one finding id.", 400) };
  }
  if (body.repo !== undefined && typeof body.repo !== "string") {
    return { failure: error("repo must be an owner/name string.", 400) };
  }
  if (body.teamId !== undefined && typeof body.teamId !== "string") {
    return { failure: error("teamId must be a Linear team id string.", 400) };
  }
  return {
    target: {
      provider,
      ...(typeof body.repo === "string" ? { repo: body.repo } : {}),
      ...(typeof body.teamId === "string" ? { teamId: body.teamId } : {}),
    },
  };
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

function filingFailure(result: SecurityFilingFailure): Response {
  return error(result.message, result.outcome === "refused" ? 400 : 502);
}

/** The declared handlers run only on a host without the Security bindings. */
function unbound(): Response {
  return error("This Security route needs host capabilities. Run the bundled Security plugin in the Valet API.", 501);
}

/**
 * POST /sessions/:id/findings/:findingId/issues { provider, repo?, teamId? }:
 * one issue for one finding. A repeat answers the stored link.
 */
export async function handleFindingIssue(request: PluginHttpRequest, capability: SecurityIssuesCapability): Promise<Response> {
  const issues = capability.engagement;
  if (!issues) return error(NO_ENGAGEMENT, 404);
  const parsed = parseTarget(readObject(request), false);
  if ("failure" in parsed) return parsed.failure;
  const findingId = request.params.findingId;
  const result = await issues.fileFindingIssue({ ...parsed.target, findingId });
  if (result.outcome === "unknown-finding") return error(`No finding ${findingId} in this engagement.`, 404);
  if (result.outcome !== "filed") return filingFailure(result);
  const body: SecurityFileIssueBody = { link: result.link, created: result.created };
  return json(body);
}

/**
 * POST /sessions/:id/issues/digest { provider, findingIds, repo?, teamId? }:
 * one digest issue for many findings. It writes no link rows.
 */
export async function handleIssueDigest(request: PluginHttpRequest, capability: SecurityIssuesCapability): Promise<Response> {
  const issues = capability.engagement;
  if (!issues) return error(NO_ENGAGEMENT, 404);
  const body = readObject(request);
  const parsed = parseTarget(body, true);
  if ("failure" in parsed) return parsed.failure;
  const findingIds = isNonEmptyStringList(body.findingIds) ? [...new Set(body.findingIds)] : [];
  const result = await issues.fileDigestIssue({ ...parsed.target, findingIds });
  if (result.outcome === "foreign-findings") {
    return error("Every finding in { findingIds } must belong to this engagement.", 400);
  }
  if (result.outcome !== "filed") return filingFailure(result);
  const response: SecurityDigestIssueBody = { url: result.url };
  return json(response);
}

/**
 * Route descriptors. The Valet API binds each route ID to the handler above
 * of the same purpose, with a capability for the session in the path.
 */
export const securityHttpRoutes: PluginHttpRoute[] = [
  {
    id: "finding-issue", method: "POST", path: "/sessions/:id/findings/:findingId/issues", auth: "user",
    maxBodyBytes: 16 * 1024, handle: unbound,
  },
  {
    // Room for several thousand finding IDs.
    id: "issue-digest", method: "POST", path: "/sessions/:id/issues/digest", auth: "user",
    maxBodyBytes: 256 * 1024, handle: unbound,
  },
];
