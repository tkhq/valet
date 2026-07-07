import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';

const {
  listNonTerminalTeamSessionIdsMock,
  listChannelBindingsByOwnerMock,
  getChannelBindingByChannelMock,
  getChannelBindingByIdMock,
  createChannelBindingMock,
  updateChannelBindingTriggerModeMock,
  deleteChannelBindingMock,
  listMemoryFilesMock,
  readMemoryFileMock,
  writeMemoryFileMock,
  deleteMemoryFileMock,
  searchMemoryFilesMock,
  getTeamOrchestratorInfoMock,
  onboardTeamOrchestratorMock,
  restartTeamOrchestratorMock,
  createTeamMock,
  getTeamMock,
  listTeamsForUserMock,
  listAllTeamsMock,
  updateTeamMock,
  deleteTeamMock,
  listTeamMembersMock,
  getTeamMembershipMock,
  addTeamMemberMock,
  updateTeamMemberRoleMock,
  removeTeamMemberMock,
  listUsersMock,
  findUserByEmailMock,
} = vi.hoisted(() => ({
  createTeamMock: vi.fn(),
  getTeamMock: vi.fn(),
  listTeamsForUserMock: vi.fn(),
  listAllTeamsMock: vi.fn(),
  updateTeamMock: vi.fn(),
  deleteTeamMock: vi.fn(),
  listTeamMembersMock: vi.fn(),
  getTeamMembershipMock: vi.fn(),
  addTeamMemberMock: vi.fn(),
  updateTeamMemberRoleMock: vi.fn(),
  removeTeamMemberMock: vi.fn(),
  listUsersMock: vi.fn(),
  findUserByEmailMock: vi.fn(),
  listNonTerminalTeamSessionIdsMock: vi.fn(),
  listMemoryFilesMock: vi.fn(),
  listChannelBindingsByOwnerMock: vi.fn(),
  getChannelBindingByChannelMock: vi.fn(),
  getChannelBindingByIdMock: vi.fn(),
  createChannelBindingMock: vi.fn(),
  updateChannelBindingTriggerModeMock: vi.fn(),
  deleteChannelBindingMock: vi.fn(),
  readMemoryFileMock: vi.fn(),
  writeMemoryFileMock: vi.fn(),
  deleteMemoryFileMock: vi.fn(),
  searchMemoryFilesMock: vi.fn(),
  getTeamOrchestratorInfoMock: vi.fn(),
  onboardTeamOrchestratorMock: vi.fn(),
  restartTeamOrchestratorMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  createTeam: createTeamMock,
  getTeam: getTeamMock,
  listTeamsForUser: listTeamsForUserMock,
  listAllTeams: listAllTeamsMock,
  updateTeam: updateTeamMock,
  deleteTeam: deleteTeamMock,
  listTeamMembers: listTeamMembersMock,
  getTeamMembership: getTeamMembershipMock,
  addTeamMember: addTeamMemberMock,
  updateTeamMemberRole: updateTeamMemberRoleMock,
  removeTeamMember: removeTeamMemberMock,
  listUsers: listUsersMock,
  findUserByEmail: findUserByEmailMock,
  listNonTerminalTeamSessionIds: listNonTerminalTeamSessionIdsMock,
  listMemoryFiles: listMemoryFilesMock,
  readMemoryFile: readMemoryFileMock,
  writeMemoryFile: writeMemoryFileMock,
  deleteMemoryFile: deleteMemoryFileMock,
  deleteMemoryFilesUnderPath: vi.fn(),
  searchMemoryFiles: searchMemoryFilesMock,
  listChannelBindingsByOwner: listChannelBindingsByOwnerMock,
  getChannelBindingByChannel: getChannelBindingByChannelMock,
  getChannelBindingById: getChannelBindingByIdMock,
  createChannelBinding: createChannelBindingMock,
  updateChannelBindingTriggerMode: updateChannelBindingTriggerModeMock,
  deleteChannelBinding: deleteChannelBindingMock,
}));

vi.mock('../services/team-orchestrator.js', () => ({
  getTeamOrchestratorInfo: getTeamOrchestratorInfoMock,
  onboardTeamOrchestrator: onboardTeamOrchestratorMock,
  restartTeamOrchestrator: restartTeamOrchestratorMock,
}));

import { teamsRouter } from './teams.js';

const TEAM = { id: 'team-1', orgId: 'default', name: 'Platform', createdAt: 'x', updatedAt: 'x' };

function buildApp(user: Variables['user']) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', user);
    c.set('db', {} as Variables['db']);
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/', teamsRouter);
  return app;
}

