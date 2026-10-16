/**
 * Arm checks for `wait_for_event` (spec 2026-10-15: event wakeups, Part D1).
 * `checkArm` parses the subject and runs the refusals in order; the wakeups
 * seam creates the event waiter only when every check passes.
 *
 * R3 is the visibility rule (INV-E1): the subject is read once with the
 * calling turn's credential provider, the same credentials the agent's own
 * tool calls get. Every provider call is bounded by a timeout, and a call
 * that does not answer in time reads as "cannot read" (R3), never a hang.
 */
import {
  subjectService,
  type ArmEventRequest,
  type CredentialProvider,
  type CredentialStore,
  type EventClause,
  type SessionStore,
  type ValetPlugin,
} from "@valet/engine";
import { identityForUser } from "../channels/identity-links.js";
import type { AppDb } from "../lib/drizzle.js";
import type { Providers } from "../providers/types.js";
import { loadAppConfig } from "../services/github-app.js";
import { resolveGithubApiUrl } from "../services/github-env.js";
import { installationResolvesFor } from "../services/github-tokens.js";
import { LINEAR_CLIENT_CREDENTIALS_GRANT, LINEAR_CREDENTIAL_SERVICE } from "../services/linear-app.js";
import { channelVisibility, orgSlackCredential } from "../services/thread-access.js";
import { findFollowedThread } from "./followed-threads.js";
import { catalogForService } from "./ingest.js";
import { keyMatches } from "./waiter-match.js";
import { boundedFetch, withTimeout } from "./waiters.js";

/** The longest time an arm check waits for one provider call. */
export const ARM_PROVIDER_TIMEOUT_MS = 4_000;

/** A GitHub subject's target. `number` is a pull request or issue; `sha` a commit. */
export interface GithubTarget {
  owner: string;
  repo: string;
  number?: number;
  sha?: string;
}

/** `conversations.info` for one channel, read with the session's Slack credential. */
export type SlackChannelRead =
  | { ok: true; isPrivate: boolean; isMember: boolean; name?: string }
  | { ok: false; reason: "not_found" | "error" };

/** A Linear subject's target. */
export type LinearTarget = { issue: string } | { teamKey: string };

/**
 * What the arm checks read. The production implementation is `armDeps`;
 * tests stub each read. Every function answers for one session and one
 * calling turn.
 */
export interface ArmDeps {
  plugins: ValetPlugin[];
  /** R7: whether the org has the service connected. */
  serviceConnected(service: string): Promise<boolean>;
  /** R2: whether the org's GitHub App installation covers the owner. */
  githubInstallationCovers(owner: string): Promise<boolean>;
  /** The team id of the org's connected Slack workspace, or null. */
  slackTeamId(): Promise<string | null>;
  /** R3 for GitHub. `pullRequest` is set for a `#n` target. */
  readGithub(target: GithubTarget): Promise<{ readable: boolean; pullRequest?: boolean }>;
  /** R3 and R4 for Slack. */
  readSlackChannel(channelId: string): Promise<SlackChannelRead>;
  /** R3 for Slack: the session's channel visibility rule. */
  sessionMayReadSlackChannel(channelId: string, isPrivate: boolean): Promise<boolean>;
  /** R3 for Linear: a read with the session's own Linear credential. */
  readLinear(target: LinearTarget): Promise<boolean>;
  /** R6: whether this thread already receives the Slack thread's replies through a follow. */
  followsSlackThread(threadId: string, channelId: string, threadTs: string): Promise<boolean>;
  /** The external actor ids the session acts as for the service (spec Part E, `self`). */
  selfIds(service: string): Promise<string[]>;
}

export interface ArmContext {
  sessionId: string;
  threadId: string;
  orgId: string;
}

export type ArmCheckResult = { ok: true; subjects: string[]; self: string[] } | { ok: false; text: string };

const SERVICE_NAMES: Record<string, string> = { github: "GitHub", slack: "Slack", linear: "Linear" };

/** The derived keys that need one kind of subject (controller ruling for Task 11). */
const DERIVED_NEEDS_PULL_REQUEST = new Set(["github.pull_request.checks_completed"]);

// Refusal texts, verbatim from spec Part D1.
const R1 = (input: string) =>
  `[wait_for_event] ${input} is not a supported subject. Give a GitHub pull request, issue, commit, or repository URL, a Slack message permalink, or a Linear issue or team URL.`;
