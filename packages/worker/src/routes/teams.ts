import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { channelScopeKey, ConflictError, ForbiddenError, NotFoundError } from '@valet/shared';
import type { TeamRole } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import {
  getTeamOrchestratorInfo,
  onboardTeamOrchestrator,
  restartTeamOrchestrator,
} from '../services/team-orchestrator.js';
import {
  breakTeamCredentialsSourcedFrom,
  getTeamCredentialSourcer,
  listTeamCredentials,
  shareCredentialToTeam,
  unshareTeamCredential,
} from '../services/team-credentials.js';

export const teamsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const teamRoleSchema = z.enum(['admin', 'member']);

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  avatar: z.string().max(2000).optional(),
});

const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  avatar: z.string().max(2000).optional(),
});

const addMemberSchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: teamRoleSchema.optional(),
  })
  .refine((v) => !!v.userId || !!v.email, { message: 'userId or email is required' });

const updateMemberSchema = z.object({ role: teamRoleSchema });

const onboardOrchestratorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  handle: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_-]+$/, 'Handle must be lowercase alphanumeric with dashes/underscores'),
  avatar: z.string().max(2000).optional(),
  customInstructions: z.string().max(10000).optional(),
});

function isOrgAdmin(c: { get: (k: 'user') => Variables['user'] }): boolean {
  return c.get('user').role === 'admin';
}

/**
 * Resolve the caller's standing on a team. Non-members who aren't org admins
 * get a NotFoundError — a team's existence is not disclosed to outsiders,
 * mirroring assertSessionAccess semantics.
 */
async function assertTeamAccess(
  appDb: Parameters<typeof db.getTeam>[0],
  teamId: string,
  user: Variables['user'],
  required: 'member' | 'admin'
): Promise<{ myRole: TeamRole | null }> {
  const team = await db.getTeam(appDb, teamId);
  if (!team) throw new NotFoundError('Team', teamId);

  const membership = await db.getTeamMembership(appDb, teamId, user.id);
  const orgAdmin = user.role === 'admin';

  if (!membership && !orgAdmin) throw new NotFoundError('Team', teamId);

  if (required === 'admin') {
    const teamAdmin = membership?.role === 'admin';
    if (!teamAdmin && !orgAdmin) {
      throw new ForbiddenError('Requires team admin');
    }
  }

  return { myRole: membership?.role ?? null };
}

// ─── Teams ───────────────────────────────────────────────────────────────────

teamsRouter.post('/', zValidator('json', createTeamSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');
  const team = await db.createTeam(c.get('db'), { ...body, createdBy: user.id });
  return c.json({ team }, 201);
});

teamsRouter.get('/', async (c) => {
  const user = c.get('user');
  const all = c.req.query('all') === 'true';
  const teams =
    all && isOrgAdmin(c)
      ? await db.listAllTeams(c.get('db'))
      : await db.listTeamsForUser(c.get('db'), user.id);
  return c.json({ teams });
});

/**
 * Minimal user directory for the member picker. Single-tenant org: every user
 * is an org member (see auth-access spec), so this is intentionally available
 * to all authenticated users, unlike the admin-only user listing.
 */
teamsRouter.get('/directory', async (c) => {
  const usersList = await db.listUsers(c.get('db'));
  return c.json({
    users: usersList.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl })),
  });
});

teamsRouter.get('/:id', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const { myRole } = await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const team = await db.getTeam(c.get('db'), teamId);
  return c.json({ team: { ...team, myRole: myRole ?? undefined } });
});

teamsRouter.patch('/:id', zValidator('json', updateTeamSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const { myRole } = await assertTeamAccess(c.get('db'), teamId, user, 'admin');
  const team = await db.updateTeam(c.get('db'), teamId, c.req.valid('json'));
  return c.json({ team: { ...team, myRole: myRole ?? undefined } });
});

teamsRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');

  // Gather the team's live sessions before deletion. deleteTeam throws if
  // team-owned workflows exist (so we don't reach termination on that path).
  const sessionIds = await db.listNonTerminalTeamSessionIds(c.get('db'), teamId);

  await db.deleteTeam(c.get('db'), teamId);

  // Terminate them AFTER the row is gone — otherwise they keep running with a
  // dangling ownerId, unmanageable (assertSessionAccess 404s for everyone once
  // the team vanishes) yet still reachable via any open socket. Stopping the DO
  // tears down the sandbox and drops connections. Best-effort.
  const { terminateSessionUnchecked } = await import('../services/sessions.js');
  await Promise.allSettled(
    sessionIds.map((sid) => terminateSessionUnchecked(c.env, sid, 'team_deleted'))
  );
  return c.json({ success: true });
});

// ─── Membership ──────────────────────────────────────────────────────────────