const MEMBER_USER: Variables['user'] = { id: 'user-member', email: 'm@x.com', role: 'member' };
const ORG_ADMIN: Variables['user'] = { id: 'user-orgadmin', email: 'a@x.com', role: 'admin' };

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('teamsRouter authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTeamMock.mockResolvedValue(TEAM);
  });

  it('POST / creates a team for any authed user', async () => {
    createTeamMock.mockResolvedValue({ ...TEAM, myRole: 'admin', memberCount: 1 });
    const res = await buildApp(MEMBER_USER).fetch(json('POST', '/', { name: 'Platform' }));
    expect(res.status).toBe(201);
    expect(createTeamMock).toHaveBeenCalledWith({}, { name: 'Platform', createdBy: MEMBER_USER.id });
  });

  it('GET /:id returns 404 for non-members (no existence disclosure)', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1'));
    expect(res.status).toBe(404);
  });

  it('GET /:id works for members and includes myRole', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { team: { myRole?: string } };
    expect(data.team.myRole).toBe('member');
  });

  it('GET /:id works for org admins who are not members', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    const res = await buildApp(ORG_ADMIN).fetch(json('GET', '/team-1'));
    expect(res.status).toBe(200);
  });

  it('PATCH /:id is forbidden for plain members', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    const res = await buildApp(MEMBER_USER).fetch(json('PATCH', '/team-1', { name: 'New' }));
    expect(res.status).toBe(403);
    expect(updateTeamMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id works for team admins', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    updateTeamMock.mockResolvedValue({ ...TEAM, name: 'New' });
    const res = await buildApp(MEMBER_USER).fetch(json('PATCH', '/team-1', { name: 'New' }));
    expect(res.status).toBe(200);
  });

  it('DELETE /:id works for org admins without membership', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    deleteTeamMock.mockResolvedValue(undefined);
    listNonTerminalTeamSessionIdsMock.mockResolvedValue([]);
    const res = await buildApp(ORG_ADMIN).fetch(json('DELETE', '/team-1'));
    expect(res.status).toBe(200);
    expect(deleteTeamMock).toHaveBeenCalledWith({}, 'team-1');
  });

  it('GET / lists own teams; ?all=true is admin-only', async () => {
    listTeamsForUserMock.mockResolvedValue([TEAM]);
    listAllTeamsMock.mockResolvedValue([TEAM, { ...TEAM, id: 'team-2', name: 'Growth' }]);

    const memberRes = await buildApp(MEMBER_USER).fetch(json('GET', '/?all=true'));
    expect(memberRes.status).toBe(200);
    expect(listTeamsForUserMock).toHaveBeenCalled();
    expect(listAllTeamsMock).not.toHaveBeenCalled();

    const adminRes = await buildApp(ORG_ADMIN).fetch(json('GET', '/?all=true'));
    expect(adminRes.status).toBe(200);
    expect(listAllTeamsMock).toHaveBeenCalled();
  });

  it('POST /:id/members resolves email; unknown email is 404', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    findUserByEmailMock.mockResolvedValue(null);
    const res = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/members', { email: 'ghost@x.com' }));
    expect(res.status).toBe(404);
    expect(addTeamMemberMock).not.toHaveBeenCalled();
  });

  it('POST /:id/members adds by userId with default role', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    addTeamMemberMock.mockResolvedValue({ teamId: 'team-1', userId: 'user-new', role: 'member' });
    const res = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/members', { userId: 'user-new' }));
    expect(res.status).toBe(201);
    expect(addTeamMemberMock).toHaveBeenCalledWith({}, 'team-1', 'user-new', 'member', MEMBER_USER.id);
  });

  it('DELETE /:id/members/:userId allows self-removal for plain members', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    removeTeamMemberMock.mockResolvedValue(undefined);
    const res = await buildApp(MEMBER_USER).fetch(json('DELETE', `/team-1/members/${MEMBER_USER.id}`));
    expect(res.status).toBe(200);
  });

  it('DELETE /:id/members/:userId forbids members removing others', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    const res = await buildApp(MEMBER_USER).fetch(json('DELETE', '/team-1/members/user-other'));
    expect(res.status).toBe(403);
    expect(removeTeamMemberMock).not.toHaveBeenCalled();
  });

  it('DELETE /:id/members/:userId evicts the removed member from team session DOs', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    removeTeamMemberMock.mockResolvedValue(undefined);
    listNonTerminalTeamSessionIdsMock.mockResolvedValue(['orchestrator:team:team-1']);
    const doFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const env = { SESSIONS: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue({ fetch: doFetch }) } } as unknown as Env;

    const app = buildApp(MEMBER_USER);
    const res = await app.fetch(json('DELETE', '/team-1/members/user-other'), env);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const evictReq = doFetch.mock.calls[0][0] as Request;
    expect(evictReq.url).toBe('http://do/evict-user');
    await expect(evictReq.json()).resolves.toEqual({ userId: 'user-other' });
  });

  it('GET /:id/orchestrator requires membership', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1/orchestrator'));
    expect(res.status).toBe(404);
    expect(getTeamOrchestratorInfoMock).not.toHaveBeenCalled();
  });

  it('POST /:id/orchestrator is admin-only and maps handle_taken to 409', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    const forbidden = await buildApp(MEMBER_USER).fetch(
      json('POST', '/team-1/orchestrator', { name: 'Platform Bot', handle: 'platform-bot' })
    );
    expect(forbidden.status).toBe(403);

    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    onboardTeamOrchestratorMock.mockResolvedValue({ ok: false, reason: 'handle_taken' });
    const clash = await buildApp(MEMBER_USER).fetch(
      json('POST', '/team-1/orchestrator', { name: 'Platform Bot', handle: 'platform-bot' })
    );
    expect(clash.status).toBe(409);
  });

  it('POST /:id/orchestrator/restart is member-allowed; 404 when not onboarded', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    restartTeamOrchestratorMock.mockResolvedValue({ ok: true, sessionId: 'orchestrator:team:team-1' });
    const ok = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/orchestrator/restart'));
    expect(ok.status).toBe(200);

    restartTeamOrchestratorMock.mockResolvedValue({ ok: false, reason: 'not_onboarded' });
    const missing = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/orchestrator/restart'));
    expect(missing.status).toBe(404);
  });

  it('team memory: members read, plain members cannot write', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    listMemoryFilesMock.mockResolvedValue([{ path: 'runbook.md', size: 10, updatedAt: 'x', pinned: false }]);

    const list = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1/memory'));
    expect(list.status).toBe(200);
    expect(listMemoryFilesMock).toHaveBeenCalledWith({}, { type: 'team', id: 'team-1' }, '');

    const write = await buildApp(MEMBER_USER).fetch(json('PUT', '/team-1/memory', { path: 'runbook.md', content: 'x' }));
    expect(write.status).toBe(403);
    expect(writeMemoryFileMock).not.toHaveBeenCalled();
  });

  it('team memory: admins write with actor provenance', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    writeMemoryFileMock.mockResolvedValue({ path: 'runbook.md' });
    const env = {} as Env;
    const res = await buildApp(MEMBER_USER).fetch(json('PUT', '/team-1/memory', { path: 'runbook.md', content: 'x' }), env);
    expect(res.status).toBe(201);
    expect(writeMemoryFileMock).toHaveBeenCalledWith(undefined, { type: 'team', id: 'team-1' }, 'runbook.md', 'x', true, MEMBER_USER.id);
  });

  it('team memory: non-members get 404', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1/memory'));
    expect(res.status).toBe(404);
    expect(listMemoryFilesMock).not.toHaveBeenCalled();
  });

  it('GET /directory is available to any authed user', async () => {
    listUsersMock.mockResolvedValue([
      { id: 'u1', name: 'Alice', email: 'a@x.com', avatarUrl: null, role: 'member' },
    ]);
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/directory'));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { users: Array<{ id: string }> };
    expect(data.users).toHaveLength(1);
  });
});