const R2 = (owner: string, repo: string) =>
  `[wait_for_event] The GitHub App installation does not cover ${owner}/${repo}. Install the app on that repository, then wait again.`;
const R3 = (subject: string) =>
  `[wait_for_event] This session cannot read ${subject}. Connect an account that can, or ask an admin to grant the app access.`;
const R4 = (channel: string) =>
  `[wait_for_event] Valet is not in ${channel}, so it does not receive its messages. Invite @Valet to the channel, then wait again.`;
const R5 = (key: string, service: string) =>
  `[wait_for_event] ${key} is not an event key for ${service}. Call workflows.list_event_types for the keys.`;
const R5_PULL_REQUEST = (key: string) =>
  `[wait_for_event] ${key} needs a pull request subject. Pass the pull request URL.`;
const R6 = "[wait_for_event] This thread already receives replies from that Slack thread. No wait is needed.";
const R7 = (service: string) =>
  `[wait_for_event] ${SERVICE_NAMES[service] ?? service} is not connected for this organization. Connect it in Settings, Integrations.`;

/** A parsed subject: the canonical string and its service target. */
type ParsedSubject =
  | { service: "github"; subject: string; target: GithubTarget }
  | { service: "slack"; subject: string; team: string; channel: string; threadTs?: string }
  | { service: "linear"; subject: string; target: LinearTarget };

