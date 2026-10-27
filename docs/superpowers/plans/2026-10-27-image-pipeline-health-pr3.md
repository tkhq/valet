# Image Pipeline Health, PR 3 (visibility) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins learn within minutes when an image source is unusable and see why; users see when a session runs on a fallback image; operators get gauges for the alerts in PR 4.

**Architecture:** PR 2 persisted health on `image_sources` and `image_fallback` on sessions. PR 3 carries both to the wire (type additions only; the routes already spread rows), adds a `platform` notification kind routed to org admins on health transitions with per-episode dedupe and recovery hysteresis, renders health, guidance, and a deep link on the sources page, a fallback banner and image label on the session, three observable gauges, and an "Images" dashboard row. One guidance table in `@valet/shared` is used by the api (notification body), the web (sources row, banner), and the PR 4 runbook.

**Tech Stack:** TypeScript, Hono routes, drizzle, OpenTelemetry observable gauges, React + TanStack Router/Query, Testing Library, Grafana JSON.

**Spec:** `docs/plans/2026-10-26-image-pipeline-health-design.md`, section 14 item 3, drawing on sections 6.4, 7.4, 9, 11. Builds on PR 2 (branch `conner/image-pipeline-health-pr2`).

## Global Constraints

- Branch `conner/image-pipeline-health-pr3` off `conner/image-pipeline-health-pr2` (stacked; retarget after each parent merges). Signed commits with `Changelog:` trailers on `feat`/`fix`; tests as `pnpm --filter <pkg> test <file>` with no `--`; web package is `@valet/web`, shared is `@valet/shared`.
- No schema change in this PR. `notifications.kind` is free text, so the new kind needs no DDL.
- New `AttentionKind` and `NotificationKind` value `platform`, added in `packages/api/src/orchestrator/attention.ts`, `packages/api/src/wire/types.ts`, `packages/api/src/routes/notifications.ts` (`NOTIFICATION_KINDS`), and `packages/web/src/routes/settings.notifications.tsx` (shown only to org admins).
- Health transitions into or out of `incompatible`, `failing`, or `unbaked` route attention with `owner: { type: "org", id: source.orgId }`, `dedupeKey = image-source:<sourceId>:<reason>:<healthCheckedAt>`; the DM gate in `routeAttention` widens from `owner.type === "team"` to `owner.type !== "user"`; `urgency` `high` for `incompatible` and `failing`, `normal` for `unbaked` and recovery; titles "Image for `<name>` cannot be rebuilt" (failing), "Image for `<name>` is unusable; sessions are using the stock image" (incompatible), "Image for `<name>` has not been built yet" (unbaked), "Image for `<name>` is healthy again" (recovery); body is the guidance line plus `healthDetail`; href `/settings/organization/sandbox-images?source=<sourceId>` (spec 11.1).
- Recovery notification only when the episode lasted over 10 minutes or caused at least one fallback; recovery marks the episode's notifications read via `markAttentionNotificationsRead(db, "platform", <episode dedupeKey>)` (spec 11.1).
- Guidance table (spec 11.2) lives in `packages/shared/src/source-health.ts`, exported from `@valet/shared`, with exactly the eight guidance strings of spec 11.2 and no guidance for `ok`.
- Metrics (spec 9): observable gauges `valet.prebuild.sources{source_kind, health, reason}`, `valet.prebuild.sources.bound_unhealthy{source_kind}`, `valet.prebuild.scheduler.last_pass_age` (unit `s`, no labels), in `packages/api/src/observability/prebuild-lifecycle.ts`, labels bounded through `boundedPrebuildAttributes` plus the health and reason enums; no source names or ids.
- "Bound" for `bound_unhealthy`: a repo source whose `last_bound_at` is within 7 days, or a base source with any such repo beneath it; the same predicate gates platform notifications so dormant test repos do not page or notify.
- Sources page (spec 11.3): `StatusDot` by health with the phrases "Healthy, built <relative>", "Rebuilding", "Unusable: image predates the current runtime", "Failing: <guidance>", "Not built yet"; status sort order `failing`, `incompatible`, `unbaked`, `stale`, `healthy`, then disabled; expanded row shows contract version and source, parent bake, "since" (`healthCheckedAt`), `healthDetail`; `?source=<id>` expands that row on load.
- Session (spec 7.4): banner "Running on the stock image. The `<repo>` image failed its compatibility check and is being rebuilt." plus the guidance line, "Manage images" link only for org admins; image label "Image: `<repo>`, built <relative>" or "Image: stock (`<repo>` unavailable)".
- PR description: at most 300 words, no em dashes, a `## Validation` section.

## Deliberate refinements of the spec

1. **Spec 11.1 episode key.** PR 2 (its refinement 9) made `health_checked_at` the time the current (health, reason) was entered, so the episode key is stable for the episode's life and changes on re-entry after recovery. No extra column.
2. **Spec 11.1 audience scope.** Notifications fire only for sources that satisfy the same "bound" predicate as the `bound_unhealthy` gauge (spec 10 says dormant repos must not page; the same holds for admin inboxes).
3. **Spec 11.2 location.** The table lives in `@valet/shared`, not `packages/web/src/components/settings/source-health.ts`, because the api needs it for the notification body and cannot import the web package. The web re-exports it from the path the spec names.
4. **Spec 7.4 image label.** The session detail route adds `sandboxImage: { source: "repo" | "stock"; repoFullName: string | null; builtAt: number | null; fallback: ImageFallback | null }`, derived from `agent_sessions.bake_id` and `image_fallback`; the web renders the label from it. "Base" is not distinguished from "stock" in the label (the user-facing distinction is "your repo's image or not").
5. **Spec 9 `startup_failed` label.** The counter PR 1 shipped uses `kind`, not `reason`; the dashboard row and PR 4 alerts use `kind`.

## Review Focus

1. A source that flaps `failing` → `healthy` → `failing` within ten minutes: one notification per episode, no recovery notification for the short episode, the earlier episode's rows marked read. Owner: Task 3.
2. An org admin with `platform` web delivery turned off: no notification row and no pending channel delivery. Owner: Task 2.
3. `?source=<id>` for a source that is not in the list (deleted or another org): the page renders without error and nothing is expanded. Owner: Task 6.
4. A session whose `bake_id` points at a deleted bake row: the detail route still returns `sandboxImage` (source `stock`, `builtAt` null) rather than 500. Owner: Task 1.
5. The sources gauge after a source is deleted: the next snapshot no longer reports it (the snapshot is rebuilt from the table, never accumulated). Owner: Task 5.

---

### Task 1: Wire types and the session image detail

**Files:**
- Modify: `packages/api/src/wire/types.ts` (`SourceSummary` ~5186, `BakeSummary` ~5210, `SessionDetail` ~122, `NotificationKind` ~2334)
- Modify: `packages/api/src/routes/sessions.ts` (detail handler ~880-930)
- Modify: `packages/api/src/orchestrator/attention.ts:42` (`AttentionKind`), `packages/api/src/routes/notifications.ts:141` (`NOTIFICATION_KINDS`)
- Test: `packages/api/src/routes/sources.test.ts`, `packages/api/src/routes/sessions.test.ts` (or the nearest sessions detail test file)