describe('team channel bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTeamMock.mockResolvedValue(TEAM);
    getTeamOrchestratorInfoMock.mockResolvedValue({ exists: true, sessionId: 'orchestrator:team:team-1' });
    getChannelBindingByChannelMock.mockResolvedValue(null);
  });

  it('POST /:id/channels is admin-only and creates a team-owned binding', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    const forbidden = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/channels', { slackChannelId: 'C1' }));
    expect(forbidden.status).toBe(403);

    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    createChannelBindingMock.mockResolvedValue({ id: 'b1' });
    const res = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/channels', { slackChannelId: 'C1', triggerMode: 'all' }));
    expect(res.status).toBe(201);
    const args = createChannelBindingMock.mock.calls[0][1];
    expect(args.ownerType).toBe('team');
    expect(args.ownerId).toBe('team-1');
    expect(args.sessionId).toBe('orchestrator:team:team-1');
    expect(args.triggerMode).toBe('all');
    expect(args.scopeKey).toBe('team:team-1:slack:C1');
  });

  it('POST /:id/channels 409s when the channel is already bound or no orchestrator exists', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    getChannelBindingByChannelMock.mockResolvedValue({ id: 'existing' });
    const bound = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/channels', { slackChannelId: 'C1' }));
    expect(bound.status).toBe(409);

    getChannelBindingByChannelMock.mockResolvedValue(null);
    getTeamOrchestratorInfoMock.mockResolvedValue({ exists: false, sessionId: 'x' });
    const noBot = await buildApp(MEMBER_USER).fetch(json('POST', '/team-1/channels', { slackChannelId: 'C1' }));
    expect(noBot.status).toBe(409);
  });

  it('DELETE /:id/channels/:bindingId refuses bindings owned by other teams', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'admin' });
    getChannelBindingByIdMock.mockResolvedValue({ id: 'b1', ownerType: 'team', ownerId: 'other-team' });
    const res = await buildApp(MEMBER_USER).fetch(json('DELETE', '/team-1/channels/b1'));
    expect(res.status).toBe(404);
    expect(deleteChannelBindingMock).not.toHaveBeenCalled();
  });

  it('GET /:id/channels lists for members', async () => {
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: MEMBER_USER.id, role: 'member' });
    listChannelBindingsByOwnerMock.mockResolvedValue([{ id: 'b1' }]);
    const res = await buildApp(MEMBER_USER).fetch(json('GET', '/team-1/channels'));
    expect(res.status).toBe(200);
    expect(listChannelBindingsByOwnerMock).toHaveBeenCalledWith({}, { type: 'team', id: 'team-1' });
  });
});
