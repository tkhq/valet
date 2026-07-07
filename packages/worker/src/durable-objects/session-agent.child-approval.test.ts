/**
 * REPRODUCTION SPEC — child-session approval/auth requests never reach the orchestrator.
 *
 * A spawned child session (sessions.parent_session_id set) that hits a gated tool call only
 * (a) broadcasts to its own DO's clients (nobody connects to a child), (b) publishes a
 * user-scoped EventBus event no client consumes, and (c) resolves zero channel targets in
 * sendChannelInteractivePrompts (spawned children carry no channel context and are attended,
 * so the Slack-DM fallback is skipped). notifyParentEvent — the one working child→parent
 * path — fires only for lifecycle events (idle/error/completed/hibernated), never for
 * approval or auth, so the invocation silently expires after ACTION_APPROVAL_EXPIRY_MS (4min).
 *
 * Production incident (2026-06-30 and 2026-07-06): 14/14 github.create_pull_request approvals
 * from child sessions expired unresolved (status='expired', resolved_by NULL), forcing manual
 * gh/curl fallbacks that produced malformed PRs on tkhq/mono (#7060/#7061/#7063; two failed
 * the repo's validate-pr-description CI check).
 *
 * This file is the executable spec for the fix:
 *  - tests tagged [BUG] pin today's broken behavior and MUST be updated by the fix PR;
 *  - it.fails tests encode the desired contract — they pass in CI today precisely because
 *    the behavior is missing, and will start failing (forcing a flip to it(...)) the moment
 *    the fix lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_APPROVAL_EXPIRY_MS } from './session-agent.js';
import { createTestDb } from '../test-utils/db.js';
import { createTestAgent } from '../test-utils/session-agent-harness.js';
import { sessions } from '../lib/schema/sessions.js';
import { users } from '../lib/schema/users.js';
import { createInvocation, getInvocation } from '../lib/db/actions.js';
import type { InteractivePrompt } from '@valet/sdk';
import * as sessionTools from '../services/session-tools.js';

const CHILD_SESSION_ID = 'child-sess-1';
const PARENT_SESSION_ID = 'orchestrator:user-1';
const INVOCATION_ID = 'inv-child-approval';

/**
 * Builds a SessionAgentDO acting as a spawned child session: parent_session_id
 * set in D1, no channel context on the processing prompt row (children receive
 * their task via the parent's spawn-child path, not via Slack/web channels).
 */
async function createChildSessionAgent() {
  const harness = await createTestAgent();
  const { agent } = harness;
  (agent as any).sessionState.set('sessionId', CHILD_SESSION_ID);
  (agent as any).sessionState.set('userId', 'user-1');

  const testDb = createTestDb();
  const appDb = testDb.db;
  appDb.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
  appDb.insert(sessions).values({
    id: PARENT_SESSION_ID,
    userId: 'user-1',
    workspace: '/tmp/orchestrator',
    status: 'running',
  }).run();
  appDb.insert(sessions).values({
    id: CHILD_SESSION_ID,
    userId: 'user-1',
    workspace: '/tmp/child-task',
    status: 'running',
    parentSessionId: PARENT_SESSION_ID,
    parentThreadId: 'thread-parent-1',
  }).run();
  Object.defineProperty(agent, 'appDb', { value: appDb, configurable: true });

  await createInvocation(appDb as any, {
    id: INVOCATION_ID,
    sessionId: CHILD_SESSION_ID,
    userId: 'user-1',
    service: 'github',
    actionId: 'create_pull_request',
    riskLevel: 'high',
    resolvedMode: 'require_approval',
    status: 'pending',
  });

  (agent as any).runnerLink.send = vi.fn().mockReturnValue(true);
  const notifyParentEvent = vi.fn().mockResolvedValue(undefined);
  (agent as any).notifyParentEvent = notifyParentEvent;

  // The child's current turn: enqueued by the parent's spawn path, so it has
  // no channel_type/channel_id and is authored by the user (attended).
  (agent as any).promptQueue.enqueue({
    id: 'child-task-prompt',
    content: 'Open a PR with the fix',
    status: 'processing',
    authorEmail: 'user-1@example.com',
  });

  return { ...harness, appDb, notifyParentEvent };
}

function mockPendingApprovalPolicy() {
  vi.spyOn(sessionTools, 'resolveActionPolicy').mockResolvedValue({
    outcome: 'pending_approval',
    invocationId: INVOCATION_ID,
    riskLevel: 'high',
    service: 'github',
    actionId: 'create_pull_request',
    actionSource: {} as any,
    disabledPluginServicesCache: null,
  });
}