const GITHUB_SUBJECT_RE = /^github:([^/#@]+)\/([^/#@]+)(?:#(\d+)|@([0-9a-f]+))?$/i;
// `?` is the team placeholder a permalink parses to (spec Part A5).
const SLACK_SUBJECT_RE = /^slack:([A-Z0-9]+|\?)\/([A-Z0-9]+)(?:\/(\d+\.\d+))?$/i;
const LINEAR_SUBJECT_RE = /^linear:(?:team\/([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+))$/;

/**
 * The subject a URL or subject string names, or null (R1). A plugin's
 * `eventSubjects.fromUrl` parses URLs; a canonical Slack subject, which no
 * plugin parses, is read here. A GitHub owner alone is not a subject the
 * tool supports (spec R1 lists the supported kinds).
 */
function parseSubject(plugins: readonly ValetPlugin[], input: string): ParsedSubject | null {
  let subject: string | null = null;
  if (SLACK_SUBJECT_RE.test(input) && !input.startsWith("slack:?")) subject = input;
  for (const plugin of plugins) {
    if (subject) break;
    subject = plugin.eventSubjects?.fromUrl(input)?.subject ?? null;
  }
  if (!subject) return null;
  const service = subjectService(subject);
  if (service === "github") {
    const m = GITHUB_SUBJECT_RE.exec(subject);
    if (!m) return null;
    const owner = m[1]!.toLowerCase();
    const repo = m[2]!.toLowerCase();
    if (m[3]) return { service, subject: `github:${owner}/${repo}#${m[3]}`, target: { owner, repo, number: Number(m[3]) } };
    if (m[4]) return { service, subject: `github:${owner}/${repo}@${m[4].toLowerCase()}`, target: { owner, repo, sha: m[4].toLowerCase() } };
    return { service, subject: `github:${owner}/${repo}`, target: { owner, repo } };
  }
  if (service === "slack") {
    const m = SLACK_SUBJECT_RE.exec(subject);
    if (!m) return null;
    return { service, subject, team: m[1]!, channel: m[2]!, ...(m[3] ? { threadTs: m[3] } : {}) };
  }
  if (service === "linear") {
    const m = LINEAR_SUBJECT_RE.exec(subject);
    if (!m) return null;
    return { service, subject, target: m[1] ? { teamKey: m[1] } : { issue: m[2]! } };
  }
  return null;
}

/** R5: the first clause whose key is in no catalog of the subject's service, as its refusal. */
function clauseRefusal(plugins: ValetPlugin[], parsed: ParsedSubject, clauses: readonly EventClause[]): string | null {
  const catalog = catalogForService(plugins, parsed.service);
  for (const clause of clauses) {
    const known = catalog.some((entry) => entry.key === clause.key || keyMatches(clause.key, entry.key));
    if (!known) return R5(clause.key, parsed.service);
    if (DERIVED_NEEDS_PULL_REQUEST.has(clause.key) && (parsed.service !== "github" || parsed.target.number === undefined)) {
      return R5_PULL_REQUEST(clause.key);
    }
  }
  return null;
}

/** A provider call bounded by `ms`. A timeout or a throw yields `fallback`. */
async function bounded<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  try {
    return await withTimeout(work(), ms, fallback);
  } catch (err) {
    console.warn("[wait_for_event] an arm check read failed; it counts as a refusal:", err);
    return fallback;
  }
}

/**
 * Runs the arm checks of spec Part D1 for one `wait_for_event` call. The
 * order is R1, R5, R7, R2, R3, R4, R6 (spec D1 errata): the checks that
 * need no provider call run first, and a disconnected service gets the
 * connect hint before any read. The tool checks R8 before it calls the
 * seam, and R9 is the seam's missing `armEvent`.
 */
export async function checkArm(
  deps: ArmDeps,
  ctx: ArmContext,
  req: ArmEventRequest,
  opts: { timeoutMs?: number } = {},
): Promise<ArmCheckResult> {
  const ms = opts.timeoutMs ?? ARM_PROVIDER_TIMEOUT_MS;
  const parsed = parseSubject(deps.plugins, req.subject);
  if (!parsed) return { ok: false, text: R1(req.subject) };

  const r5 = clauseRefusal(deps.plugins, parsed, req.on);
  if (r5) return { ok: false, text: r5 };

  if (!(await bounded(() => deps.serviceConnected(parsed.service), ms, false))) {
    return { ok: false, text: R7(parsed.service) };
  }

  let subject = parsed.subject;
  if (parsed.service === "github") {
    const { owner, repo } = parsed.target;
    if (!(await bounded(() => deps.githubInstallationCovers(owner), ms, false))) {
      return { ok: false, text: R2(owner, repo) };
    }
    const read = await bounded(() => deps.readGithub(parsed.target), ms, { readable: false });
    if (!read.readable) return { ok: false, text: R3(subject) };
    const needsPr = req.on.find((clause) => DERIVED_NEEDS_PULL_REQUEST.has(clause.key));
    if (needsPr && read.pullRequest === false) return { ok: false, text: R5_PULL_REQUEST(needsPr.key) };
  } else if (parsed.service === "slack") {
    const team = await bounded(() => deps.slackTeamId(), ms, null);
    if (!team) return { ok: false, text: R7("slack") };
    // A canonical subject from another workspace is outside this org.
    if (parsed.team !== "?" && parsed.team !== team) return { ok: false, text: R3(parsed.subject) };
    subject = `slack:${team}/${parsed.channel}${parsed.threadTs ? `/${parsed.threadTs}` : ""}`;
    const unread: SlackChannelRead = { ok: false, reason: "error" };
    const info = await bounded(() => deps.readSlackChannel(parsed.channel), ms, unread);
    // The bot cannot see a channel it is not in: inviting it is the fix.
    if (!info.ok) return { ok: false, text: info.reason === "not_found" ? R4(`<#${parsed.channel}>`) : R3(subject) };
    if (!(await bounded(() => deps.sessionMayReadSlackChannel(parsed.channel, info.isPrivate), ms, false))) {
      return { ok: false, text: R3(subject) };
    }
    if (!info.isMember) return { ok: false, text: R4(info.name ? `#${info.name}` : `<#${parsed.channel}>`) };
    const threadTs = parsed.threadTs;
    if (threadTs && (await bounded(() => deps.followsSlackThread(ctx.threadId, parsed.channel, threadTs), ms, false))) {
      return { ok: false, text: R6 };
    }
  } else {
    if (!(await bounded(() => deps.readLinear(parsed.target), ms, false))) return { ok: false, text: R3(subject) };
  }

  const self = await bounded(() => deps.selfIds(parsed.service), ms, []);
  return { ok: true, subjects: [subject], self: [...new Set(self)] };
}

/** The providers `armDeps` reads. */
export type ArmProviders = Pick<Providers, "engineCredentials" | "plugins"> & {
  db: AppDb;
  engineStore: Pick<SessionStore, "getThread">;
  onePassword?: Providers["onePassword"];
};

/** The session an arm check runs for. */
export interface ArmSession {
  sessionId: string;
  orgId: string;
  ownerType: "user" | "team" | "org";
  ownerId: string;
}

export interface ArmDepsOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  githubApiUrl?: string;
  slackApiUrl?: string;
  linearApiUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A JSON body, or undefined when the body is not JSON. */
async function jsonOf(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(await res.json());
  } catch {
    return undefined;
  }
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * The production `ArmDeps` for one session and one calling turn.
 * `credentials` is the turn's credential provider (`ToolContext.credentials`);
 * without it every read is a refusal.
 */
export function armDeps(
  providers: ArmProviders,
  session: ArmSession,
  credentials: CredentialProvider | undefined,
  opts: ArmDepsOptions = {},
): ArmDeps {
  const env = opts.env ?? process.env;
  const http = boundedFetch(opts.fetch ?? fetch, opts.timeoutMs ?? ARM_PROVIDER_TIMEOUT_MS);
  const githubApi = opts.githubApiUrl ?? resolveGithubApiUrl(env);
  const slackApi = opts.slackApiUrl ?? "https://slack.com/api";
  const linearApi = opts.linearApiUrl ?? (env.LINEAR_API_URL || "https://api.linear.app");
  const store: CredentialStore = providers.engineCredentials;
  const appDeps = { db: providers.db, credentials: store, env };
  const accessDeps = { db: providers.db, engineCredentials: store, ...(providers.onePassword ? { onePassword: providers.onePassword } : {}) };

  let orgSlack: ReturnType<typeof orgSlackCredential> | undefined;
  const slackOrg = () => (orgSlack ??= orgSlackCredential(accessDeps, session.orgId));
  const token = async (service: string): Promise<{ token: string; metadata?: Record<string, unknown> } | null> => {
    const credential = await credentials?.get(service);
    return credential?.accessToken ? { token: credential.accessToken, ...(credential.metadata ? { metadata: credential.metadata } : {}) } : null;
  };

  const github = (path: string, bearer?: string) =>
    http(`${githubApi}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "valet",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
    });
  const slack = (method: string, bearer: string, params: Record<string, string> = {}) =>
    http(`${slackApi}/${method}?${new URLSearchParams(params).toString()}`, { headers: { Authorization: `Bearer ${bearer}` } });
  const linear = (bearer: string, query: string, variables: Record<string, string> = {}) =>
    http(`${linearApi}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query, variables }),
    });

  /** The session's own Linear credential: never the org's app-actor token. */
  const ownLinearToken = async (): Promise<string | null> => {
    const own = await token("linear");
    if (!own || own.metadata?.grant === LINEAR_CLIENT_CREDENTIALS_GRANT) return null;
    return own.token;
  };

  /** The actor id behind a token: GitHub `/user`, Slack `auth.test`, Linear `viewer`. Undefined when unknown. */
  const whoami = async (service: string, bearer: string): Promise<string | undefined> => {
    if (service === "github") {
      const res = await github("/user", bearer);
      return res.ok ? idOf((await jsonOf(res))?.id) : undefined;
    }
    if (service === "slack") {
      const body = await jsonOf(await slack("auth.test", bearer));
      return body?.ok === true ? idOf(body.user_id) : undefined;
    }
    if (service === "linear") {
      const body = await jsonOf(await linear(bearer, "{ viewer { id } }"));
      return idOf(asRecord(asRecord(body?.data)?.viewer)?.id);
    }
    return undefined;
  };

  /** The app's actor id for the service: the GitHub App bot user, the Slack bot user, the Linear app actor. */
  const appActor = async (service: string, sessionToken: string | undefined): Promise<string | undefined> => {
    if (service === "github") {
      const config = await loadAppConfig(appDeps, session.orgId);
      if (!config) return undefined;
      const res = await github(`/users/${encodeURIComponent(`${config.appSlug}[bot]`)}`, sessionToken);
      return res.ok ? idOf((await jsonOf(res))?.id) : undefined;
    }
    if (service === "slack") {
      return idOf((await slackOrg())?.metadata?.botUserId);
    }
    if (service === "linear") {
      const app = await store.get({ type: "org", id: session.orgId }, LINEAR_CREDENTIAL_SERVICE);
      if (app?.metadata?.grant !== LINEAR_CLIENT_CREDENTIALS_GRANT || !app.accessToken) return undefined;
      return whoami("linear", app.accessToken);
    }
    return undefined;
  };

  return {
    plugins: providers.plugins,

    async serviceConnected(service) {
      if (service === "github") return (await loadAppConfig(appDeps, session.orgId)) !== null;
      if (service === "slack") return (await slackOrg()) !== null;
      if (service === "linear") return (await store.get({ type: "org", id: session.orgId }, LINEAR_CREDENTIAL_SERVICE)) !== null;
      return false;
    },

    async githubInstallationCovers(owner) {
      // Owner coverage only. R3's read with the session's credential
      // catches a repository the installation leaves out.
      return (await installationResolvesFor(appDeps, session.orgId, owner, { strictOwner: true })).ok;
    },

    async slackTeamId() {
      return idOf((await slackOrg())?.metadata?.teamId) ?? null;
    },

    async readGithub(target) {
      const own = await token("github");
      if (!own) return { readable: false };
      const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
      const path = target.number !== undefined
        ? `${base}/issues/${target.number}`
        : target.sha !== undefined ? `${base}/commits/${target.sha}` : base;
      const res = await github(path, own.token);
      if (!res.ok) return { readable: false };
      if (target.number === undefined) return { readable: true };
      // GitHub numbers pull requests and issues in one sequence. An issue
      // read of a pull request carries `pull_request`.
      return { readable: true, pullRequest: asRecord((await jsonOf(res))?.pull_request) !== undefined };
    },

    async readSlackChannel(channelId) {
      const own = await token("slack");
      if (!own) return { ok: false, reason: "error" };
      const body = await jsonOf(await slack("conversations.info", own.token, { channel: channelId }));
      if (body?.ok !== true) return { ok: false, reason: body?.error === "channel_not_found" ? "not_found" : "error" };
      const channel = asRecord(body.channel);
      if (!channel) return { ok: false, reason: "error" };
      const isPrivate = channel.is_private === true || channel.is_im === true || channel.is_mpim === true;
      const name = typeof channel.name === "string" ? channel.name : undefined;
      // The session's Slack credential is the org's bot in every shipped
      // path, so `is_member` is the bot's membership (R4).
      return { ok: true, isPrivate, isMember: channel.is_member === true, ...(name ? { name } : {}) };
    },

    async sessionMayReadSlackChannel(channelId, isPrivate) {
      // A team or org session sees public channels only, the match-time
      // rule (`waiterMatchDeps.slackStillVisible`). A personal session sees
      // what its owner may see.
      if (session.ownerType !== "user") return !isPrivate;
      if (!isPrivate) return true;
      return channelVisibility(accessDeps, { orgId: session.orgId, userId: session.ownerId })(`slack:${channelId}`);
    },

    async readLinear(target) {
      const own = await ownLinearToken();
      if (!own) return false;
      if ("issue" in target) {
        const body = await jsonOf(await linear(own, "query($id: String!) { issue(id: $id) { id } }", { id: target.issue }));
        return idOf(asRecord(asRecord(body?.data)?.issue)?.id) !== undefined;
      }
      const body = await jsonOf(
        await linear(own, "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }", { key: target.teamKey }),
      );
      const nodes = asRecord(asRecord(body?.data)?.teams)?.nodes;
      return Array.isArray(nodes) && nodes.length > 0;
    },

    async followsSlackThread(threadId, channelId, threadTs) {
      // The follow router delivers a followed thread's replies to the
      // owner's thread keyed `slack:<channel>:<thread ts>`.
      const thread = await providers.engineStore.getThread(session.sessionId, threadId);
      if (thread?.key !== `slack:${channelId}:${threadTs}`) return false;
      const follow = await findFollowedThread(providers.db, { orgId: session.orgId, channelType: "slack", channelId, threadTs });
      return follow !== null && follow.ownerType === session.ownerType && follow.ownerId === session.ownerId;
    },

    async selfIds(service) {
      const own = await token(service).catch(() => null);
      const ids = await Promise.allSettled([
        session.ownerType === "user"
          ? identityForUser(providers.db, service, session.ownerId).then((link) => link?.externalId)
          : Promise.resolve(undefined),
        // The resolved credential may be a teammate's shared account. Its
        // events are the session's own too.
        own ? whoami(service, own.token) : Promise.resolve(undefined),
        appActor(service, own?.token),
      ]);
      return [...new Set(ids.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : [])))];
    },
  };
}
