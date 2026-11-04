// Network-layer fixtures for the interaction latency check (run.mjs).
// Every /api request the built app makes is answered here. A request with
// no handler gets a 404, and the run prints it, so a new endpoint shows up
// as a list entry instead of a silent hang.

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const USER_ID = "user-perf";
const ORG_ID = "org-perf";
const TEAMS = [
  { id: "team-a", name: "Platform" },
  { id: "team-b", name: "Growth" },
];
/** Threads per space. Large enough that list rendering shows up in the numbers. */
const THREADS_PER_SPACE = 150;
/** Messages in each opened thread. */
const MESSAGES_PER_THREAD = 60;

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

function sessionIdFor(workspace) {
  return `sess-${workspace}`;
}

function workspaceForSession(sessionId) {
  return sessionId.replace(/^sess-/, "");
}

function sessionDetail(sessionId) {
  const workspace = workspaceForSession(sessionId);
  const team = workspace !== "user";
  return {
    id: sessionId,
    workspace,
    status: "active",
    kind: "code",
    runState: "idle",
    title: "Assistant",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    lastActivityAt: NOW,
    owner: team ? { type: "team", id: workspace } : { type: "user", id: USER_ID },
    isWorkspaceRuntime: true,
    messageCount: MESSAGES_PER_THREAD,
    profile: "headless",
    docker: false,
  };
}

function threadSummary(sessionId, i) {
  return {
    id: `${sessionId}-t${i}`,
    sessionId,
    title: `Thread ${i + 1}: investigate flaky deploy step ${i % 7}`,
    createdAt: NOW - i * 3_600_000,
    lastUserActivityAt: NOW - i * 3_600_000,
    lastAgentActivityAt: NOW - i * 3_600_000 + 60_000,
    readAt: NOW,
    participant: true,
  };
}

function threadsFor(sessionId) {
  return Array.from({ length: THREADS_PER_SPACE }, (_, i) => threadSummary(sessionId, i));
}

const LONG_TEXT = [
  "Here is what I found while reading the deploy logs.",
  "",
  "1. The step retries three times and then gives up.",
  "2. The cache key changes on every run, so nothing is reused.",
  "",
  "```ts\nconst key = `${branch}-${Date.now()}`;\n```",
  "",
  "| Step | Time | Result |\n| --- | --- | --- |\n| build | 3m | ok |\n| test | 7m | flaky |",
].join("\n");

function messagesFor(sessionId, threadId) {
  return Array.from({ length: MESSAGES_PER_THREAD }, (_, i) => {
    const user = i % 2 === 0;
    const content = user ? `Question ${i / 2 + 1}: why did the deploy fail?` : LONG_TEXT;
    return {
      id: `${threadId}-m${i}`,
      sessionId,
      threadId,
      role: user ? "user" : "assistant",
      content,
      parts: [{ kind: "text", text: content }],
      createdAt: NOW - (MESSAGES_PER_THREAD - i) * 60_000,
      sequence: i,
      completed: true,
      ...(user ? {} : { stopReason: "end_turn" }),
    };
  });
}

function team(t) {
  return {
    id: t.id,
    orgId: ORG_ID,
    name: t.name,
    origin: "manual",
    externalId: null,
    createdAt: NOW - 30 * 86_400_000,
    memberCount: 4,
    callerRole: "admin",
    defaultModel: null,
  };
}

const WORKFLOWS = 40;

function workflow(i) {
  return {
    id: `wf-${i}`,
    name: `Nightly report ${i + 1}`,
    definition: { name: `Nightly report ${i + 1}`, steps: [] },
    createdAt: NOW - i * 86_400_000,
    updatedAt: NOW - i * 3_600_000,
    ownerType: "user",
    ownerId: USER_ID,
  };
}