**Interfaces:**
- Produces: `SourceSummary.health: SourceHealth; healthReason: SourceHealthReason; healthDetail: string | null; healthCheckedAt: number | null`; `BakeSummary.contractVersion: number | null; contractSource: "label" | "missing" | "override" | null; parentBakeId: string | null`; `SessionDetail.sandboxImage?: SessionSandboxImage` with `export interface SessionSandboxImage { source: "repo" | "stock"; repoFullName: string | null; builtAt: number | null; fallback: ImageFallback | null }` and `ImageFallback` re-exported in wire types as `{ reason: "contract"; sourceId: string; bakeId: string; at: number }`; `NotificationKind` and `AttentionKind` gain `"platform"`; `NOTIFICATION_KINDS` includes it.

- [ ] **Step 1: Write the failing tests**

In `sources.test.ts`, next to "includes only the latest build summary":

```ts
  it("exposes source health and bake contract fields on the wire", async () => {
    api = await bootTestApi();
    const source = await seedRepoSource(api);
    await api.providers.db.update(imageSources).set({ health: "failing", healthReason: "bake_failed", healthDetail: "npm ci exploded", healthCheckedAt: 1234 }).where(eq(imageSources.id, source.id));
    await api.providers.db.insert(bakes).values({ id: "pb_contract", sourceId: source.id, identityHash: "x", imageRef: "registry/x", status: "pushed", recipe: [], createdAt: 1000, contractVersion: 3, contractSource: "label", parentBakeId: null, baseImageRef: "stock:ref" });
    const list = (await (await fetch(`${api.baseUrl}/api/org/sources`, { headers: HEADERS })).json()) as ListSourcesResponse;
    expect(list.sources.find((s) => s.id === source.id)).toMatchObject({ health: "failing", healthReason: "bake_failed", healthDetail: "npm ci exploded", healthCheckedAt: 1234 });
    const history = (await (await fetch(`${api.baseUrl}/api/org/sources/${source.id}/bakes`, { headers: HEADERS })).json()) as ListBakesResponse;
    expect(history.bakes[0]).toMatchObject({ contractVersion: 3, contractSource: "label", parentBakeId: null });
  });
```

In the sessions detail test file (find the test that asserts `profile` on `GET /api/sessions/:id`; add beside it):

```ts
  it("reports the sandbox image: repo bake with build time, or stock with the fallback reason", async () => {
    // seed a repo source + pushed bake pb_img (finishedAt 5000, source repoFullName acme/widgets) and a session row with bakeId pb_img
    let detail = await getSession(sessionId);
    expect(detail.sandboxImage).toEqual({ source: "repo", repoFullName: "acme/widgets", builtAt: 5000, fallback: null });
    // now a session with no bakeId but image_fallback set
    await api.providers.db.update(agentSessions).set({ bakeId: null, imageFallback: { reason: "contract", sourceId: "src", bakeId: "pb_bad", at: 1 } }).where(eq(agentSessions.id, sessionId));
    detail = await getSession(sessionId);
    expect(detail.sandboxImage).toEqual({ source: "stock", repoFullName: "acme/widgets", builtAt: null, fallback: { reason: "contract", sourceId: "src", bakeId: "pb_bad", at: 1 } });
    // bake_id pointing at a deleted bake row degrades to stock, never 500 (Review Focus 4)
    await api.providers.db.update(agentSessions).set({ bakeId: "pb_gone", imageFallback: null }).where(eq(agentSessions.id, sessionId));
    detail = await getSession(sessionId);
    expect(detail.sandboxImage).toEqual({ source: "stock", repoFullName: "acme/widgets", builtAt: null, fallback: null });
  });
```

`repoFullName` comes from the session's primary repo binding (`repos[0].fullName`), null when unbound. Use the file's existing helpers for seeding a session with a repo binding and fetching the detail; adapt the names.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/routes/sources.test.ts src/routes/sessions.test.ts -t "wire|sandbox image"`
Expected: FAIL (fields absent on the wire types; `sandboxImage` undefined).

- [ ] **Step 3: Implement**

`wire/types.ts`:

```ts
export type SourceHealth = "healthy" | "stale" | "incompatible" | "failing" | "unbaked";
export type SourceHealthReason =
  | "ok" | "resolve_failed" | "repo_unreachable" | "credentials" | "registry_full"
  | "bake_failed" | "contract" | "contract_unknown" | "waiting_for_base";
export interface ImageFallback { reason: "contract"; sourceId: string; bakeId: string; at: number }
```

`SourceSummary` gains `health: SourceHealth; healthReason: SourceHealthReason; healthDetail: string | null; healthCheckedAt: number | null;` (after `lastBoundAt`); `BakeSummary` gains `contractVersion: number | null; contractSource: "label" | "missing" | "override" | null; parentBakeId: string | null;` (after `sizeBytes` if present, else after `finishedAt`). `NotificationKind = "notification" | "question" | "escalation" | "approval" | "review" | "platform"`. `SessionDetail` gains:

```ts
  /** Which image the sandbox runs (spec 7.4). Absent on list rows. */
  sandboxImage?: SessionSandboxImage;
```

with

```ts
export interface SessionSandboxImage {
  source: "repo" | "stock";
  repoFullName: string | null;
  builtAt: number | null;
  fallback: ImageFallback | null;
}
```

`attention.ts:42`: `export type AttentionKind = "notification" | "question" | "escalation" | "approval" | "review" | "platform";`. `notifications.ts:141`: add `"platform"` to `NOTIFICATION_KINDS`.

`sessions.ts` detail handler, before building `detail`:

```ts
  const sandboxImage = await sessionSandboxImage(db, row, repos[0]?.fullName ?? null);