describe('SessionAgentDO — child-session approval bubbling (repro)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // [BUG] Pins the broken behavior: every notification the pending_approval
  // branch emits is a dead end for a spawned child, and the one channel that
  // does reach the orchestrator (notifyParentEvent) is never invoked.
  // The fix PR must update this test.
  it('pending_approval on a child session never notifies the parent orchestrator', async () => {
    const { agent, broadcasts, notifyParentEvent } = await createChildSessionAgent();
    mockPendingApprovalPolicy();

    await (agent as any).handleCallTool(
      'req-child-pr',
      'github:create_pull_request',
      { repo: 'tkhq/mono', title: 'fix: repro' },
      'Open PR "fix: repro" against tkhq/mono',
    );

    // The approval branch was taken: runner told to wait, prompt broadcast on
    // the child DO (which has no connected clients in production), EventBus
    // event published by userId (no client consumes it for child sessions).
    expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'call-tool-pending',
      requestId: 'req-child-pr',
      invocationId: INVOCATION_ID,
    }));
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'interactive_prompt',
      prompt: expect.objectContaining({ id: INVOCATION_ID, type: 'approval' }),
    }));
    expect((agent as any).notifyEventBus).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.approval_required',
      sessionId: CHILD_SESSION_ID,
      userId: 'user-1',
    }));

    // THE BUG: the child→parent system-message channel is never used for
    // approvals — the orchestrator (and therefore the user) never hears about it.
    expect(notifyParentEvent).not.toHaveBeenCalled();
  });

  // [BUG] Pins the broken behavior: channel delivery finds zero targets for a
  // spawned child (no origin channel in the approval context, no channel on the
  // processing row) and the Slack-DM fallback is gated on isUnattended, which
  // is false for a normal attended child — so delivery is silently skipped.
  // The fix PR must update this test.
  it('channel prompt delivery resolves zero targets for a spawned child and drops silently', async () => {
    const { agent, broadcasts } = await createChildSessionAgent();

    const sendInteractiveMock = vi.fn().mockResolvedValue([]);
    (agent as any).channelRouter.sendInteractivePrompt = sendInteractiveMock;
    const resolveUserDmTargetMock = vi.fn().mockResolvedValue(null);
    (agent as any).channelRouter.resolveUserDmTarget = resolveUserDmTargetMock;

    const prompt: InteractivePrompt = {
      id: INVOCATION_ID,
      sessionId: CHILD_SESSION_ID,
      type: 'approval',
      title: 'Action requires approval',
      body: 'Open PR "fix: repro" against tkhq/mono',
      actions: [],
      // A child's approval context has no channelType/channelId — spawned
      // children have no originating external channel.
      context: { toolId: 'github:create_pull_request', invocationId: INVOCATION_ID },
    };

    // Restore the real sendChannelInteractivePrompts (mocked in createTestAgent)
    delete (agent as any).sendChannelInteractivePrompts;

    await (agent as any).sendChannelInteractivePrompts(INVOCATION_ID, prompt);

    expect(sendInteractiveMock).not.toHaveBeenCalled();
    expect(resolveUserDmTargetMock).not.toHaveBeenCalled();
    // Not even the web-UI error broadcast fires — the attended early-return
    // wins, so the approval is visible nowhere the user is looking.
    expect(broadcasts).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  // [BUG] Pins the broken end state: the approval sits for ACTION_APPROVAL_EXPIRY_MS
  // (~4 minutes), then the alarm sweep marks the invocation expired and unresolved —
  // exactly the 14/14 expired github.create_pull_request invocations from the incident.
  // The fix PR must update this test.
  it('child approval expires unresolved after the 4-minute window without ever reaching the parent', async () => {
    const { agent, sql, appDb, notifyParentEvent } = await createChildSessionAgent();
    mockPendingApprovalPolicy();

    await (agent as any).handleCallTool(
      'req-child-pr',
      'github:create_pull_request',
      { repo: 'tkhq/mono', title: 'fix: repro' },
      'Open PR "fix: repro" against tkhq/mono',
    );

    const row = sql.interactivePrompts.get(INVOCATION_ID);
    expect(row).toBeTruthy();
    // Pin the expiry window: created_at + ACTION_APPROVAL_EXPIRY_MS (240s).
    const nowSec = Math.floor(Date.now() / 1000);
    expect(row!.expires_at).toBeGreaterThanOrEqual(nowSec + ACTION_APPROVAL_EXPIRY_MS / 1000 - 5);
    expect(row!.expires_at).toBeLessThanOrEqual(nowSec + ACTION_APPROVAL_EXPIRY_MS / 1000 + 5);

    // Simulate the 4 minutes elapsing (suite convention: backdate expires_at
    // and run the alarm sweep, as in "expires stale approval prompts").
    row!.expires_at = nowSec - 1;
    await agent.alarm();

    expect(sql.interactivePrompts.has(INVOCATION_ID)).toBe(false);
    const invocation = await getInvocation(appDb as any, INVOCATION_ID);
    expect(invocation).toMatchObject({ status: 'expired', resolvedBy: null });
    expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'call-tool-result',
      requestId: 'req-child-pr',
      error: expect.stringContaining('expired without a response'),
    }));
    // Even at expiry the parent is never told anything happened.
    expect(notifyParentEvent).not.toHaveBeenCalled();
  });

  // [BUG] Pins the parent-side half of the bug: even if an approval event were
  // delivered as a child system message, the wait_for_event filter only wakes
  // for lifecycle statuses (terminated/error/hibernated under notifyOn:'terminal'),
  // so an approval_required wake from a watched child is dropped before dispatch.
  // The fix PR must update this test.
  it("parent wait_for_event(terminal) filter drops a child's approval_required wake", async () => {
    const { agent, sql } = await createTestAgent();
    (agent as any).sessionState.waitSubscription = {
      reason: 'waiting for child sessions to finish',
      sessionIds: [CHILD_SESSION_ID],
      notifyOn: 'terminal',
    };

    await (agent as any).handleSystemMessage(
      `Child session event: ${CHILD_SESSION_ID} requires approval for github:create_pull_request.`,
      {
        systemTitle: 'Child task',
        systemAvatarKey: 'child-session',
        childSessionId: CHILD_SESSION_ID,
        childStatus: 'approval_required',
        kind: 'approval_required',
        invocationId: INVOCATION_ID,
        toolId: 'github:create_pull_request',
      },
      true,
    );

    // The message is recorded on the parent, but the wake is filtered out —
    // nothing is queued for the orchestrator, so it never relays the approval.
    expect(sql.messages.size).toBe(1);
    expect(sql.queue.size).toBe(0);
  });

  // DESIRED CONTRACT (executable spec for the fix) ---------------------------
  //
  // The minimal proposed contract: the pending_approval / auth-required branches
  // call notifyParentEvent with a wakeable payload whose parts carry
  // kind:'approval_required' (sibling: 'auth_required') plus invocationId/toolId/
  // summary, and the parent's wait-subscription filter treats those kinds as
  // wakeable. Asserted loosely at the existing notifyParentEvent seam since the
  // fix's exact types don't exist yet.

  it.fails('DESIRED: pending_approval on a child bubbles to the parent via notifyParentEvent', async () => {
    const { agent, notifyParentEvent } = await createChildSessionAgent();
    mockPendingApprovalPolicy();

    await (agent as any).handleCallTool(
      'req-child-pr',
      'github:create_pull_request',
      { repo: 'tkhq/mono', title: 'fix: repro' },
      'Open PR "fix: repro" against tkhq/mono',
    );

    // Precondition (passes today): the gated-approval branch actually ran.
    expect((agent as any).runnerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'call-tool-pending',
      invocationId: INVOCATION_ID,
    }));
    expect(notifyParentEvent).toHaveBeenCalled();
    const flatCalls = JSON.stringify(notifyParentEvent.mock.calls);
    expect(flatCalls).toContain('approval_required');
    expect(flatCalls).toContain(INVOCATION_ID);
  });

  it.fails('DESIRED: integration auth warnings on a child bubble to the parent as auth_required', async () => {
    const { agent, broadcasts, notifyParentEvent } = await createChildSessionAgent();
    vi.spyOn(sessionTools, 'listTools').mockResolvedValue({
      tools: [],
      warnings: [{
        service: 'github',
        displayName: 'GitHub',
        reason: 'refresh_failed',
        message: 'GitHub token refresh failed — reauthentication required',
        integrationId: 'integration-github',
      }],
      mcpCacheEntries: [],
      discoveredRiskLevels: new Map(),
      disabledPluginServices: new Set(),
    });

    await (agent as any).handleListTools('req-child-list-tools', 'github');

    // Precondition (passes today): the auth-required branch actually ran —
    // it currently only broadcasts to the child DO's (absent) clients.
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'integration-auth-required',
      services: [expect.objectContaining({ service: 'github' })],
    }));
    expect(notifyParentEvent).toHaveBeenCalled();
    const flatCalls = JSON.stringify(notifyParentEvent.mock.calls);
    expect(flatCalls).toContain('auth_required');
    expect(flatCalls).toContain('github');
  });

  it.fails('DESIRED: approval_required wakes a parent waiting on terminal child events', async () => {
    const { agent, sql } = await createTestAgent();
    (agent as any).sessionState.waitSubscription = {
      reason: 'waiting for child sessions to finish',
      sessionIds: [CHILD_SESSION_ID],
      notifyOn: 'terminal',
    };

    await (agent as any).handleSystemMessage(
      `Child session event: ${CHILD_SESSION_ID} requires approval for github:create_pull_request.`,
      {
        systemTitle: 'Child task',
        systemAvatarKey: 'child-session',
        childSessionId: CHILD_SESSION_ID,
        childStatus: 'approval_required',
        kind: 'approval_required',
        invocationId: INVOCATION_ID,
        toolId: 'github:create_pull_request',
      },
      true,
    );

    // Precondition (passes today): the system message itself was recorded.
    expect(sql.messages.size).toBe(1);
    // Approval requests must be wakeable even under notifyOn:'terminal' —
    // a blocked child is not making progress, and only the orchestrator can
    // relay the approval to the user. (Runner disconnected in this harness,
    // so a wake that passes the filter lands in the prompt queue.)
    expect(sql.queue.size).toBe(1);
  });
});