teamsRouter.get('/:id/members', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const members = await db.listTeamMembers(c.get('db'), teamId);
  return c.json({ members });
});

teamsRouter.post('/:id/members', zValidator('json', addMemberSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const body = c.req.valid('json');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');

  let targetUserId: string;
  if (body.userId) {
    targetUserId = body.userId;
  } else {
    const email = body.email ?? '';
    const target = await db.findUserByEmail(c.get('db'), email);
    if (!target) throw new NotFoundError('User', email);
    targetUserId = target.id;
  }

  const member = await db.addTeamMember(c.get('db'), teamId, targetUserId, body.role ?? 'member', user.id);
  return c.json({ member }, 201);
});

teamsRouter.patch('/:id/members/:userId', zValidator('json', updateMemberSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const targetUserId = c.req.param('userId');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');
  await db.updateTeamMemberRole(c.get('db'), teamId, targetUserId, c.req.valid('json').role);
  return c.json({ success: true });
});

teamsRouter.delete('/:id/members/:userId', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const targetUserId = c.req.param('userId');

  // Self-removal (leaving) requires only membership; removing others requires admin.
  const required = targetUserId === user.id ? 'member' : 'admin';
  await assertTeamAccess(c.get('db'), teamId, user, required);

  await db.removeTeamMember(c.get('db'), teamId, targetUserId);

  // Sourced connections break when the sourcing member leaves — surfaced on
  // the Integrations tab, never silently swapped for someone else's tokens.
  try {
    await breakTeamCredentialsSourcedFrom(c.get('db'), targetUserId, { teamId });
  } catch (err) {
    console.warn(`[teams] Failed to break sourced credentials for ${targetUserId}:`, err);
  }

  // Access is checked at WebSocket connect time, so evict any live connections
  // the removed member has to team-owned sessions. Best-effort fan-out.
  try {
    const sessionIds = await db.listNonTerminalTeamSessionIds(c.get('db'), teamId);
    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        const doId = c.env.SESSIONS.idFromName(sid);
        await c.env.SESSIONS.get(doId).fetch(
          new Request('http://do/evict-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: targetUserId }),
          })
        );
      })
    );
  } catch (err) {
    console.warn(`[teams] Failed to evict ${targetUserId} from team ${teamId} sessions:`, err);
  }

  return c.json({ success: true });
});

// ─── Team memory ─────────────────────────────────────────────────────────────
// Members read; team admins (or org admins) write and delete — mirroring the
// spec's UI rule. The team orchestrator itself writes via the DO mem-* path.

const writeTeamMemorySchema = z.object({
  path: z.string().min(1).max(256),
  content: z.string().max(2_000_000),
});

teamsRouter.get('/:id/memory', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const owner = { type: 'team' as const, id: teamId };

  const path = c.req.query('path') || '';
  if (!path || path.endsWith('/')) {
    const files = await db.listMemoryFiles(c.get('db'), owner, path);
    return c.json({ files });
  }
  const file = await db.readMemoryFile(c.get('db'), owner, path);
  return c.json({ file: file ?? null });
});

teamsRouter.get('/:id/memory/search', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const query = c.req.query('q') || '';
  if (!query) return c.json({ results: [] });
  const results = await db.searchMemoryFiles(c.env.DB, { type: 'team', id: teamId }, query, c.req.query('path') || undefined);
  return c.json({ results });
});

teamsRouter.put('/:id/memory', zValidator('json', writeTeamMemorySchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');
  const body = c.req.valid('json');
  const file = await db.writeMemoryFile(c.env.DB, { type: 'team', id: teamId }, body.path, body.content, true, user.id);
  return c.json({ file }, 201);
});

teamsRouter.delete('/:id/memory', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');
  const path = c.req.query('path');
  if (!path) throw new NotFoundError('Memory file', 'path required');
  const deleted = path.endsWith('/')
    ? await db.deleteMemoryFilesUnderPath(c.env.DB, { type: 'team', id: teamId }, path)
    : await db.deleteMemoryFile(c.env.DB, { type: 'team', id: teamId }, path);
  return c.json({ deleted });
});

// ─── Team channel bindings ───────────────────────────────────────────────────
// The binding is the router: one binding per external channel, owned by the
// team, pointing at the team orchestrator session. Admins manage; members view.

const createTeamBindingSchema = z.object({
  slackChannelId: z.string().trim().min(1).max(64),
  triggerMode: z.enum(['mention', 'all']).optional(),
});

const updateTeamBindingSchema = z.object({
  triggerMode: z.enum(['mention', 'all']),
});

teamsRouter.get('/:id/channels', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const bindings = await db.listChannelBindingsByOwner(c.get('db'), { type: 'team', id: teamId });
  return c.json({ bindings });
});