```

and `sandboxImage,` in the literal. Helper in the same file:

```ts
/** Spec 7.4. A missing bake row (pruned by retention) reads as stock. */
async function sessionSandboxImage(db: AppDb, row: typeof agentSessions.$inferSelect, repoFullName: string | null): Promise<SessionSandboxImage> {
  const fallback = (row.imageFallback as ImageFallback | null) ?? null;
  if (row.bakeId) {
    const [bake] = await db.select({ finishedAt: bakes.finishedAt, createdAt: bakes.createdAt }).from(bakes).where(eq(bakes.id, row.bakeId)).limit(1);
    if (bake) return { source: "repo", repoFullName, builtAt: bake.finishedAt ?? bake.createdAt, fallback: null };
  }
  return { source: "stock", repoFullName, builtAt: null, fallback };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/routes/sources.test.ts src/routes/sessions.test.ts src/routes/notifications.test.ts` and `pnpm --filter @valet/api typecheck`; also `pnpm --filter @valet/web typecheck` (the web consumes the wire types; adding fields must not break it).
Expected: PASS.

- [ ] **Step 5: Stage and record**

`git add` the changed files. (No commit; see Global Constraints and the controller's batching note.)

Commit message, for the batch: `feat(api): expose source health, bake contract, session image, and the platform notification kind` with `Changelog: internal`.

---

### Task 2: The platform kind in the attention router

**Files:**
- Modify: `packages/api/src/orchestrator/attention.ts` (`defaultChannelGraceSeconds` ~190; DM gate ~319)
- Modify: `packages/web/src/routes/settings.notifications.tsx` (kinds, labels, admin gate)
- Test: `packages/api/src/orchestrator/attention.test.ts`, `packages/web/src/routes/-settings.notifications.test.tsx` (create if absent, modeled on `-settings.organization.test.tsx`)

**Interfaces:**
- Consumes: `AttentionKind` includes `platform` (Task 1).
- Produces: `routeAttention` for an org owner creates web rows for org admins only and enqueues no channel delivery unless the admin's `teamDm` preference for the kind is on; `platform` grace defaults to 300 s like `notification`.

- [ ] **Step 1: Write the failing tests**

In `attention.test.ts` (DB-backed describe):

```ts
  it("platform kind for an org owner reaches org admins only and enqueues no DM without teamDm", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const deliver = vi.fn(async () => {});
    await routeAttention({ db, channels: [{ id: "slack", order: 1, grace: "when-web-active", deliver }] }, {
      kind: "platform", owner: { type: "org", id: "local-org" }, title: "Image for acme/widgets cannot be rebuilt", dedupeKey: "image-source:src1:bake_failed:1",
    });
    const rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
    expect(rows.map((r) => r.userId).sort()).toEqual(["local-user", "test-admin"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["n-platform-image-source:src1:bake_failed:1-local-user", "n-platform-image-source:src1:bake_failed:1-test-admin"]);
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs).toHaveLength(0);
  });

  it("platform kind enqueues a DM for an admin who opted in with teamDm", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await db.insert(userNotificationPreferences).values({ userId: "test-admin", kind: "platform", web: true, teamDm: true });
    await routeAttention({ db, channels: [{ id: "slack", order: 1, grace: "when-web-active", deliver: async () => {} }] }, {
      kind: "platform", owner: { type: "org", id: "local-org" }, title: "t", dedupeKey: "image-source:src1:bake_failed:2",
    });
    const jobs = await db.select().from(pendingChannelDeliveries);
    expect(jobs.map((j) => j.userId)).toEqual(["test-admin"]);
  });

  it("an admin with platform web delivery off gets no row and no job (Review Focus 2)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    await db.insert(userNotificationPreferences).values({ userId: "test-admin", kind: "platform", web: false });
    await routeAttention({ db, channels: [{ id: "slack", order: 1, grace: "when-web-active", deliver: async () => {} }] }, {
      kind: "platform", owner: { type: "org", id: "local-org" }, title: "t", dedupeKey: "image-source:src1:bake_failed:3",
    });
    const rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
    expect(rows.map((r) => r.userId)).toEqual(["local-user"]);
    expect(await db.select().from(pendingChannelDeliveries)).toHaveLength(0);
  });
```

Web test: the notifications settings page shows a "Platform" row only when `useOrg().data.callerRole === "admin"` (mock `~/api/settings` the way `-settings.organization.test.tsx` does).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/orchestrator/attention.test.ts -t platform` and `pnpm --filter @valet/web test src/routes/-settings.notifications.test.tsx`
Expected: FAIL (DM job enqueued for the org owner without teamDm; no Platform row).

- [ ] **Step 3: Implement**

`attention.ts`: `defaultChannelGraceSeconds` returns 300 for `notification` and `platform`. DM gate (line ~319): `if (event.owner.type !== "user" && preference?.teamDm !== true) return;` with the comment updated: "Team and org events are web-only unless the member opted in to DM copies."

`settings.notifications.tsx`: add `"platform"` to `NOTIFICATION_KINDS`, `KIND_LABEL.platform = "Platform"`, `KIND_DESCRIPTION.platform = "When a sandbox image for your organization cannot be built or used. Org admins only."`; in the render, skip the row when `kind === "platform"` and the caller is not an org admin (`useOrg().data?.callerRole !== "admin"`).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/orchestrator/attention.test.ts src/routes/notifications.test.ts`, `pnpm --filter @valet/web test src/routes/-settings.notifications.test.tsx`, both typechecks.
Expected: PASS; existing team DM tests unchanged.

- [ ] **Step 5: Stage and record**

Commit message for the batch: `feat(api): platform notification kind for org admins` with `Changelog: Org admins can receive "Platform" notifications about sandbox image problems; web by default, direct message when opted in.`

---

### Task 3: Health transitions notify org admins

**Files:**
- Create: `packages/shared/src/source-health.ts` (+ export from `packages/shared/src/index.ts`), `packages/shared/src/source-health.test.ts`
- Modify: `packages/api/src/bakes/source-service.ts` (`SourceServiceDeps`; `setSourceHealth`), `packages/api/src/providers/node.ts`, `packages/api/src/integration/_setup.ts`
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `setSourceHealth` returns `boolean` on transition and stamps `healthCheckedAt` (PR 2); `routeAttention`, `markAttentionNotificationsRead` (attention.ts).
- Produces: `@valet/shared`: `export const SOURCE_HEALTH_GUIDANCE: Record<Exclude<SourceHealthReason, "ok">, string>` and `export function sourceHealthGuidance(reason: SourceHealthReason): string | null`, plus `export function sourceHealthPhrase(health, reason, builtAt: number | null, now: number): string` (the row phrases of spec 11.3). `SourceServiceDeps.attention?: AttentionDeps`; private `notifyHealthTransition(source, previous, next)`; `private sourceMatters(source): Promise<boolean>` (the bound predicate, shared with Task 5's gauge).

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/source-health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCE_HEALTH_GUIDANCE, sourceHealthGuidance, sourceHealthPhrase } from "./source-health.js";

describe("source health guidance", () => {
  it("has the eight spec 11.2 lines and none for ok", () => {
    expect(Object.keys(SOURCE_HEALTH_GUIDANCE).sort()).toEqual(["bake_failed", "contract", "contract_unknown", "credentials", "registry_full", "repo_unreachable", "resolve_failed", "waiting_for_base"]);
    expect(sourceHealthGuidance("ok")).toBeNull();
    expect(sourceHealthGuidance("contract")).toBe("The image was built before a runtime change. A rebuild is already queued.");
  });
  it("renders the row phrase per health", () => {
    const now = 10 * 60 * 60 * 1000;
    expect(sourceHealthPhrase("healthy", "ok", now - 2 * 60 * 60 * 1000, now)).toBe("Healthy, built 2h ago");
    expect(sourceHealthPhrase("stale", "ok", null, now)).toBe("Rebuilding");
    expect(sourceHealthPhrase("stale", "waiting_for_base", null, now)).toBe("Rebuilding");
    expect(sourceHealthPhrase("incompatible", "contract", null, now)).toBe("Unusable: image predates the current runtime");
    expect(sourceHealthPhrase("failing", "repo_unreachable", null, now)).toBe("Failing: The Valet GitHub app lost access. Reinstall it on this repository.");
    expect(sourceHealthPhrase("unbaked", "ok", null, now)).toBe("Not built yet");
  });
});
```

In `source-service.test.ts`, `describe("health notifications")`, using the file's `makeService` with `attention: { db }` and reading `notifications` / `pendingChannelDeliveries` like `attention.test.ts` does (org admins seeded by the test db: check `seedOrg` and add an `org_members` admin row if the fixture lacks one):