/** Ordered [method, pattern, handler]. The first match answers. */
const ROUTES = [
  ["GET", /^\/api\/auth-config$/, () => json({ stub: false, password: true, primary: "password", social: [], sso: null })],
  ["GET", /^\/api\/me$/, () => json({
    id: USER_ID, email: "perf@example.com", name: "Perf User", avatarUrl: null, role: "admin", orgId: ORG_ID,
    orgRole: "admin", defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current",
    timezone: "UTC", timezoneReportDone: true,
  })],
  ["GET", /^\/api\/org$/, () => json({
    id: ORG_ID, name: "Perf Org", createdAt: NOW, features: { organizations: true, ssoTeamSync: false },
    ssoTeamGroups: [], allowPublicArtifacts: false, plugins: [], callerRole: "admin",
  })],
  ["GET", /^\/api\/teams$/, () => json({ teams: TEAMS.map(team) })],
  ["GET", /^\/api\/notifications$/, () => json({ notifications: [] })],
  ["GET", /^\/api\/notifications\/decisions$/, () => json({ items: [] })],
  ["POST", /^\/api\/notifications\/presence$/, () => json({ ok: true })],
  ["GET", /^\/api\/tutorial$/, () => json({ version: 1, orgVersion: 0, seenVersion: 1, seenOrgVersion: 0, outcome: "completed", step: null, due: false })],
  ["GET", /^\/api\/workflows\/action-required$/, () => json({ items: [], count: 0 })],
  ["GET", /^\/api\/changelog$/, () => json({
    manifest: { schema: "valet-changelog/v2", generatedAt: new Date(NOW).toISOString(), checkpoints: [] },
    artifact: { version: "perf", sha: null, checkpointId: null, status: "empty" },
  })],
  ["POST", /^\/api\/workspaces\/([^/]+)\/runtime$/, (m) => {
    // A team space is the team id; its threads live in the workspace session.
    const workspace = decodeURIComponent(m[1]);
    const sessionId = sessionIdFor(workspace);
    return json(workspace === "user" ? { sessionId } : { sessionId, workspaceSessionId: sessionId });
  }],
  ["POST", /^\/api\/home$/, () => json({ sessionId: sessionIdFor("user"), threadId: `${sessionIdFor("user")}-t0` })],
  ["GET", /^\/api\/sessions\/([^/]+)$/, (m) => json(sessionDetail(decodeURIComponent(m[1])))],
  ["GET", /^\/api\/sessions\/([^/]+)\/threads$/, (m, url) => {
    const sessionId = decodeURIComponent(m[1]);
    const limit = Number(url.searchParams.get("limit") ?? THREADS_PER_SPACE);
    const all = url.searchParams.get("archived") === "true" ? [] : threadsFor(sessionId);
    return json({ threads: all.slice(0, limit), defaultThreadId: `${sessionId}-t0` });
  }],
  ["POST", /^\/api\/sessions\/[^/]+\/threads\/read$/, () => json({ ok: true })],
  ["GET", /^\/api\/sessions\/([^/]+)\/messages$/, (m, url) => {
    const sessionId = decodeURIComponent(m[1]);
    const threadId = url.searchParams.get("threadId") ?? `${sessionId}-t0`;
    return json({ messages: messagesFor(sessionId, threadId), hasMore: false });
  }],
  ["GET", /^\/api\/threads\/(([^/]+)-t\d+)\/messages$/, (m) => json({ messages: messagesFor(m[2], m[1]), hasMore: false })],
  ["GET", /^\/api\/threads\/(([^/]+)-t(\d+))$/, (m) => json({ ...threadSummary(m[2], Number(m[3])), workspace: workspaceForSession(m[2]) })],
  ["POST", /^\/api\/(sessions|threads)\/[^/]+\/messages$/, (_m, _url, body) => json({
    accepted: true, queueItemId: `q-${Date.now()}`, messageId: `m-${Date.now()}`, ...(body?.threadId ? { threadId: body.threadId } : {}),
  }, 202)],
  ["GET", /^\/api\/threads\/viewers$/, () => json({ threads: {} })],
  ["GET", /^\/api\/me\/thread-projects\/[^/]+$/, () => json({
    value: { projects: [], pinned: [], assignments: {}, grouped: false, collapsed: false }, revision: 1,
  })],
  ["GET", /^\/api\/sessions\/[^/]+\/children$/, () => json({ children: [], runningCount: 0 })],
  ["GET", /^\/api\/sessions\/[^/]+\/wakeups$/, () => json({ wakeups: [], leases: [] })],
  ["GET", /^\/api\/sessions\/[^/]+\/commands$/, () => json({ commands: [], diagnostics: [] })],
  ["GET", /^\/api\/threads\/[^/]+\/plan$/, () => json({ plan: null })],
  ["GET", /^\/api\/threads\/[^/]+\/context$/, () => json({ context: null })],
  ["GET", /^\/api\/home\/tasks$/, () => json({ needsYou: [], working: [], updates: [], finished: [] })],
  ["GET", /^\/api\/workspaces\/[^/]+\/channels$/, () => json({ channels: [] })],
  ["GET", /^\/api\/models$/, () => json({ models: [] })],
  ["GET", /^\/api\/org\/model-tiers$/, () => json({ xs: [], s: [], m: [], l: [], xl: [] })],
  ["GET", /^\/api\/org\/approved-models$/, () => json({ approved: null })],
  ["GET", /^\/api\/org\/reasoning$/, () => json({})],
  ["GET", /^\/api\/sessions\/[^/]+\/ratings$/, () => json({ session: null, entries: {} })],
  ["GET", /^\/api\/workflows$/, () => json({ workflows: Array.from({ length: WORKFLOWS }, (_, i) => workflow(i)) })],
  ["GET", /^\/api\/workflows\/triggers$/, () => json({ triggers: [] })],
  ["GET", /^\/api\/presence\/places$/, () => json({ places: [], channelNames: {} })],
  ["GET", /^\/api\/event-subscriptions$/, () => json({ subscriptions: [] })],
  ["GET", /^\/api\/events\/log$/, () => json({ items: [], nextCursor: null, lastEventAt: null, windowDays: 7 })],
  ["GET", /^\/api\/workspaces\/[^/]+\/integration-limit$/, () => json({ services: null })],
  ["GET", /^\/api\/plugins$/, () => json({ plugins: [] })],
  ["GET", /^\/api\/credentials$/, () => json({ credentials: [] })],
  ["GET", /^\/api\/onepassword\/settings$/, () => json({ orgTokenConnected: false, personalTokenConnected: false })],
  ["GET", /^\/api\/me\/tool-permissions$/, () => json({ tools: [] })],
  ["GET", /^\/api\/org\/directory$/, () => json({ users: [] })],
  ["GET", /^\/api\/onepassword\/team-status$/, () => json({ tokenConnected: false })],
  ["GET", /^\/api\/sessions\/[^/]+\/decisions$/, () => json({ gates: [] })],
  ["GET", /^\/api\/threads\/[^/]+\/decisions$/, () => json({ gates: [] })],
];

/** Requests no route answered, by "METHOD path". Bounded so a loop cannot grow it. */
export const unhandled = new Set();
const UNHANDLED_MAX = 200;

/** Routes every /api request of `page` through the fixtures above. */
export async function installMockApi(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    for (const [m, pattern, handler] of ROUTES) {
      if (m !== method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      let body;
      try { body = request.postDataJSON(); } catch { body = undefined; }
      return route.fulfill(handler(match, url, body));
    }
    if (unhandled.size < UNHANDLED_MAX) unhandled.add(`${method} ${url.pathname}`);
    return route.fulfill(json({ error: "No perf fixture for this request." }, 404));
  });
  // The session socket opens and stays quiet: REST carries thread history.
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/ws/, (ws) => {
    const sessionId = decodeURIComponent(new URL(ws.url()).pathname.split("/")[3] ?? "");
    ws.send(JSON.stringify({ seq: 1, ts: Date.now(), type: "init", session: sessionDetail(sessionId) }));
    ws.onMessage(() => {});
  });
}
