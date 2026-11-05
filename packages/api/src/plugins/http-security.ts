/**
 * Host bindings for the Security plugin's issue filing routes. Storage stays
 * in the existing Security tables, and filing stays in
 * `services/security-issues.ts`, pending TKAI-378. Each binding checks
 * session access for the host-derived user before the plugin runs.
 */
import type { PluginHttpCaller, PluginHttpRequest } from '@valet/engine';
import {
  handleFindingIssue,
  handleIssueDigest,
  type SecurityEngagementIssues,
  type SecurityFilingFailure,
  type SecurityFindingLink,
  type SecurityIssuesCapability,
} from '@valet/plugin-security';
import { and, eq, inArray } from 'drizzle-orm';
import { publicUrlFromEnv } from '../channels/host.js';
import { userPrincipal } from '../lib/request-principal.js';
import { deriveSecretKey } from '../lib/secret-crypto.js';
import type { Providers } from '../providers/types.js';
import {
  agentSessions,
  securityFindings,
  type SecurityEngagementRow,
  type SecurityFindingLinkRow,
} from '../schema/index.js';
import { createSecurityEngagementService } from '../services/security-engagements.js';
import {
  fileDigestIssue,
  fileFindingIssue,
  IssueRequestError,
  MissingIntegrationError,
  type SecurityIssuesDeps,
} from '../services/security-issues.js';
import { canViewSession } from '../services/session-access.js';
import { buildActionInvoker } from './action-invoker.js';
import type { PluginHttpBinding, PluginHttpBindingContext } from './http-bindings.js';

/** Decision 10 (Security design): review, export, and filing are human actions. */
export const SECURITY_HUMAN_ONLY =
  'This is a human action. Sign in and call it as a user — the internal token is refused here.';

// Filing resolves GitHub or Linear from the acting user's own rows. For a
// team key, that user is the minting administrator, kept for audit only.
const TEAM_KEY_FILING = 'A team API key cannot file issues. Sign in and file them from the session.';

/** The legacy router's refusal bodies. The legacy URLs admit team keys and the internal token to the mount. */
const FILING_REFUSALS = { teamKey: TEAM_KEY_FILING, internalToken: SECURITY_HUMAN_ONLY };

type IssueHandler = (request: PluginHttpRequest, capability: SecurityIssuesCapability) => Promise<Response>;

/** Runs a filing handler after the same session view check the legacy router used. */
async function withSessionIssues(context: PluginHttpBindingContext, handle: IssueHandler): Promise<Response> {
  const { providers, request, caller } = context;
  if (!caller) throw new Error('Security issue filing requires an authenticated caller. Check the route authentication.');
  const { db } = providers;
  const sessionId = request.params.id ?? '';
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  // A missing session and a session the caller cannot view get the same 404.
  if (!session || !(await canViewSession(db, session, userPrincipal(caller.userId)))) {
    return Response.json({ error: 'session not found' }, { status: 404 });
  }
  const found = await createSecurityEngagementService({ db }).getEngagementBySession(sessionId);
  return handle(request, {
    engagement: found ? engagementIssues(issuesDeps(providers, request.url), found.engagement, caller) : null,
  });
}

export const securityHttpBindings: Readonly<Record<string, PluginHttpBinding>> = {
  'finding-issue': {
    method: 'POST', path: '/sessions/:id/findings/:findingId/issues', auth: 'user', refusals: FILING_REFUSALS,
    bind: (context) => withSessionIssues(context, handleFindingIssue),
  },
  'issue-digest': {
    method: 'POST', path: '/sessions/:id/issues/digest', auth: 'user', refusals: FILING_REFUSALS,
    bind: (context) => withSessionIssues(context, handleIssueDigest),
  },
};

/** Filing rides the workflow action invoker with the caller's credentials (Decision 11). */
function issuesDeps(providers: Providers, requestUrl: string): SecurityIssuesDeps {
  const { db, engineCredentials, actionPluginByService, plugins, encryptionKey } = providers;
  const invokeAction = buildActionInvoker({
    db,
    credentials: engineCredentials,
    actionPluginByService,
    plugins,
    githubTokenDeps: { key: deriveSecretKey(encryptionKey) },
  });
  // The channels' rule: prefer the configured public URL, else the request origin.
  return { db, invokeAction, webBaseUrl: publicUrlFromEnv(process.env) ?? new URL(requestUrl).origin };
}

/** Every lookup is scoped to this engagement, and the caller is the actor. */
function engagementIssues(
  deps: SecurityIssuesDeps,
  engagement: SecurityEngagementRow,
  caller: PluginHttpCaller,
): SecurityEngagementIssues {
  const actor = { userId: caller.userId, orgId: caller.orgId };
  return {
    async fileFindingIssue({ findingId, provider, repo, teamId }) {
      const [finding] = await deps.db
        .select()
        .from(securityFindings)
        .where(and(eq(securityFindings.engagementId, engagement.id), eq(securityFindings.id, findingId)))
        .limit(1);
      if (!finding) return { outcome: 'unknown-finding' };
      return classifyFiling(async () => {
        const filed = await fileFindingIssue(deps, { engagement, finding, provider, actor, repo, teamId });
        return { outcome: 'filed', link: toLink(filed.link), created: filed.created };
      });
    },
    async fileDigestIssue({ findingIds, provider, repo, teamId }) {
      const requested = [...new Set(findingIds)];
      const findings = requested.length === 0 ? [] : await deps.db
        .select()
        .from(securityFindings)
        .where(and(eq(securityFindings.engagementId, engagement.id), inArray(securityFindings.id, requested)));
      if (findings.length !== requested.length) return { outcome: 'foreign-findings' };
      return classifyFiling(async () => {
        const digest = await fileDigestIssue(deps, { engagement, findings, provider, actor, repo, teamId });
        return { outcome: 'filed', url: digest.url };
      });
    },
  };
}

/** The legacy mapping: corrective errors become 400, provider faults 502. */
async function classifyFiling<T>(file: () => Promise<T>): Promise<T | SecurityFilingFailure> {
  try {
    return await file();
  } catch (err) {
    if (err instanceof MissingIntegrationError || err instanceof IssueRequestError) {
      return { outcome: 'refused', message: err.message };
    }
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

function toLink(row: SecurityFindingLinkRow): SecurityFindingLink {
  return {
    id: row.id,
    findingId: row.findingId,
    provider: row.provider,
    externalId: row.externalId,
    url: row.url,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