```ts
    it("entering failing on a bound repo source notifies org admins once per episode, with the deep link", async () => {
      const src = await seedRepoSource(db, { lastBoundAt: NOW });
      const svc = makeService({ attention: { db } });
      await svc.setSourceHealth(src, "failing", "bake_failed", "npm ci exploded");
      await svc.setSourceHealth(src, "failing", "bake_failed", "npm ci exploded again"); // same episode
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
      expect(rows).toHaveLength(ADMIN_COUNT);
      expect(rows[0]).toMatchObject({ urgency: "high", title: "Image for `acme/widgets` cannot be rebuilt", href: `/settings/organization/sandbox-images?source=${src}` });
      expect(rows[0].body).toContain("The setup commands failed. The log tail shows where.");
      expect(rows[0].body).toContain("npm ci exploded");
      expect(rows[0].id).toBe(`n-platform-image-source:${src}:bake_failed:${NOW}-${rows[0].userId}`);
    });

    it("a dormant repo source (not bound in 7 days) does not notify", async () => {
      const src = await seedRepoSource(db, { lastBoundAt: NOW - 8 * 24 * 60 * 60 * 1000 });
      await makeService({ attention: { db } }).setSourceHealth(src, "failing", "bake_failed", "x");
      expect(await db.select().from(notifications)).toHaveLength(0);
    });

    it("a base source always matters when any bound repo sits beneath it", async () => {
      const baseId = await seedBaseSource(db, []);
      await seedRepoSource(db, { parentId: baseId, lastBoundAt: NOW });
      await makeService({ attention: { db } }).setSourceHealth(baseId, "failing", "bake_failed", "x");
      expect((await db.select().from(notifications)).length).toBeGreaterThan(0);
    });

    it("recovery after a long episode marks the episode read and posts one normal notification; a short flap posts none (Review Focus 1)", async () => {
      const src = await seedRepoSource(db, { lastBoundAt: NOW });
      let t = NOW;
      const svc = makeService({ attention: { db }, now: () => t });
      await svc.setSourceHealth(src, "failing", "bake_failed", "x");
      t = NOW + 5 * 60_000;
      await svc.setSourceHealth(src, "healthy", "ok", null); // short episode: no recovery row
      let rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
      expect(rows.every((r) => r.readAt !== null)).toBe(true);
      expect(rows.filter((r) => r.title.includes("healthy again"))).toHaveLength(0);
      t = NOW + 6 * 60_000;
      await svc.setSourceHealth(src, "failing", "bake_failed", "y"); // new episode → new rows
      rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
      expect(rows.filter((r) => r.readAt === null)).toHaveLength(ADMIN_COUNT);
      t = NOW + 20 * 60_000;
      await svc.setSourceHealth(src, "healthy", "ok", null); // long episode: recovery row
      rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
      expect(rows.filter((r) => r.title === "Image for `acme/widgets` is healthy again")).toHaveLength(ADMIN_COUNT);
    });

    it("a short episode that caused a fallback still gets a recovery notification", async () => {
      const src = await seedRepoSource(db, { lastBoundAt: NOW });
      let t = NOW;
      const svc = makeService({ attention: { db }, now: () => t });
      await svc.setSourceHealth(src, "incompatible", "contract", "x");
      await db.insert(agentSessions).values({ id: "s-fb", userId: "u1", orgId, workspace: "/w", status: "active", ownerType: "user", ownerId: "u1", profile: "headless", imageFallback: { reason: "contract", sourceId: src, bakeId: "b", at: NOW + 1 }, createdAt: NOW, updatedAt: NOW });
      t = NOW + 60_000;
      await svc.setSourceHealth(src, "healthy", "ok", null);
      const rows = await db.select().from(notifications).where(eq(notifications.kind, "platform"));
      expect(rows.filter((r) => r.title.includes("healthy again"))).toHaveLength(ADMIN_COUNT);
    });
```

Define `ADMIN_COUNT` from the admins the test seeds (insert `org_members` rows with `role: "admin"` for two users in a `beforeEach` of this describe if `seedOrg` does not).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/shared test src/source-health.test.ts` and `pnpm --filter @valet/api test src/bakes/source-service.test.ts -t "health notifications"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/shared/src/source-health.ts`:

```ts
/** Spec 11.2: one guidance line per non-ok health reason, shared by the
 * sources page, the session banner, the admin notification, and the runbook. */
export type SourceHealth = "healthy" | "stale" | "incompatible" | "failing" | "unbaked";
export type SourceHealthReason =
  | "ok" | "resolve_failed" | "repo_unreachable" | "credentials" | "registry_full"
  | "bake_failed" | "contract" | "contract_unknown" | "waiting_for_base";

export const SOURCE_HEALTH_GUIDANCE: Record<Exclude<SourceHealthReason, "ok">, string> = {
  resolve_failed: "Valet could not read the repo's recipe or lockfile. Usually a platform bug; the detail names the file.",
  repo_unreachable: "The Valet GitHub app lost access. Reinstall it on this repository.",
  credentials: "Anonymous bakes are off for this org. Connect an org GitHub credential.",
  registry_full: "The image registry is out of space. Retention needs to run.",
  bake_failed: "The setup commands failed. The log tail shows where.",
  contract: "The image was built before a runtime change. A rebuild is already queued.",
  contract_unknown: "Valet could not read the image's label from the registry. It will retry.",
  waiting_for_base: "The base image is building first. Nothing to do.",
};

export function sourceHealthGuidance(reason: SourceHealthReason): string | null {
  return reason === "ok" ? null : SOURCE_HEALTH_GUIDANCE[reason];
}

/** Spec 11.3 row phrase. `relative` renders "2h ago"; callers pass their
 * own formatter so the api and web agree on wording without sharing a
 * date library. */
export function sourceHealthPhrase(
  health: SourceHealth,
  reason: SourceHealthReason,
  builtAt: number | null,
  now: number,
  relative: (ts: number, now: number) => string = defaultRelative,
): string {
  switch (health) {
    case "healthy": return builtAt === null ? "Healthy" : `Healthy, built ${relative(builtAt, now)}`;
    case "stale": return "Rebuilding";
    case "incompatible": return "Unusable: image predates the current runtime";
    case "failing": return `Failing: ${sourceHealthGuidance(reason) ?? reason}`;
    case "unbaked": return "Not built yet";
  }
}

