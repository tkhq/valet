import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { acknowledgeProductAnnouncement, pendingProductAnnouncements, WORKFLOW_THREADS_ANNOUNCEMENT } from "./product-announcements.js";

import { linkIdentity } from "../channels/identity-links.js";
import { resetThreadAccessCache } from "./thread-access.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); resetThreadAccessCache(); await api?.cleanup(); api = undefined; });

describe("product announcements", () => {
  it("limits the audience to existing visible run threads and persists idempotent acknowledgement", async () => {
    api = await bootTestApi();
    const deps = api.providers; const db = deps.db;
    await db.execute(sql`UPDATE "user" SET created_at=to_timestamp(1) WHERE id='local-user'`);
    await db.execute(sql`INSERT INTO product_announcements(id,activated_at) VALUES ('workflow-run-threads-in-automations-v1',10000) ON CONFLICT(id) DO UPDATE SET activated_at=10000`);
    const pending = () => pendingProductAnnouncements(deps, "local-user", "local-org");
    expect(await pending()).toEqual([]);
    await db.execute(sql`INSERT INTO agent_sessions(id,user_id,org_id,owner_type,owner_id,workspace,created_at,updated_at)
      VALUES ('announcement-session','local-user','other-org','user','local-user','w',1,1)`);
    await db.execute(sql`INSERT INTO engine_threads(id,session_id,key,status,queue_mode,created_at,updated_at)
      VALUES ('announcement-thread','announcement-session','signal:workflow:run','idle','steer',1,1)`);
    expect(await pending()).toEqual([]);
    await db.execute(sql`UPDATE agent_sessions SET org_id='local-org',owner_id='other-user' WHERE id='announcement-session'`);
    expect(await pending()).toEqual([]);
    await db.execute(sql`UPDATE agent_sessions SET owner_id='local-user' WHERE id='announcement-session'`);
    await db.execute(sql`UPDATE engine_threads SET key='workflow:editor:local-user' WHERE id='announcement-thread'`);
    expect(await pending()).toEqual([]);
    await db.execute(sql`UPDATE engine_threads SET key='signal:workflow:run',created_at=20000 WHERE id='announcement-thread'`);
    expect(await pending()).toEqual([]);
    await db.execute(sql`UPDATE engine_threads SET created_at=1 WHERE id='announcement-thread'`);
    await db.execute(sql`UPDATE "user" SET created_at=to_timestamp(20) WHERE id='local-user'`);
    expect(await pending()).toEqual([]);
    await db.execute(sql`UPDATE "user" SET created_at=to_timestamp(1) WHERE id='local-user'`);
    expect(await pending()).toEqual([WORKFLOW_THREADS_ANNOUNCEMENT]);
    const response = await fetch(`${api.baseUrl}/api/product-announcements`);
    expect(await response.json()).toEqual({ announcements: [WORKFLOW_THREADS_ANNOUNCEMENT] });
    expect(await acknowledgeProductAnnouncement(deps,"local-user","local-org","unknown")).toBe(false);
    expect(await acknowledgeProductAnnouncement(deps,"other-user","local-org",WORKFLOW_THREADS_ANNOUNCEMENT.id)).toBe(false);
    for (let i=0; i<2; i++) {
      const ack = await fetch(`${api.baseUrl}/api/product-announcements/${WORKFLOW_THREADS_ANNOUNCEMENT.id}/acknowledge`, { method: "POST" });
      expect(ack.status).toBe(200);
    }
    expect(await pending()).toEqual([]);
    expect(await (await fetch(`${api.baseUrl}/api/product-announcements`)).json()).toEqual({ announcements: [] });
  });
  it("checks team membership and permits private conversations only for their members", async () => {
    api = await bootTestApi(); const deps = api.providers; const db=deps.db;
    await db.execute(sql`UPDATE "user" SET created_at=to_timestamp(1) WHERE id='local-user'`);
    await db.execute(sql`INSERT INTO product_announcements(id,activated_at) VALUES ('workflow-run-threads-in-automations-v1',10000) ON CONFLICT(id) DO UPDATE SET activated_at=10000`);
    await db.execute(sql`INSERT INTO teams(id,org_id,name,created_at) VALUES ('announcement-team','local-org','Announcement team',1)`);
    await db.execute(sql`INSERT INTO agent_sessions(id,user_id,org_id,owner_type,owner_id,workspace,created_at,updated_at)
      VALUES ('announcement-session','local-user','local-org','team','announcement-team','w',1,1)`);
    await db.execute(sql`INSERT INTO engine_threads(id,session_id,key,status,queue_mode,created_at,updated_at)
      VALUES ('announcement-thread','announcement-session','signal:workflow:run','idle','steer',1,1)`);
    const pending=()=>pendingProductAnnouncements(deps,"local-user","local-org");
    expect(await pending()).toEqual([]);
    await db.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES ('announcement-team','local-user','member')`);
    expect(await pending()).toEqual([WORKFLOW_THREADS_ANNOUNCEMENT]);
    await db.execute(sql`UPDATE engine_threads SET key='slack-events:private-channel:workflow:run' WHERE id='announcement-thread'`);
    expect(await pending()).toEqual([]);
    await deps.engineCredentials.save({ type: "org", id: "local-org" }, "slack", { type: "oauth2", accessToken: "xoxb-test" });
    await linkIdentity(db, { provider: "slack", externalId: "PRIVATE-MEMBER", userId: "local-user" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      ok: true, channel: { name: "private-channel", is_private: true }, members: ["PRIVATE-MEMBER"],
    }), { headers: { "content-type": "application/json" } }));
    resetThreadAccessCache();
    expect(await pending()).toEqual([WORKFLOW_THREADS_ANNOUNCEMENT]);
    await db.execute(sql`DELETE FROM team_members WHERE team_id='announcement-team'`);
    expect(await pending()).toEqual([]);
  });
});