teamsRouter.post('/:id/channels', zValidator('json', createTeamBindingSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');
  const body = c.req.valid('json');

  const info = await getTeamOrchestratorInfo(c.env, c.get('db'), teamId);
  if (!info.exists) {
    throw new ConflictError('Set up the team orchestrator before binding channels');
  }

  const existing = await db.getChannelBindingByChannel(c.get('db'), 'slack', body.slackChannelId);
  if (existing) {
    throw new ConflictError('That channel is already bound to an orchestrator');
  }

  const owner = { type: 'team' as const, id: teamId };
  const binding = await db.createChannelBinding(c.get('db'), {
    id: crypto.randomUUID(),
    sessionId: info.sessionId,
    channelType: 'slack',
    channelId: body.slackChannelId,
    scopeKey: channelScopeKey(owner, 'slack', body.slackChannelId),
    orgId: 'default',
    ownerType: 'team',
    ownerId: teamId,
    triggerMode: body.triggerMode ?? 'mention',
    createdBy: user.id,
    slackChannelId: body.slackChannelId,
  });
  return c.json({ binding }, 201);
});

teamsRouter.patch('/:id/channels/:bindingId', zValidator('json', updateTeamBindingSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const bindingId = c.req.param('bindingId');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');

  const binding = await db.getChannelBindingById(c.get('db'), bindingId);
  if (!binding || binding.ownerType !== 'team' || binding.ownerId !== teamId) {
    throw new NotFoundError('Channel binding', bindingId);
  }
  await db.updateChannelBindingTriggerMode(c.get('db'), bindingId, c.req.valid('json').triggerMode);
  return c.json({ success: true });
});

teamsRouter.delete('/:id/channels/:bindingId', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const bindingId = c.req.param('bindingId');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');

  const binding = await db.getChannelBindingById(c.get('db'), bindingId);
  if (!binding || binding.ownerType !== 'team' || binding.ownerId !== teamId) {
    throw new NotFoundError('Channel binding', bindingId);
  }
  await db.deleteChannelBinding(c.get('db'), bindingId);
  return c.json({ success: true });
});

// ─── Team integrations (sourced connections) ────────────────────────────────
// Any member may share/re-source THEIR OWN connection; unshare is the team
// admin or the sourcing member. Team sessions resolve these rows only.

const shareIntegrationSchema = z.object({
  provider: z.string().trim().min(1).max(64),
});

teamsRouter.get('/:id/integrations', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const connections = await listTeamCredentials(c.get('db'), teamId);
  return c.json({ connections });
});

teamsRouter.post('/:id/integrations', zValidator('json', shareIntegrationSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const connection = await shareCredentialToTeam(c.get('db'), teamId, user.id, c.req.valid('json').provider);
  return c.json({ connection }, 201);
});

teamsRouter.delete('/:id/integrations/:provider', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  const provider = c.req.param('provider');
  const { myRole } = await assertTeamAccess(c.get('db'), teamId, user, 'member');

  const sourcer = await getTeamCredentialSourcer(c.get('db'), teamId, provider);
  const isTeamAdmin = myRole === 'admin' || user.role === 'admin';
  if (!isTeamAdmin && sourcer !== user.id) {
    throw new ForbiddenError('Only a team admin or the sourcing member can remove this connection');
  }

  const deleted = await unshareTeamCredential(c.get('db'), teamId, provider);
  if (deleted === 0) throw new NotFoundError('Team connection', provider);
  return c.json({ success: true });
});

// ─── Team orchestrator ───────────────────────────────────────────────────────

teamsRouter.get('/:id/orchestrator', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');
  const info = await getTeamOrchestratorInfo(c.env, c.get('db'), teamId);
  return c.json(info);
});

teamsRouter.post('/:id/orchestrator', zValidator('json', onboardOrchestratorSchema), async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'admin');

  const result = await onboardTeamOrchestrator(
    c.env,
    teamId,
    { userId: user.id, email: user.email },
    c.req.valid('json'),
    c.req.url
  );
  if (!result.ok) {
    return c.json({ error: result.reason, code: result.reason.toUpperCase() }, 409);
  }
  return c.json({ sessionId: result.sessionId, identity: result.identity, session: result.session }, 201);
});

// Restart is recovery, not configuration — any member may trigger it (the
// reconcile cron does the same with no user at all).
teamsRouter.post('/:id/orchestrator/restart', async (c) => {
  const user = c.get('user');
  const teamId = c.req.param('id');
  await assertTeamAccess(c.get('db'), teamId, user, 'member');

  const result = await restartTeamOrchestrator(c.env, teamId, { userId: user.id, email: user.email }, c.req.url);
  if (!result.ok) throw new NotFoundError('Team orchestrator', teamId);
  return c.json({ sessionId: result.sessionId });
});
