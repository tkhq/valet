import type { AgentSession, OrchestratorIdentity, Principal } from '@valet/shared';
import { orchestratorSessionId } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { findPersonaByName, upsertPersonaByName, upsertPersonaFile } from '../lib/db/personas.js';
import {
  restartOrchestratorSessionForOwner,
  type OnboardOrchestratorParams,
  type OnboardOrchestratorResult,
  type OrchestratorActor,
} from './orchestrator.js';

export function teamPrincipal(teamId: string): Principal {
  return { type: 'team', id: teamId };
}

export interface TeamOrchestratorInfo {
  exists: boolean;
  sessionId: string;
  identity: OrchestratorIdentity | null;
  session: AgentSession | null;
  needsRestart: boolean;
}

export async function getTeamOrchestratorInfo(env: Env, appDb: AppDb, teamId: string): Promise<TeamOrchestratorInfo> {
  const owner = teamPrincipal(teamId);
  const identity = await db.getOrchestratorIdentityByOwner(appDb, owner);
  const session = await db.getCurrentOrchestratorSessionByOwner(env.DB, owner);
  return {
    exists: !!identity,
    sessionId: session?.id ?? orchestratorSessionId(owner),
    identity,
    session,
    needsRestart: !!identity && !session,
  };
}

export async function onboardTeamOrchestrator(
  env: Env,
  teamId: string,
  actor: OrchestratorActor,
  params: OnboardOrchestratorParams,
  requestUrl: string
): Promise<OnboardOrchestratorResult> {
  const appDb = getDb(env.DB);
  const owner = teamPrincipal(teamId);

  let identity = await db.getOrchestratorIdentityByOwner(appDb, owner);
  const existingSession = await db.getCurrentOrchestratorSessionByOwner(env.DB, owner);
  if (identity && existingSession) {
    return { ok: false, reason: 'already_exists' };
  }

  if (!identity) {
    const handleClash = await db.getOrchestratorIdentityByHandle(appDb, params.handle);
    if (handleClash) return { ok: false, reason: 'handle_taken' };
    const nameClash = await db.getOrchestratorIdentityByName(appDb, params.name);
    if (nameClash) return { ok: false, reason: 'name_taken' };

    const personaName = `${params.name} (Orchestrator)`;
    let personaId: string;
    try {
      ({ personaId } = await upsertPersonaByName(appDb, env.DB, 'default', {
        name: personaName,
        description: 'Auto-managed team orchestrator persona',
        visibility: 'private',
        createdBy: actor.userId,
      }));
    } catch {
      const existing = await findPersonaByName(env.DB, 'default', personaName);
      if (!existing) throw new Error(`Failed to create or find orchestrator persona "${personaName}"`);
      personaId = existing.id;
    }
    if (params.customInstructions) {
      await upsertPersonaFile(appDb, {
        id: crypto.randomUUID(),
        personaId,
        filename: 'custom-instructions.md',
        content: params.customInstructions,
        sortOrder: 10,
      });
    }

    identity = await db.createOrchestratorIdentity(appDb, {
      id: crypto.randomUUID(),
      owner,
      name: params.name,
      handle: params.handle,
      avatar: params.avatar,
      customInstructions: params.customInstructions,
      personaId,
    });
  }

  const { sessionId } = await restartOrchestratorSessionForOwner(env, owner, actor, identity, requestUrl);
  const session = await db.getCurrentOrchestratorSessionByOwner(env.DB, owner);
  return { ok: true, sessionId, identity, session };
}

export interface TeamPromptDispatchResult {
  dispatched: boolean;
  sessionId: string;
  reason?: string;
  retryAfterMs?: number;
}

/**
 * Dispatch a prompt to a team orchestrator, mirroring dispatchOrchestratorPrompt:
 * ensure the DO is running, initialize it via restart on a fresh/evicted DO, and
 * queue the prompt. Team prompts always queue (never steer) — one member's
 * message must not interrupt another's run; 'all'-mode channel chatter uses
 * collect so bursts batch into one evaluation.
 */
export async function dispatchTeamOrchestratorPrompt(
  env: Env,
  teamId: string,
  params: {
    content: string;
    actor: OrchestratorActor;
    contextPrefix?: string;
    channelType?: string;
    channelId?: string;
    threadId?: string;
    attachments?: Array<Record<string, unknown>>;
    authorName?: string;
    replyTo?: { channelType: string; channelId: string };
    queueMode?: 'followup' | 'collect';
  }
): Promise<TeamPromptDispatchResult> {
  const appDb = getDb(env.DB);
  const owner = teamPrincipal(teamId);
  const sessionId = orchestratorSessionId(owner);

  const content = params.content.trim();
  if (!content && (!params.attachments || params.attachments.length === 0)) {
    return { dispatched: false, sessionId, reason: 'empty_prompt' };
  }

  const identity = await db.getOrchestratorIdentityByOwner(appDb, owner);
  if (!identity) {
    return { dispatched: false, sessionId, reason: 'orchestrator_not_configured' };
  }

  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const ensureRes = await sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
  if (ensureRes.status === 503) {
    const body = (await ensureRes.json()) as { retryAfterMs?: number };
    return { dispatched: false, sessionId, reason: 'backoff', retryAfterMs: body.retryAfterMs };
  }
  if (ensureRes.status === 500) {
    // Fresh/evicted DO — initialize it. Same not-fully-serialized caveat as the
    // personal path: concurrent messages may race; runner token rotation ensures
    // one sandbox wins and the loser idle-terminates.
    try {
      await restartOrchestratorSessionForOwner(env, owner, params.actor, identity);
    } catch (err) {
      console.error(`[TeamDispatch] Failed to initialize DO for team ${teamId}:`, err);
      return { dispatched: false, sessionId, reason: 'initialization_failed' };
    }
  }

  let threadId = params.threadId;
  if (!threadId) {
    try {
      let thread = await db.getActiveThread(env.DB, sessionId);
      if (!thread) {
        thread = await db.createThread(env.DB, {
          id: crypto.randomUUID(),
          sessionId,
          ...(params.channelType
            ? { originType: params.channelType, originChannelType: params.channelType, originChannelId: params.channelId }
            : {}),
        });
      }
      threadId = thread.id;
    } catch (err) {
      console.warn('[TeamDispatch] Failed to resolve thread:', err);
    }
  }

  const doRes = await sessionDO.fetch(
    new Request('http://do/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        contextPrefix: params.contextPrefix,
        channelType: params.channelType,
        channelId: params.channelId,
        threadId,
        attachments: params.attachments,
        authorName: params.authorName,
        authorId: params.actor.userId,
        replyTo: params.replyTo,
        queueMode: params.queueMode ?? 'followup',
      }),
    })
  );

  if (!doRes.ok) {
    const errText = (await doRes.text().catch(() => '')).slice(0, 200);
    return { dispatched: false, sessionId, reason: `team_dispatch_failed:${doRes.status}${errText ? `:${errText}` : ''}` };
  }
  return { dispatched: true, sessionId };
}

/** Restart an already-onboarded team orchestrator (recovery — any member may trigger it). */
export async function restartTeamOrchestrator(
  env: Env,
  teamId: string,
  actor: OrchestratorActor,
  requestUrl?: string
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: 'not_onboarded' }> {
  const appDb = getDb(env.DB);
  const owner = teamPrincipal(teamId);
  const identity = await db.getOrchestratorIdentityByOwner(appDb, owner);
  if (!identity) return { ok: false, reason: 'not_onboarded' };
  const { sessionId } = await restartOrchestratorSessionForOwner(env, owner, actor, identity, requestUrl);
  return { ok: true, sessionId };
}