function defaultRelative(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
```

Export from `packages/shared/src/index.ts`: `export * from './source-health.js';`. (The schema's `SourceHealth`/`SourceHealthReason` types in the api should now be imported from `@valet/shared` to avoid two definitions; change the schema file's `export type` lines to re-exports.)

`source-service.ts`:

```ts
import { routeAttention, markAttentionNotificationsRead, type AttentionDeps } from "../orchestrator/attention.js";
import { sourceHealthGuidance } from "@valet/shared";

const RECOVERY_MIN_EPISODE_MS = 10 * 60_000;
const BOUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNHEALTHY: ReadonlySet<SourceHealth> = new Set(["incompatible", "failing", "unbaked"]);
```

`SourceServiceDeps.attention?: AttentionDeps;` stored as `private readonly attention?: AttentionDeps`.

Change `setSourceHealth` to capture the previous row (`health`, `reason`, `checkedAt`) and, after a transition write, call `await this.notifyHealthTransition(sourceId, previous, { health, reason, detail: trimmed, at: now }).catch((err) => console.error(...))`. Then:

```ts
  /** Spec 10/11 "bound": a repo bound in the last 7 days, or a base with
   * such a repo beneath it. Dormant sources neither page nor notify. */
  async sourceMatters(source: ImageSourceRow): Promise<boolean> {
    const since = this.now() - BOUND_WINDOW_MS;
    if (source.kind === "repo") return (source.lastBoundAt ?? 0) >= since;
    if (source.kind === "base") {
      const rows = await this.db.select({ id: imageSources.id }).from(imageSources)
        .where(and(eq(imageSources.parentId, source.id), eq(imageSources.kind, "repo"), gte(imageSources.lastBoundAt, since))).limit(1);
      return rows.length > 0;
    }
    return false;
  }

  private async notifyHealthTransition(
    sourceId: string,
    previous: { health: SourceHealth; reason: SourceHealthReason; checkedAt: number | null },
    next: { health: SourceHealth; reason: SourceHealthReason; detail: string | null; at: number },
  ): Promise<void> {
    if (!this.attention) return;
    const source = await this.loadSource(sourceId).catch(() => null);
    if (!source || !(await this.sourceMatters(source))) return;
    const name = source.repoFullName ?? source.name;
    const href = `/settings/organization/sandbox-images?source=${sourceId}`;
    const owner = { type: "org" as const, id: source.orgId };
    const wasUnhealthy = UNHEALTHY.has(previous.health);
    const isUnhealthy = UNHEALTHY.has(next.health);
    if (isUnhealthy && (!wasUnhealthy || previous.reason !== next.reason)) {
      if (wasUnhealthy && previous.checkedAt !== null) {
        await markAttentionNotificationsRead(this.attention.db, "platform", `image-source:${sourceId}:${previous.reason}:${previous.checkedAt}`);
      }
      const title = next.health === "failing" ? `Image for \`${name}\` cannot be rebuilt`
        : next.health === "incompatible" ? `Image for \`${name}\` is unusable; sessions are using the stock image`
        : `Image for \`${name}\` has not been built yet`;
      const guidance = sourceHealthGuidance(next.reason);
      await routeAttention(this.attention, {
        kind: "platform", owner, urgency: next.health === "unbaked" ? "normal" : "high",
        title, body: [guidance, next.detail].filter(Boolean).join("\n\n"), href,
        dedupeKey: `image-source:${sourceId}:${next.reason}:${next.at}`,
      });
      return;
    }
    if (wasUnhealthy && !isUnhealthy && previous.checkedAt !== null) {
      await markAttentionNotificationsRead(this.attention.db, "platform", `image-source:${sourceId}:${previous.reason}:${previous.checkedAt}`);
      const lasted = next.at - previous.checkedAt;
      const fellBack = (await this.db.select({ id: agentSessions.id }).from(agentSessions)
        .where(and(eq(agentSessions.orgId, source.orgId), sql`${agentSessions.imageFallback} ->> 'sourceId' = ${sourceId}`, sql`(${agentSessions.imageFallback} ->> 'at')::bigint >= ${previous.checkedAt}`)).limit(1)).length > 0;
      if (lasted >= RECOVERY_MIN_EPISODE_MS || fellBack) {
        await routeAttention(this.attention, {
          kind: "platform", owner, urgency: "normal", title: `Image for \`${name}\` is healthy again`, href,
          dedupeKey: `image-source:${sourceId}:recovered:${next.at}`,
        });
      }
    }
  }
```

(`gte` and `sql` from `drizzle-orm`.) Note the fallback check must also count sessions whose `image_fallback` was since cleared; if that proves to be the common case (PR 2 clears it when the compatible bake resolves, which happens right around recovery), count instead from the `valet.sandbox.image_fallback` path by recording `lastFallbackAt` per source in process memory inside `handleImageFallback` (a `Map<string, number>`), and use `lastFallbackAt >= previous.checkedAt`. Implement the in-memory map; keep the DB check as a fallback for a restarted process.

Wiring: `providers/node.ts` passes `attention: { db, channels: <the same channels the other producers pass>, access: ... }` to `new SourceService({...})` (find how `routeAttention` deps are built elsewhere in node.ts and reuse that object); `_setup.ts` passes `attention: { db }`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/shared test`, `pnpm --filter @valet/api test src/bakes/source-service.test.ts src/orchestrator/attention.test.ts`, typecheck api, shared, web.
Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `feat(bakes): notify org admins when an image source becomes unusable or recovers` with `Changelog: Org admins get a Platform notification when a repository or base image cannot be built or used, with the reason and a link to fix it, and one when it recovers.`

---

### Task 4: Session banner and image label in the web client

**Files:**
- Modify: `packages/web/src/components/session/session-view.tsx` (above the composer area, ~line 470-490 where `readOnlyReason` renders)
- Modify: `packages/web/src/components/session/session-header.tsx` (`SandboxChip`, ~line 812)
- Create: `packages/web/src/components/session/image-fallback-banner.tsx`
- Test: `packages/web/src/components/session/-image-fallback-banner.test.tsx` (create), `packages/web/src/components/session/session-header.test.tsx`

**Interfaces:**
- Consumes: `SessionDetail.sandboxImage` (Task 1), `sourceHealthGuidance` from `@valet/shared`, `useOrg` from `~/api/settings` (`callerRole`).
- Produces: `export function ImageFallbackBanner({ image, isOrgAdmin }: { image: SessionSandboxImage | undefined; isOrgAdmin: boolean })` rendering a `Callout tone="warning"` only when `image?.fallback` is set; `SandboxChip` accepts an optional `image?: SessionSandboxImage` and appends the image label to its tooltip.

- [ ] **Step 1: Write the failing tests**

`-image-fallback-banner.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ImageFallbackBanner } from "./image-fallback-banner";

const fallback = { source: "stock" as const, repoFullName: "acme/widgets", builtAt: null, fallback: { reason: "contract" as const, sourceId: "src1", bakeId: "pb", at: 1 } };

describe("ImageFallbackBanner", () => {
  it("renders nothing without a fallback", () => {
    const { container } = render(<ImageFallbackBanner image={{ source: "repo", repoFullName: "acme/widgets", builtAt: 1, fallback: null }} isOrgAdmin />);
    expect(container).toBeEmptyDOMElement();
  });
  it("explains the fallback with the guidance line and links admins to the source", () => {
    render(<ImageFallbackBanner image={fallback} isOrgAdmin />);
    expect(screen.getByRole("status")).toHaveTextContent("Running on the stock image. The `acme/widgets` image failed its compatibility check and is being rebuilt.");
    expect(screen.getByRole("status")).toHaveTextContent("The image was built before a runtime change. A rebuild is already queued.");
    expect(screen.getByRole("link", { name: "Manage images" })).toHaveAttribute("href", "/settings/organization/sandbox-images?source=src1");
  });
  it("hides the link for non-admins", () => {
    render(<ImageFallbackBanner image={fallback} isOrgAdmin={false} />);
    expect(screen.queryByRole("link", { name: "Manage images" })).toBeNull();
  });
});
```

In `session-header.test.tsx`, next to the existing `SandboxChip` test (find it by `SandboxChip`):

```tsx
  it("SandboxChip labels the image in its tooltip", async () => {
    render(<SandboxChip sandbox={{ state: "ready", epoch: 1 }} image={{ source: "repo", repoFullName: "acme/widgets", builtAt: Date.now() - 2 * 3600_000, fallback: null }} />);
    expect(screen.getByLabelText(/workspace ready.*Image: `acme\/widgets`, built 2h ago/)).toBeInTheDocument();
  });
  it("SandboxChip says stock with the unavailable repo", () => {
    render(<SandboxChip sandbox={{ state: "ready", epoch: 1 }} image={{ source: "stock", repoFullName: "acme/widgets", builtAt: null, fallback: { reason: "contract", sourceId: "s", bakeId: "b", at: 1 } }} />);
    expect(screen.getByLabelText(/Image: stock \(`acme\/widgets` unavailable\)/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/web test src/components/session/-image-fallback-banner.test.tsx src/components/session/session-header.test.tsx`
Expected: FAIL (module missing; no image label).

- [ ] **Step 3: Implement**

`image-fallback-banner.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import type { SessionSandboxImage } from "@valet/api/wire";
import { sourceHealthGuidance } from "@valet/shared";
import { Callout } from "~/components/primitives";

/** Spec 7.4 / 11.4: shown while `agent_sessions.image_fallback` is set. */
export function ImageFallbackBanner({ image, isOrgAdmin }: { image: SessionSandboxImage | undefined; isOrgAdmin: boolean }) {
  const fallback = image?.fallback;
  if (!fallback) return null;
  const repo = image.repoFullName ?? "repository";
  return (
    <Callout tone="warning" role="status" className="mx-4 my-2">
      <p>Running on the stock image. The `{repo}` image failed its compatibility check and is being rebuilt.</p>
      <p className="mt-1 text-muted">{sourceHealthGuidance(fallback.reason)}</p>
      {isOrgAdmin && (
        <Link className="mt-1 inline-block underline" to="/settings/organization/sandbox-images" search={{ source: fallback.sourceId }}>
          Manage images
        </Link>
      )}
    </Callout>
  );
}
```

If `Callout` does not forward `role`, wrap the content in a `div role="status"`. The `Link` `search` prop needs the route's search schema from Task 6; until then use `to={`/settings/organization/sandbox-images?source=${fallback.sourceId}`}` as a plain href string if the router rejects unknown search params, and switch to typed search in Task 6.

`session-view.tsx`: render `<ImageFallbackBanner image={session.data?.sandboxImage} isOrgAdmin={useOrg().data?.callerRole === "admin"} />` directly above the composer / read-only paragraph.

`session-header.tsx` `SandboxChip`: add `image?: SessionSandboxImage` prop; compute

```ts
  const imageLabel = image
    ? image.source === "repo" && image.repoFullName
      ? `Image: \`${image.repoFullName}\`${image.builtAt ? `, built ${relativeTime(image.builtAt)}` : ""}`
      : image.repoFullName ? `Image: stock (\`${image.repoFullName}\` unavailable)` : "Image: stock"
    : null;
  const label = imageLabel ? `${entry.label}. ${imageLabel}` : entry.label;
```

and use `label` for both the tooltip and `aria-label`. Pass `image={session.sandboxImage}` from the header's existing `SandboxChip` usage and from `sandbox-tabs.tsx` if it renders the chip with the detail in scope.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/web test src/components/session` and `pnpm --filter @valet/web typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `feat(web): show when a session runs on the stock image and which image it has` with `Changelog: A session that could not use its repository image shows a banner explaining why, and the sandbox indicator names the image in use.`

---

### Task 5: Source health gauges

**Files:**
- Modify: `packages/api/src/observability/prebuild-lifecycle.ts` (instruments, snapshot, exports)
- Modify: `packages/api/src/bakes/source-service.ts` (`refreshObservabilitySnapshot`; `setSourceHealth`)
- Test: `packages/api/src/observability/prebuild-lifecycle.test.ts`, `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `lastSchedulerPassAt()` (PR 2), `sourceMatters` (Task 3).
- Produces: `export interface SourceHealthSnapshot { sourceKind: string; health: SourceHealth; reason: SourceHealthReason; count: number; boundUnhealthy: number }`, `export function updateSourceHealthSnapshot(rows: SourceHealthSnapshot[]): void`; gauges `valet.prebuild.sources`, `valet.prebuild.sources.bound_unhealthy`, `valet.prebuild.scheduler.last_pass_age`.

- [ ] **Step 1: Write the failing tests**

In `prebuild-lifecycle.test.ts`, modeled on the queue-depth test:

```ts
  it("exports source health gauges and the scheduler pass age", async () => {
    metrics.disable();
    vi.resetModules();
    const lifecycle = await import("./prebuild-lifecycle.js");
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(provider);
    lifecycle.recordSchedulerPass(Date.now() - 120_000);
    lifecycle.updateSourceHealthSnapshot([
      { sourceKind: "repo", health: "failing", reason: "bake_failed", count: 2, boundUnhealthy: 1 },
      { sourceKind: "base", health: "healthy", reason: "ok", count: 1, boundUnhealthy: 0 },
    ]);
    await provider.forceFlush();
    const sources = metricNamed(exporter, "valet.prebuild.sources");
    expect(sources?.dataPoints.map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ source_kind: "repo", profile: "shared", provider: "none", health: "failing", reason: "bake_failed" }, 2],
    ]));
    const bound = metricNamed(exporter, "valet.prebuild.sources.bound_unhealthy");
    expect(bound?.dataPoints.find((p) => p.attributes.source_kind === "repo")?.value).toBe(1);
    const age = metricNamed(exporter, "valet.prebuild.scheduler.last_pass_age");
    expect(age?.dataPoints[0]?.value).toBeGreaterThanOrEqual(119);
    // A new snapshot replaces the old (Review Focus 5)
    lifecycle.updateSourceHealthSnapshot([]);
    await provider.forceFlush();
    expect(metricNamed(exporter, "valet.prebuild.sources")?.dataPoints ?? []).toEqual([]);
    await provider.shutdown();
  });
```

(Adjust the expected `profile`/`provider` attributes to whatever `boundedPrebuildAttributes` yields for `{ sourceKind: "repo", profile: null, provider: undefined }`; the point is the health and reason labels.) In `source-service.test.ts`: after `setSourceHealth` and after `syncActiveBuilds`, the snapshot passed to `updateSourceHealthSnapshot` (spy via `vi.spyOn` on the lifecycle module, or read through an exported `currentSourceHealthSnapshot()` getter) contains the source's health with `boundUnhealthy` 1 only when the source matters.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test src/observability/prebuild-lifecycle.test.ts -t "health gauges"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`prebuild-lifecycle.ts`: add to `Instruments` `sources: ObservableGauge; sourcesBoundUnhealthy: ObservableGauge; schedulerPassAge: ObservableGauge;`, create them in `getInstruments()`:

```ts
    sources: meter.createObservableGauge("valet.prebuild.sources", { description: "Image sources by health and reason" }),
    sourcesBoundUnhealthy: meter.createObservableGauge("valet.prebuild.sources.bound_unhealthy", { description: "Unhealthy image sources that a recent session depends on" }),
    schedulerPassAge: meter.createObservableGauge("valet.prebuild.scheduler.last_pass_age", { unit: "s", description: "Age of the last completed bake scheduler pass" }),
```

with callbacks:

```ts
  created.sources.addCallback((result) => {
    for (const s of healthSnapshots) result.observe(s.count, { ...boundedPrebuildAttributes({ sourceKind: s.sourceKind, profile: null, provider: null }), health: s.health, reason: s.reason });
  });
  created.sourcesBoundUnhealthy.addCallback((result) => {
    const byKind = new Map<string, number>();
    for (const s of healthSnapshots) byKind.set(s.sourceKind, (byKind.get(s.sourceKind) ?? 0) + s.boundUnhealthy);
    for (const [sourceKind, n] of byKind) result.observe(n, boundedPrebuildAttributes({ sourceKind, profile: null, provider: null }));
  });
  created.schedulerPassAge.addCallback((result) => {
    if (schedulerPassAt !== undefined) result.observe(Math.max(0, (Date.now() - schedulerPassAt) / 1000));
  });
```

and

```ts
export interface SourceHealthSnapshot { sourceKind: string; health: SourceHealth; reason: SourceHealthReason; count: number; boundUnhealthy: number }
let healthSnapshots: SourceHealthSnapshot[] = [];
export function updateSourceHealthSnapshot(next: SourceHealthSnapshot[]): void { healthSnapshots = [...next]; getInstruments(); }
export function currentSourceHealthSnapshot(): SourceHealthSnapshot[] { return healthSnapshots; }
```

Health and reason are closed unions from `@valet/shared`, so they are bounded labels. `source-service.ts`: a private `refreshSourceHealthSnapshot()` selecting all sources, grouping by `(kind, health, reason)`, counting, and counting `boundUnhealthy` as those in `incompatible|failing|unbaked` for which `sourceMatters` is true (batch the "matters" predicate: load repo sources' `lastBoundAt` once and base children once rather than per-source queries); called from `refreshObservabilitySnapshot` and after each transition write in `setSourceHealth`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/api test src/observability src/bakes/source-service.test.ts` and typecheck.
Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `feat(api): gauges for image source health, bound unhealthy sources, and scheduler pass age` with `Changelog: internal`.

---

### Task 6: Sources page health, guidance, and deep link

**Files:**
- Modify: `packages/web/src/components/settings/sources-section.tsx` (`repoStatus` ~300, `RepoSourceRow` ~310-432, `BaseImageCard` ~162, sort options), `packages/web/src/routes/settings.organization.sandbox-images.tsx` (search schema)
- Create: `packages/web/src/components/settings/source-health.ts` (re-export from `@valet/shared` plus the web-only tone map)
- Test: `packages/web/src/components/settings/sources-section.test.tsx`, `packages/web/src/routes/-settings.organization.sandbox-images.test.tsx`

**Interfaces:**
- Consumes: `SourceSummary.health/healthReason/healthDetail/healthCheckedAt`, `BakeSummary.contractVersion/contractSource/parentBakeId` (Task 1); `sourceHealthPhrase`, `sourceHealthGuidance` (Task 3).
- Produces: `export const HEALTH_TONE: Record<SourceHealth, "success" | "current" | "warning" | "danger" | "neutral">` and `export const HEALTH_ORDER: Record<SourceHealth, number>` in `source-health.ts`; route search schema `{ source?: string }`; `RepoSourceRow` accepts `initiallyExpanded?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `sources-section.test.tsx` (extend `makeSource` defaults with `health: "healthy", healthReason: "ok", healthDetail: null, healthCheckedAt: 1000` and `makeBake` with `contractVersion: 3, contractSource: "label", parentBakeId: null`):

```tsx
  it("renders the health phrase and guidance per source", () => {
    sourcesData = { builderAvailable: true, sources: [
      makeSource({ id: "s-ok", repoFullName: "acme/ok", latestBake: { status: "pushed", createdAt: Date.now() - 2 * 3600_000 } }),
      makeSource({ id: "s-fail", repoFullName: "acme/fail", health: "failing", healthReason: "repo_unreachable", healthDetail: "GitHub API /repos/acme/fail responded 404" }),
      makeSource({ id: "s-old", repoFullName: "acme/old", health: "incompatible", healthReason: "contract" }),
      makeSource({ id: "s-new", repoFullName: "acme/new", health: "unbaked", latestBake: null }),
      makeSource({ id: "s-stale", repoFullName: "acme/stale", health: "stale" }),
    ] };
    render(<SourcesSection />);
    expect(screen.getByText("Healthy, built 2h ago")).toBeInTheDocument();
    expect(screen.getByText("Failing: The Valet GitHub app lost access. Reinstall it on this repository.")).toBeInTheDocument();
    expect(screen.getByText("Unusable: image predates the current runtime")).toBeInTheDocument();
    expect(screen.getByText("Not built yet")).toBeInTheDocument();
    expect(screen.getByText("Rebuilding")).toBeInTheDocument();
  });

  it("status sort orders failing, incompatible, unbaked, stale, healthy, disabled", async () => {
    sourcesData = { builderAvailable: true, sources: [
      makeSource({ id: "a", repoFullName: "a/healthy" }),
      makeSource({ id: "b", repoFullName: "b/disabled", enabled: false }),
      makeSource({ id: "c", repoFullName: "c/stale", health: "stale" }),
      makeSource({ id: "d", repoFullName: "d/unbaked", health: "unbaked" }),
      makeSource({ id: "e", repoFullName: "e/incompatible", health: "incompatible", healthReason: "contract" }),
      makeSource({ id: "f", repoFullName: "f/failing", health: "failing", healthReason: "bake_failed" }),
    ] };
    render(<SourcesSection />);
    await userEvent.selectOptions(screen.getByLabelText(/Sort/), "status");
    const names = screen.getAllByText(/^[a-f]\//).map((n) => n.textContent);
    expect(names).toEqual(["f/failing", "e/incompatible", "d/unbaked", "c/stale", "a/healthy", "b/disabled"]);
  });

  it("expanded row shows contract, parent bake, since, and detail", async () => {
    sourcesData = { builderAvailable: true, sources: [makeSource({ id: "s1", health: "failing", healthReason: "bake_failed", healthDetail: "npm ci exploded", healthCheckedAt: Date.now() - 3600_000 })] };
    bakesData = { bakes: [makeBake({ contractVersion: 3, contractSource: "label", parentBakeId: "base-1", commitSha: "abcdef1234567" })] };
    render(<SourcesSection />);
    await userEvent.click(screen.getByRole("button", { name: "Details for acme/widgets" }));
    expect(screen.getByText(/Contract 3 \(label\)/)).toBeInTheDocument();
    expect(screen.getByText(/Parent bake base-1/)).toBeInTheDocument();
    expect(screen.getByText(/Failing since 1h ago/)).toBeInTheDocument();
    expect(screen.getByText("npm ci exploded")).toBeInTheDocument();
  });

  it("expands the row named by initiallyExpandedId and ignores an unknown id (Review Focus 3)", () => {
    sourcesData = { builderAvailable: true, sources: [makeSource({ id: "s1" })] };
    const { unmount } = render(<SourcesSection initiallyExpandedId="s1" />);
    expect(screen.getByRole("button", { name: "Details for acme/widgets" })).toHaveAttribute("aria-expanded", "true");
    unmount();
    render(<SourcesSection initiallyExpandedId="nope" />);
    expect(screen.getByRole("button", { name: "Details for acme/widgets" })).toHaveAttribute("aria-expanded", "false");
  });
```

Route test (`-settings.organization.sandbox-images.test.tsx`): rendering the page with `?source=s1` passes `initiallyExpandedId="s1"` to `SourcesSection` (mock the section and assert its props, the way the file already mocks children if it does; else render and assert `aria-expanded`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/web test src/components/settings/sources-section.test.tsx src/routes/-settings.organization.sandbox-images.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`source-health.ts` (web):

```ts
export { SOURCE_HEALTH_GUIDANCE, sourceHealthGuidance, sourceHealthPhrase, type SourceHealth, type SourceHealthReason } from "@valet/shared";
import type { SourceHealth } from "@valet/shared";
export const HEALTH_TONE: Record<SourceHealth, "success" | "current" | "warning" | "danger" | "neutral"> = {
  healthy: "success", stale: "current", incompatible: "warning", failing: "danger", unbaked: "neutral",
};
export const HEALTH_ORDER: Record<SourceHealth, number> = { failing: 0, incompatible: 1, unbaked: 2, stale: 3, healthy: 4 };
```

`sources-section.tsx`: replace `repoStatus` with

```ts
function repoStatus(source: SourceSummary, now = Date.now()) {
  const builtAt = source.latestBake?.status === "pushed" ? source.latestBake.createdAt : null;
  return {
    label: sourceHealthPhrase(source.health, source.healthReason, builtAt, now, relativeTime),
    tone: HEALTH_TONE[source.health],
    order: source.enabled ? HEALTH_ORDER[source.health] : 5,
  };
}
```

and render `<StatusDot tone={status.tone} size="sm" />` with the phrase (drop the `Badge` variant mapping or map tone → variant). `SourcesSection` gains `initiallyExpandedId?: string` and passes `initiallyExpanded={source.id === initiallyExpandedId}` to `RepoSourceRow`, whose `useState(false)` becomes `useState(Boolean(initiallyExpanded))` (and `hasExpanded` likewise). The expanded panel adds, above the history table:

```tsx
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {latest && <><dt className="text-muted">Current bake</dt><dd>{shortSha(latest.commitSha ?? "")} · Contract {latest.contractVersion ?? "unknown"} ({latest.contractSource ?? "unread"}){latest.parentBakeId ? ` · Parent bake ${latest.parentBakeId}` : ""}</dd></>}
              {source.health !== "healthy" && source.healthCheckedAt && <><dt className="text-muted">Status</dt><dd>{capitalize(source.health)} since {relativeTime(source.healthCheckedAt)}</dd></>}
              {source.healthDetail && <><dt className="text-muted">Detail</dt><dd className="whitespace-pre-wrap break-all">{source.healthDetail}</dd></>}
            </dl>
```

where `latest = bakesQ.data?.bakes[0]`. Apply the same phrase and dot to `BaseImageCard`. Route: `validateSearch: (s) => ({ source: typeof s.source === "string" ? s.source : undefined })` on `createFileRoute`, and `<SourcesSection initiallyExpandedId={Route.useSearch().source} />`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/web test src/components/settings src/routes` and `pnpm --filter @valet/web typecheck`.
Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `feat(web): sources page shows image health, guidance, contract, and opens a linked source` with `Changelog: The organization sandbox images page shows each image's health with what to do about it, and notification links open the right row.`

---

### Task 7: Dashboard "Images" row

**Files:**
- Modify: `deploy/chart/valet/dashboards/valet.json`
- Test: `deploy/chart/valet/dashboards/valet.dashboard.test.ts` (create; vitest at repo root picks up `*.test.ts`; if the root config excludes `deploy/`, put the test under `packages/api/src/observability/dashboard.test.ts` and read the JSON by path)

**Interfaces:**
- Produces: a `row` panel titled "Images" after "Tools, sandbox & credentials" with four panels: "Sources by health" (`sum by (health) (valet_prebuild_sources)`), "Unhealthy sources a session depends on" (`sum(valet_prebuild_sources_bound_unhealthy)`), "Scheduler last pass age" (`valet_prebuild_scheduler_last_pass_age_seconds`, unit `s`), "Fallbacks and startup failures (per hour)" (`sum(increase(valet_sandbox_image_fallback_total[1h]))`, `sum by (kind) (increase(valet_sandbox_startup_failed_total[1h]))`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dashboard = JSON.parse(readFileSync(fileURLToPath(new URL("./valet.json", import.meta.url)), "utf8"));

describe("valet dashboard Images row", () => {
  it("has the Images row with the four PR 3 metrics and unique panel ids", () => {
    const panels = dashboard.panels as Array<{ id: number; type: string; title: string; targets?: Array<{ expr: string }> }>;
    const row = panels.find((p) => p.type === "row" && p.title === "Images");
    expect(row).toBeDefined();
    const exprs = panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr)).join("\n");
    for (const metric of ["valet_prebuild_sources", "valet_prebuild_sources_bound_unhealthy", "valet_prebuild_scheduler_last_pass_age_seconds", "valet_sandbox_image_fallback_total", "valet_sandbox_startup_failed_total"]) {
      expect(exprs).toContain(metric);
    }
    const ids = panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test deploy/chart/valet/dashboards/valet.dashboard.test.ts` (or the api path).
Expected: FAIL (no Images row).

- [ ] **Step 3: Add the row**

Insert after the "Tools, sandbox & credentials" row's three panels (gridPos y 31 onward shift by 9): a row panel `{ "type": "row", "title": "Images", "collapsed": false, "gridPos": { "x": 0, "y": 31, "w": 24, "h": 1 }, "panels": [] }` and four `timeseries`/`stat` panels at y 32 (w 6 each) copying the datasource, fieldConfig, and options shape of the "Sandbox exec p95 / provision avg" panel; renumber `gridPos.y` of every later panel by +9 and give new panels ids above the current max. Keep the file's two-space indentation.

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `feat(chart): Images row on the Valet dashboard` with `Changelog: internal`.

---

### Task 8: Whole-branch verification and PR

- [ ] Run: `pnpm typecheck`; `pnpm --filter @valet/shared test`; `pnpm --filter @valet/api test src/bakes src/prebuilds src/routes/sources.test.ts src/routes/sessions.test.ts src/routes/notifications.test.ts src/orchestrator src/observability`; `pnpm --filter @valet/web test`; the changelog guard over the branch range.
- [ ] `git diff --stat <pr2-head>..HEAD` touches `packages/shared`, `packages/api`, `packages/web`, `deploy/chart/valet/dashboards/valet.json`; nothing under `packages/api/src/schema` or `migrations`.
- [ ] Push and open the PR against `conner/image-pipeline-health-pr2` with a linted body (≤300 words, `## Validation`), title "Sandbox images: admin notifications, health on the sources page, session banner (image pipeline health, PR 3 of 4)". Deployment note: the first scheduler pass after deploy may notify org admins about every bound source that is currently unhealthy (one notification per source), which is the intended catch-up.

---

## Self-review notes

- Spec 14 item 3 mapped: wire fields (Task 1); sources page health, guidance, deep link (Task 6); session banner and image label (Tasks 1, 4); `platform` kind, org-owner fanout, DM gate, dedupe and recovery (Tasks 2, 3); sources gauges and scheduler age gauge (Task 5); dashboard row (Task 7).
- Names across tasks: `SessionSandboxImage`, `ImageFallback` (wire), `SOURCE_HEALTH_GUIDANCE`, `sourceHealthGuidance`, `sourceHealthPhrase`, `HEALTH_TONE`, `HEALTH_ORDER`, `updateSourceHealthSnapshot`, `SourceHealthSnapshot`, `currentSourceHealthSnapshot`, `sourceMatters`, `notifyHealthTransition`, `ImageFallbackBanner`, `initiallyExpandedId`.
- Review Focus: 1 → Task 3 flap test; 2 → Task 2 web-off test; 3 → Task 6 unknown-id test; 4 → Task 1 deleted-bake test; 5 → Task 5 empty-snapshot assertion.
- Spec amendments when this PR merges: 11.1 episode key via transition-time `health_checked_at`; 11.1 bound-scoped notifications; 11.2 table location in `@valet/shared`; 7.4 `sandboxImage` wire shape.
