# Catalog-Declared Subscription Scope Gate (TKAI-302) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the TKAI-299 subscription write gate so `slack.message` subscriptions require channel scoping (or the explicit any-channel opt-out), and move the scoping rules from hardcoded keys onto declarative `scope` fields on `EventCatalogEntry`.

**Architecture:** TKAI-299 (branch `conner/tkai-299-scope-slack-mention-subscriptions-to-the-user-and-selected`, unmerged, based on `dev-v2`) built one write gate (`validateSubscriptionWrite`) that hardcodes `slack.app_mention`. This change renames `mention-scope.ts` to `subscription-scope.ts` and drives it from two new optional catalog declarations: `scope.channelField` (channel scoping required) and `scope.creatorUserField` (filter pinned to the creator's linked identity). `slack.app_mention` declares both; `slack.message` declares only `channelField` — no user pinning, because channel watchers must see everyone's messages. The catalog wire ships `scope` to the web, so the trigger dialog, wizard, and subscriptions panel derive their checkboxes and copy from the same declaration and cannot drift from the server.

**Policy decisions (from TKAI-302 discussion):**
- `slack.message` requires channel scope (`eq` / non-empty `in` on `channel`) OR the explicit `anyChannel` flag. No creator-user injection.
- A text filter does NOT satisfy the gate. It is the encouraged companion to any-channel (a UI hint), never a substitute for the explicit opt-out.
- No match-time fail-closed arm for channel scope: a stored row with no channel filter is indistinguishable from the legitimate any-channel state, so pre-gate `slack.message` rows are grandfathered. The creator-pinning arm (mention) stays and becomes catalog-driven.
- `anyChannel` stays unpersisted (same model as TKAI-299): a stored scope-required subscription with no channel filter IS the any-channel state.
- `slack.reaction_*` and `file_shared` stay unscoped in this change. The mechanism makes adding them a one-line catalog edit later.

**Tech Stack:** TypeScript monorepo (pnpm), Hono API, vitest, React 19 web.

**Spec:** `docs/specs/2026-08-28-slack-event-triggers-design.md` (exists on the TKAI-299 branch; Task 3 updates it in the same commit as the gate change). Linear: TKAI-302, TKAI-299.

## Global Constraints

- Base branch: `conner/tkai-299-scope-slack-mention-subscriptions-to-the-user-and-selected` (the code being modified only exists there). Work branch: `conner/tkai-302-decide-scoping-policy-for-slackmessage-subscriptions`. The PR stacks onto the 299 branch, NOT `dev-v2` and NOT `main` (`main` is frozen legacy).
- Before any `git push` / `git fetch` over SSH, run `say "yubikey"` first so Conner can tap the key. Not needed for `gh` CLI.
- No `any`, no `as unknown as T`, no `@ts-ignore`. Build full shapes in tests.
- All prose (comments, spec, PR text, UI copy, error messages) follows ASD-STE100 per CLAUDE.md. Every user-facing error names the corrective action.
- Preserve TKAI-299's existing error strings verbatim where a test asserts a substring of them; run the mention describe block after every gate edit.
- Commit subjects ≤72 chars. Do NOT add Co-Authored-By trailers.
- PR description: ≤300 words, no em/en dashes, no marketing words, filled Validation section (CI lints it).
- `pnpm --filter @valet/api test <filter>` — never put `--` before the filter (vitest drops it and runs everything).
- Do not export `ANTHROPIC_API_KEY` into test runs; `make e2e` is the authoritative scorecard.

---

### Task 1: Worktree, branch, and plan commit

**Files:**
- Create: worktree at `/Users/conner/code/valet/.claude/worktrees/tkai-302-subscription-scope`
- Create: `docs/plans/2026-09-01-subscription-scope-gate.md` (this file, copied in)

**Interfaces:**
- Produces: the working directory every later task runs in. All later file paths are relative to this worktree root.

- [ ] **Step 1: Create the worktree and branch off the 299 branch**

```bash
cd /Users/conner/code/valet
git worktree add .claude/worktrees/tkai-302-subscription-scope \
  -b conner/tkai-302-decide-scoping-policy-for-slackmessage-subscriptions \
  conner/tkai-299-scope-slack-mention-subscriptions-to-the-user-and-selected
cd .claude/worktrees/tkai-302-subscription-scope
pnpm install
```

- [ ] **Step 2: Verify the 299 gate files exist here**

Run: `ls packages/api/src/events/mention-scope.ts packages/api/src/events/subscription-write.ts`
Expected: both paths print. If not, the branch base is wrong — stop and fix before proceeding.

- [ ] **Step 3: Copy this plan in and commit**

```bash
cp /Users/conner/code/valet/.claude/worktrees/tkai-300-slack-forwards/docs/plans/2026-09-01-subscription-scope-gate.md docs/plans/
git add docs/plans/2026-09-01-subscription-scope-gate.md
git commit -m "docs: plan for catalog-declared subscription scope gate (TKAI-302)"
```

- [ ] **Step 4: Baseline check**

Run: `pnpm typecheck && pnpm --filter @valet/api test events.test`
Expected: clean. This is the baseline every later task must preserve.

---

### Task 2: Catalog `scope` declaration (engine type + slack plugin + wire mirror)

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts` (interface `EventCatalogEntry`, ~line 115)
- Modify: `packages/plugin-slack/src/triggers.ts` (the `slack.app_mention` and `slack.message` catalog entries inside `triggerSpecs`)
- Modify: `packages/api/src/wire/types.ts` (interface `EventCatalogEntryWire`, ~line 3707)
- Test: `packages/api/src/routes/events.test.ts` (the existing `GET /api/events/catalog` test area)

**Interfaces:**
- Produces: `EventCatalogEntry.scope?: { channelField?: string; creatorUserField?: string }` — consumed by Tasks 3, 4 (api) and 5, 6 (web, via the wire mirror).

- [ ] **Step 1: Write the failing test**

In `packages/api/src/routes/events.test.ts`, find the existing catalog test (search `events/catalog`). Add a test beside it, booting with the slack plugin (mirror the `mention scoping` describe's boot):

```ts
it("catalog ships scope declarations for the scoped slack keys", async () => {
  const a = await bootTestApi({ plugins: [slackPlugin] });
  api = a;
  const res = await fetch(`${a.baseUrl}/api/events/catalog`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as GetEventCatalogResponse;
  const slack = body.services.find((s) => s.service === "slack");
  const entries = slack?.entries ?? [];
  const mention = entries.find((e) => e.key === "slack.app_mention");
  const message = entries.find((e) => e.key === "slack.message");
  expect(mention?.scope).toEqual({ channelField: "channel", creatorUserField: "user" });
  expect(message?.scope).toEqual({ channelField: "channel" });
  const archive = entries.find((e) => e.key === "slack.channel_archive");
  expect(archive?.scope).toBeUndefined();
});
```

If `slack.channel_archive` is not in the catalog, substitute any slack key that is (check the `triggerSpecs` array) — the point is one unscoped control key.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @valet/api test events.test`
Expected: the new test FAILS (`scope` is undefined on mention). Type errors on `e.scope` are also an acceptable failure mode until Step 3.

- [ ] **Step 3: Add `scope` to the engine type**

In `packages/engine/src/valet-plugin.ts`, inside `EventCatalogEntry` after the `filters` array:

```ts
  /**
   * Write-time scoping the subscription gate enforces for this key
   * (`packages/api/src/events/subscription-scope.ts`). Absent, the key is
   * unscoped: any filters, including none, are accepted.
   */
  scope?: {
    /**
     * Name of the filter field that must constrain this key to a fixed set
     * of conversations (`eq`, or `in` with values). The write is refused
     * without it, unless the request sets the explicit `anyChannel` flag.
     */
    channelField?: string;
    /**
     * Name of the filter field the gate pins to the creator's linked
     * identity on the owning plugin's service. Absent from the write, the
     * gate injects it; present with another value, the write is refused.
     */
    creatorUserField?: string;
  };
```

- [ ] **Step 4: Declare scope on the two slack entries**

In `packages/plugin-slack/src/triggers.ts`, in the `slack.app_mention` catalog entry (after its `filters` array):

```ts
        scope: { channelField: "channel", creatorUserField: "user" },
```

In the `slack.message` catalog entry:

```ts
        // Channel scope only — no creator pinning. A channel watcher (a team
        // workflow on #support, an org assistant in #help) must see messages
        // from everyone, so the gate requires WHERE, not WHO (TKAI-302).
        scope: { channelField: "channel" },
```

- [ ] **Step 5: Mirror on the wire**

In `packages/api/src/wire/types.ts`, inside `EventCatalogEntryWire` after `filters`:

```ts
  /**
   * Write-time scoping the subscription gate enforces for this key — the
   * web derives its channel pickers, "Any channel" checkboxes, and copy from
   * this, so client and server cannot drift. Mirrors
   * `EventCatalogEntry.scope`.
   */
  scope?: { channelField?: string; creatorUserField?: string };
```

The catalog route (`routes/events.ts` `GET /events/catalog`) returns engine entries verbatim, so no route change is needed.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @valet/api test events.test && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/valet-plugin.ts packages/plugin-slack/src/triggers.ts \
  packages/api/src/wire/types.ts packages/api/src/routes/events.test.ts
git commit -m "feat(engine,slack): declare subscription scope on catalog entries (TKAI-302)"
```

---

### Task 3: Generalize the write gate (`subscription-scope.ts`)

**Files:**
- Rename: `packages/api/src/events/mention-scope.ts` → `packages/api/src/events/subscription-scope.ts` (git mv, then rewrite)
- Modify: `packages/api/src/events/ingest.ts` (add `allCatalogEntriesWithService`)
- Modify: `packages/api/src/events/subscription-write.ts` (imports, doc, `storedAnyChannel` plumbing unchanged)
- Modify: `packages/api/src/routes/events.ts:25,623` (import path, `storedAnyChannelState` new signature)
- Modify: `packages/api/src/workflows/trigger-service.ts:17,223` (same)
- Modify: `docs/specs/2026-08-28-slack-event-triggers-design.md` (same commit — CLAUDE.md rule)
- Test: `packages/api/src/routes/events.test.ts`

**Interfaces:**
- Consumes: `EventCatalogEntry.scope` from Task 2; existing `eventKeyMatches`, `SubscriptionFilter`, `validateRegexPattern` from `events/match.ts`; `identityForUser(db, service, userId)` from `channels/identity-links.ts`.
- Produces (all from `events/subscription-scope.ts`):
  - `enforceSubscriptionScope(db: AppDb, plugins: ValetPlugin[], creatorUserId: string, args: { eventKeys: string[]; filters: SubscriptionFilter[]; anyChannel: boolean; storedAnyChannel?: boolean }): Promise<{ ok: true; filters: SubscriptionFilter[] } | { ok: false; error: string }>`
  - `storedAnyChannelState(plugins: ValetPlugin[], eventKeys: string[], filters: SubscriptionFilter[]): boolean` — NOTE the new leading `plugins` parameter; both call sites must pass it.
  - From `events/ingest.ts`: `allCatalogEntriesWithService(plugins: ValetPlugin[]): { service: string; entry: EventCatalogEntry }[]`
- `enforceMentionScope`, `SLACK_MENTION_KEY`, and `selectsSlackMention` are DELETED. `subscription-write.ts` is their only api consumer besides the two `storedAnyChannelState` call sites.

- [ ] **Step 1: Write the failing tests**

In `packages/api/src/routes/events.test.ts`, add a describe block after the existing `mention scoping (slack.app_mention)` block. Reuse its boot and helper patterns exactly (same `bootTestApi({ plugins: [slackPlugin] })`, same `postSubscription`; check what status code the mention tests assert on success and mirror it — written as 200 below, adjust if the neighbors assert 201):

```ts
// A subscription selecting `slack.message` must name channels or set the
// explicit anyChannel flag — but is NOT pinned to its creator: channel
// watchers must see messages from everyone (TKAI-302,
// events/subscription-scope.ts).
describe("message scoping (slack.message)", () => {
  const MESSAGE_BODY: CreateEventSubscriptionRequest = {
    name: "watch support",
    eventKeys: ["slack.message"],
    filters: [],
    target: { kind: "orchestrator" },
  };

  it("refuses a channel-less slack.message subscription", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, MESSAGE_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("channel filter");
  });

  it("accepts a channel filter and injects no user filter", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, {
      ...MESSAGE_BODY,
      filters: [{ field: "channel", op: "eq", value: "C123" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateEventSubscriptionResponse;
    expect(body.filters).toEqual([{ field: "channel", op: "eq", value: "C123" }]);
  });

  it("does not require a linked Slack account", async () => {
    // No linkSlack call — a slack.message watcher is not pinned to anyone.
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, {
      ...MESSAGE_BODY,
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"] }],
    });
    expect(res.status).toBe(200);
  });

  it("anyChannel: true permits a channel-less slack.message subscription", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, { ...MESSAGE_BODY, anyChannel: true });
    expect(res.status).toBe(200);
  });

  it("refuses anyChannel alongside a channel filter", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, {
      ...MESSAGE_BODY,
      anyChannel: true,
      filters: [{ field: "channel", op: "eq", value: "C123" }],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a required channel filter on a mixed subscription with a channel-less key", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin, githubPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, {
      ...MESSAGE_BODY,
      eventKeys: ["slack.message", "github.push"],
      filters: [{ field: "channel", op: "eq", value: "C123" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("separate subscription");
  });

  it("allows the mixed subscription under anyChannel (no channel filter stored)", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin, githubPlugin] });
    api = a;
    const res = await postSubscription(a.baseUrl, {
      ...MESSAGE_BODY,
      eventKeys: ["slack.message", "github.push"],
      anyChannel: true,
    });
    expect(res.status).toBe(200);
  });

  it("a patch that leaves channel scope alone keeps the any-channel state", async () => {
    const a = await bootTestApi({ plugins: [slackPlugin] });
    api = a;
    const created = await postSubscription(a.baseUrl, { ...MESSAGE_BODY, anyChannel: true });
    expect(created.status).toBe(200);
    const row = (await created.json()) as CreateEventSubscriptionResponse;
    const patch = await fetch(`${a.baseUrl}/api/event-subscriptions/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: [{ field: "text", op: "prefix", value: "!deploy" }] }),
    });
    expect(patch.status).toBe(200);
  });
});
```

Also update the existing test `leaves non-mention slack subscriptions unscoped` (~line 1545): it uses `slack.message` as the unscoped control, which this change gates. Switch its event key to an unscoped slack key (`slack.channel_archive`, or whatever Task 2's control key was) and keep its assertion.

Check the PATCH verb the routes actually use (`PATCH` vs `PUT`) by looking at the existing patch tests in this file, and mirror them.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @valet/api test events.test`
Expected: every new `message scoping` test FAILS (unscoped create currently succeeds, so the refusal tests fail; the acceptance tests may pass — that is fine, the refusals are the signal). The mention block must still pass.

- [ ] **Step 3: Add the service-aware catalog helper**

In `packages/api/src/events/ingest.ts`, after `allCatalogEntries`:

```ts
/** The merged catalog with each entry's owning service — the scope gate
 * needs the service to resolve the creator's linked identity
 * (`identityForUser`). */
export function allCatalogEntriesWithService(
  plugins: ValetPlugin[],
): { service: string; entry: EventCatalogEntry }[] {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .flatMap((t) => t.catalog.map((entry) => ({ service: t.service, entry })));
}
```

- [ ] **Step 4: Rename and rewrite the gate**

```bash
git mv packages/api/src/events/mention-scope.ts packages/api/src/events/subscription-scope.ts
```

Replace the file's contents with the generalized gate. Preserve TKAI-299's error strings verbatim in the pinned (mention) paths; the mention describe block asserts substrings of them.

```ts
/**
 * Write-time scope enforcement for event subscriptions (TKAI-299, TKAI-302).
 *
 * A catalog entry opts into scoping through `EventCatalogEntry.scope`:
 *
 * 1. **Creator pinning** (`creatorUserField` — `slack.app_mention`). The
 *    filters must carry a filter on that field equal to the creator's linked
 *    identity on the owning plugin's service. Absent, the server injects it;
 *    present with any other value, the write is refused. A pinned key cannot
 *    share a subscription with any other key: the injected filter applies to
 *    every selected key and would silently narrow or kill the others.
 * 2. **Channel scope** (`channelField` — `slack.app_mention`,
 *    `slack.message`). The filters must constrain that field to a non-empty
 *    fixed set (`eq`, or `in` with values), unless the request sets the
 *    explicit `anyChannel` flag. `anyChannel` is not persisted: a stored
 *    scope-required subscription with no channel filter IS the any-channel
 *    state. When the channel filter is required and stored, every selected
 *    key must declare the field, or the filter would silently kill the keys
 *    that do not — the gate refuses the mix instead.
 *
 * Every writer reaches this through `validateSubscriptionWrite`
 * (`events/subscription-write.ts`), the one gate in front of every
 * `event_subscriptions` write. The matcher carries one arm of the pinning
 * rule: `subscriptionMatchesEvent` fails closed on a pinned key with no
 * filter on the pinned field, so a row from before the gate cannot keep
 * firing unscoped. Channel scope has NO match-time arm: a stored row with no
 * channel filter is indistinguishable from the legitimate any-channel state,
 * so rows from before this gate keep firing (accepted pre-1.0; revisit with
 * a persisted flag if that ever pages someone).
 */
import type { EventCatalogEntry, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { identityForUser } from "../channels/identity-links.js";
import { allCatalogEntriesWithService } from "./ingest.js";
import { eventKeyMatches, type SubscriptionFilter } from "./match.js";

interface Selection {
  service: string;
  entry: EventCatalogEntry;
}

/** Catalog entries the eventKeys patterns select, with their owning service. */
function selections(plugins: ValetPlugin[], eventKeys: string[]): Selection[] {
  return allCatalogEntriesWithService(plugins).filter((s) => eventKeyMatches(s.entry.key, eventKeys));
}

/** The channel fields the selected entries require scoping on. */
function channelFieldsOf(sel: Selection[]): Set<string> {
  const fields = new Set<string>();
  for (const s of sel) {
    const f = s.entry.scope?.channelField;
    if (f !== undefined) fields.add(f);
  }
  return fields;
}

/** True when the filter constrains a required channel field to a non-empty
 * fixed set. `prefix`, `contains` and `regex` do not count: "starts with C"
 * is the whole workspace. An empty `in` list does not count either — it
 * matches nothing, which is not a channel selection. */
function isChannelScopeFilter(f: SubscriptionFilter, fields: Set<string>): boolean {
  if (!fields.has(f.field)) return false;
  if (f.op === "eq") return true;
  return f.op === "in" && Array.isArray(f.value) && f.value.length > 0;
}

function isCreatorFilter(f: SubscriptionFilter, field: string, externalId: string): boolean {
  if (f.field !== field) return false;
  if (f.op === "eq") return f.value === externalId;
  if (f.op === "in") return Array.isArray(f.value) && f.value.length === 1 && f.value[0] === externalId;
  return false;
}

/**
 * Whether a STORED subscription is in the any-channel state: it selects at
 * least one channel-scoped key and carries no channel-scope filter. The
 * `anyChannel` request flag is deliberately not persisted, so this derivation
 * is the stored state. The PATCH paths feed it back as `storedAnyChannel` so
 * an edit that does not touch channel scope is not refused for lacking a
 * flag the server never stored.
 */
export function storedAnyChannelState(
  plugins: ValetPlugin[],
  eventKeys: string[],
  filters: SubscriptionFilter[],
): boolean {
  const fields = channelFieldsOf(selections(plugins, eventKeys));
  return fields.size > 0 && !filters.some((f) => isChannelScopeFilter(f, fields));
}

export type ScopeResult = { ok: true; filters: SubscriptionFilter[] } | { ok: false; error: string };

/**
 * Applies the scope rules above. Returns the filters to store — the input
 * filters, plus the injected creator filter when a pinned key required one —
 * or a human-readable refusal that names the corrective action.
 *
 * `creatorUserId` is the subscription's creator (`created_by`), not the
 * caller: an org-owned pinned subscription patched by a colleague stays
 * scoped to the user who armed it.
 *
 * `storedAnyChannel` (PATCH paths only) carries the row's derived
 * any-channel state, so a patch that leaves channel scope alone passes
 * without the caller re-asserting the flag. The explicit `anyChannel` flag
 * alone trips the contradiction check, so a stored any-channel row can still
 * be narrowed to named channels by just sending channel filters.
 *
 * Unscoped subscriptions pass through unchanged; `anyChannel` has no meaning
 * for them and is ignored.
 */
export async function enforceSubscriptionScope(
  db: AppDb,
  plugins: ValetPlugin[],
  creatorUserId: string,
  args: {
    eventKeys: string[];
    filters: SubscriptionFilter[];
    anyChannel: boolean;
    storedAnyChannel?: boolean;
  },
): Promise<ScopeResult> {
  const sel = selections(plugins, args.eventKeys);
  const pinned = sel.filter((s) => s.entry.scope?.creatorUserField !== undefined);
  const channelFields = channelFieldsOf(sel);
  if (pinned.length === 0 && channelFields.size === 0) return { ok: true, filters: args.filters };

  // A pinned key stands alone: the injected creator filter applies to EVERY
  // event the subscription matches (filters are per-subscription, not
  // per-key), so a second key would be silently narrowed to the creator's
  // own events — or, for a key with no such field, never match again.
  // Refuse the mix instead of storing either surprise.
  if (pinned.length > 0) {
    const other = sel.find((s) => s.entry.key !== pinned[0].entry.key);
    if (other !== undefined) {
      return {
        ok: false,
        error:
          `A mention subscription is scoped to your own @-mentions, so it cannot also subscribe ` +
          `to ${other.entry.key}. Create a separate subscription for ${other.entry.key}.`,
      };
    }
  }

  // An empty `in` list matches nothing, ever — refuse it rather than store a
  // dead filter the UI would have to explain.
  if (
    args.filters.some(
      (f) => channelFields.has(f.field) && f.op === "in" && Array.isArray(f.value) && f.value.length === 0,
    )
  ) {
    return {
      ok: false,
      error: "A channel filter has an empty list. Add channels to it, or remove the filter.",
    };
  }

  const hasChannelScope = args.filters.some((f) => isChannelScopeFilter(f, channelFields));
  if (args.anyChannel && hasChannelScope) {
    return {
      ok: false,
      error: `"Any channel" removes the channel restriction. Remove the channel filters, or turn "Any channel" off.`,
    };
  }
  if (channelFields.size > 0 && !args.anyChannel && !hasChannelScope && args.storedAnyChannel !== true) {
    const noun = pinned.length > 0 ? "A mention subscription" : "This subscription";
    return {
      ok: false,
      error:
        `${noun} needs at least one channel filter (equals, or is one of). ` +
        'Select channels, or choose "Any channel" to listen in every channel the app can see.',
    };
  }

  // A stored channel filter applies to every selected key. A selected key
  // with no channel field would silently never match again — refuse the mix.
  // Under anyChannel no filter is stored, so the mix is harmless.
  if (hasChannelScope) {
    const unscopable = sel.find((s) => s.entry.scope?.channelField === undefined);
    if (unscopable !== undefined) {
      return {
        ok: false,
        error:
          `A channel filter applies to every event in a subscription, and ${unscopable.entry.key} ` +
          `has no channel field, so it would never fire. Create a separate subscription for ` +
          `${unscopable.entry.key}.`,
      };
    }
  }

  if (pinned.length === 0) return { ok: true, filters: args.filters };

  const { service, entry } = pinned[0];
  // Non-null: `pinned` filtered on exactly this field being defined.
  const pinField = entry.scope!.creatorUserField!;
  const identity = await identityForUser(db, service, creatorUserId);
  if (!identity) {
    return {
      ok: false,
      error:
        "A mention subscription fires only for its creator's own @-mentions, so the creator must link " +
        "their Slack account in Settings → Connected accounts first.",
    };
  }

  const pinFilters = args.filters.filter((f) => f.field === pinField);
  if (pinFilters.length === 0) {
    return {
      ok: true,
      filters: [...args.filters, { field: pinField, op: "eq", value: identity.externalId }],
    };
  }
  if (pinFilters.every((f) => isCreatorFilter(f, pinField, identity.externalId))) {
    return { ok: true, filters: args.filters };
  }
  return {
    ok: false,
    error:
      "A mention subscription fires only for the creator's own @-mentions. " +
      "Remove the user filter, or set it to the creator's linked Slack user.",
  };
}
```

Note on the `!` non-null assertions: they narrow a field the `pinned` filter just checked; keep the comment. If the reviewer objects, restructure `pinned` to carry the field: `sel.flatMap((s) => { const f = s.entry.scope?.creatorUserField; return f === undefined ? [] : [{ ...s, pinField: f }]; })`.

- [ ] **Step 5: Update `subscription-write.ts`**

- Change the import: `import { enforceSubscriptionScope } from "./subscription-scope.js";`
- Change the final call from `enforceMentionScope(...)` to `enforceSubscriptionScope(...)` (same arguments).
- Update the file's doc comment: replace "applies the mention-scope rules (TKAI-299, `mention-scope.ts`)" with "applies the catalog-declared scope rules (TKAI-299/TKAI-302, `subscription-scope.ts`)".
- In `SubscriptionWriteScope`'s `matchChanged` doc, replace "skips the mention gate" with "skips the scope gate".

- [ ] **Step 6: Update the two `storedAnyChannelState` call sites**

In `packages/api/src/routes/events.ts` (~line 25 import, ~line 623 call) and `packages/api/src/workflows/trigger-service.ts` (~line 17 import, ~line 223 call):

- Import from `../events/subscription-scope.js` (adjust relative path per file).
- Add `plugins` as the new first argument. Both files already hold the plugin list in scope for `validateSubscriptionWrite` — pass the same variable.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @valet/api test events.test && pnpm --filter @valet/api test workflow-triggers && pnpm typecheck`
Expected: all PASS — the new `message scoping` block, the untouched `mention scoping` block, and the trigger route tests. If a mention test fails on an error-string assertion, fix the string in `subscription-scope.ts` to match 299's original, never the test.

- [ ] **Step 8: Update the spec (same commit)**

In `docs/specs/2026-08-28-slack-event-triggers-design.md`, find the TKAI-299 scoping section and update it:

- Rename references from `mention-scope.ts` to `subscription-scope.ts`.
- Document the catalog declaration: entries opt into the gate through `scope.channelField` / `scope.creatorUserField`; `slack.app_mention` declares both, `slack.message` declares `channelField` only.
- State the policy: a `slack.message` subscription needs channel scope or the explicit any-channel opt-out; no creator pinning, because channel watchers must see messages from everyone.
- State the two deliberate gaps: text filters do not satisfy the gate (they are the encouraged companion to any-channel, surfaced as a UI hint); channel scope has no match-time arm, so pre-gate rows are grandfathered (pinning keeps its match-time arm).

Follow STE: short sentences, condition before action, one name per thing.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): catalog-driven scope gate; require channel scope on slack.message (TKAI-302)"
```

---

### Task 4: Generalize the match-time fail-closed arm

**Files:**
- Modify: `packages/api/src/events/match.ts` (`subscriptionMatchesEvent`, ~line 109)
- Test: `packages/api/src/events/match.test.ts`

**Interfaces:**
- Consumes: `EventCatalogEntry.scope.creatorUserField` from Task 2; `subscriptionMatchesEvent(sub, eventKey, payload, catalog)` keeps its exact signature — `catalog` already arrives as the arriving event's service catalog.
- Produces: no signature changes. Behavior: the hardcoded `slack.app_mention` check becomes catalog-driven.

- [ ] **Step 1: Write the failing test**

In `packages/api/src/events/match.test.ts`, mirror the file's existing fixture style (read the top of the file first; it builds `EventCatalogEntry[]` literals and subscription-row shapes). Add:

```ts
describe("catalog-driven pinning arm", () => {
  const catalog: EventCatalogEntry[] = [
    {
      key: "svc.pinned",
      description: "a creator-pinned key",
      filters: [{ field: "user", path: "user", description: "sender" }],
      scope: { channelField: "channel", creatorUserField: "user" },
    },
    {
      key: "svc.open",
      description: "a channel-scoped but unpinned key",
      filters: [{ field: "channel", path: "channel", description: "room" }],
      scope: { channelField: "channel" },
    },
  ];

  it("fails closed on a pinned key with no filter on the pinned field", () => {
    const sub = { eventKeys: ["svc.pinned"], filters: [] };
    expect(subscriptionMatchesEvent(sub, "svc.pinned", { user: "U1" }, catalog)).toBe(false);
  });

  it("matches a pinned key when the pinned-field filter is present", () => {
    const sub = { eventKeys: ["svc.pinned"], filters: [{ field: "user", op: "eq", value: "U1" }] };
    expect(subscriptionMatchesEvent(sub, "svc.pinned", { user: "U1" }, catalog)).toBe(true);
  });

  it("does not fail closed on a channel-scoped, unpinned key with no filters", () => {
    // Grandfathering: channel scope has no match-time arm (see
    // events/subscription-scope.ts module doc).
    const sub = { eventKeys: ["svc.open"], filters: [] };
    expect(subscriptionMatchesEvent(sub, "svc.open", { channel: "C1" }, catalog)).toBe(true);
  });
});
```

Adapt the `sub` literal to whatever row shape `subscriptionMatchesEvent` actually takes in the existing tests (it reads `sub.eventKeys` and `sub.filters` through casts) — build the full shape the existing tests build, no `as unknown as`.

- [ ] **Step 2: Run the test to verify the first one fails**

Run: `pnpm --filter @valet/api test match.test`
Expected: `fails closed on a pinned key` FAILS (the current arm only knows `slack.app_mention`). The other two pass.

- [ ] **Step 3: Replace the hardcoded arm**

In `subscriptionMatchesEvent`, replace the `slack.app_mention` block with:

```ts
  // The match-time arm of the creator-pinning rule (events/subscription-scope.ts,
  // TKAI-299/TKAI-302). A subscription on a pinned key with no filter on the
  // pinned field predates the write-time gate and would fire for EVERY
  // user's events. It fails closed here — the miss is drop-logged as
  // `filter_excluded`, so the owner sees the rule stopped matching, edits
  // it, and the write gate scopes it. Channel scope has no such arm: a row
  // with no channel filter is indistinguishable from the legitimate
  // any-channel state.
  const pinField = catalog.find((e) => e.key === eventKey)?.scope?.creatorUserField;
  if (
    pinField !== undefined &&
    !(sub.filters as SubscriptionFilter[]).some((f) => f.field === pinField)
  ) {
    return false;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @valet/api test match.test && pnpm --filter @valet/api test slack-webhook && pnpm --filter @valet/api test events.test`
Expected: PASS. `slack-webhook.test.ts` exercises the mention arm end to end on 299 — it must stay green (the slack catalog now supplies the same rule the hardcoded key did).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/events/match.ts packages/api/src/events/match.test.ts
git commit -m "feat(api): drive the match-time pinning arm from catalog scope (TKAI-302)"
```

---

### Task 5: Web scope lib + trigger dialog

**Files:**
- Rename: `packages/web/src/lib/slack-mention.ts` → `packages/web/src/lib/subscription-scope.ts` (git mv, rewrite)
- Modify: `packages/web/src/components/workflows/trigger-dialog.tsx`
- Modify: `packages/web/src/components/events/automation-wizard.tsx` (import path only, in this task)
- Modify: `packages/web/src/components/events/subscriptions-panel.tsx` (import path only, in this task)

**Interfaces:**
- Consumes: `EventCatalogEntryWire.scope` from Task 2 (the catalog the web already fetches via `useEventCatalog`).
- Produces (from `~/lib/subscription-scope`):
  - `SLACK_APP_MENTION = "slack.app_mention"` (kept — the wizard's reply outcome is mention-specific by design)
  - `selectsSlackMention(eventKeys: string[]): boolean` (kept, unchanged)
  - `hasChannelScopeFilter(filters: unknown[], fields?: ReadonlySet<string>): boolean` — same body, field set parameter defaulting to `new Set(["channel"])`
  - `interface ScopedEntry { key: string; scope?: { channelField?: string; creatorUserField?: string } }`
  - `channelScopeFields(entries: ScopedEntry[], eventKeys: string[]): Set<string>` — channel fields required by the selected entries
  - `requiresChannelScope(entries: ScopedEntry[], eventKeys: string[]): boolean` — `channelScopeFields(...).size > 0`
  - `pinnedToCreator(entries: ScopedEntry[], eventKeys: string[]): boolean` — any selected entry has `creatorUserField`
  - `storedAnyChannel(entries: ScopedEntry[], eventKeys: string[], filters: unknown[]): boolean` — moved here from trigger-dialog, generalized: `requiresChannelScope(entries, eventKeys) && !hasChannelScopeFilter(filters, channelScopeFields(entries, eventKeys))`
- Tasks 6 consumes these same exports.

- [ ] **Step 1: Rewrite the lib**

```bash
git mv packages/web/src/lib/slack-mention.ts packages/web/src/lib/subscription-scope.ts
```

New contents:

```ts
/**
 * Client-side mirror of the server's catalog-declared scope predicates
 * (packages/api/src/events/subscription-scope.ts, TKAI-299/TKAI-302). One
 * home, so the subscriptions list, the trigger dialog, and the wizard cannot
 * drift from each other — or from the server — on what counts as a scoped
 * key or as channel scope. Scope requirements ride the catalog wire
 * (`EventCatalogEntryWire.scope`); nothing here hardcodes a key except the
 * wizard's mention-specific reply outcome.
 */

export const SLACK_APP_MENTION = "slack.app_mention";

/** The subset of a catalog entry the scope predicates need. Both the wire's
 * `EventCatalogEntryWire` and the wizard's own entry shapes satisfy it. */
export interface ScopedEntry {
  key: string;
  scope?: { channelField?: string; creatorUserField?: string };
}

/** Whether one eventKeys pattern selects `key` — the exact key or a trailing
 * wildcard, mirroring the server's `eventKeyMatches`. */
function keySelected(key: string, eventKeys: string[]): boolean {
  return eventKeys.some((k) => k === key || (k.endsWith(".*") && key.startsWith(k.slice(0, -1))));
}

/** Whether the eventKeys patterns select `slack.app_mention`. The wizard's
 * reply outcome is mention-specific by design; everything else derives from
 * catalog scope. */
export function selectsSlackMention(eventKeys: string[]): boolean {
  return keySelected(SLACK_APP_MENTION, eventKeys);
}

/** The channel fields the selected entries require scoping on. */
export function channelScopeFields(entries: ScopedEntry[], eventKeys: string[]): Set<string> {
  const fields = new Set<string>();
  for (const e of entries) {
    const f = e.scope?.channelField;
    if (f !== undefined && keySelected(e.key, eventKeys)) fields.add(f);
  }
  return fields;
}

/** Whether any selected entry requires channel scope. */
export function requiresChannelScope(entries: ScopedEntry[], eventKeys: string[]): boolean {
  return channelScopeFields(entries, eventKeys).size > 0;
}

/** Whether any selected entry pins its filters to the creator's identity —
 * decides the mention-specific copy on the shared "Any channel" checkbox. */
export function pinnedToCreator(entries: ScopedEntry[], eventKeys: string[]): boolean {
  return entries.some((e) => e.scope?.creatorUserField !== undefined && keySelected(e.key, eventKeys));
}

const DEFAULT_CHANNEL_FIELDS: ReadonlySet<string> = new Set(["channel"]);

/** Whether the filters constrain a channel field to a non-empty fixed set —
 * op `eq`, or op `in` with at least one value. Accepts the loose `unknown[]`
 * the wire hands back. */
export function hasChannelScopeFilter(
  filters: unknown[],
  fields: ReadonlySet<string> = DEFAULT_CHANNEL_FIELDS,
): boolean {
  return filters.some((f) => {
    if (typeof f !== "object" || f === null) return false;
    // Narrows the wire's unknown filter entry; shape is owned by the server's
    // subscription validator, the only writer of these rows.
    const r = f as Record<string, unknown>;
    if (typeof r.field !== "string" || !fields.has(r.field)) return false;
    if (r.op === "eq") return true;
    return r.op === "in" && Array.isArray(r.value) && r.value.length > 0;
  });
}

/** A stored scope-required subscription with no channel-scope filter IS the
 * any-channel state (the server refuses the unscoped default and does not
 * persist the flag) — editors seed their "Any channel" checkbox from this,
 * so an edit round-trips without re-checking it. */
export function storedAnyChannel(
  entries: ScopedEntry[],
  eventKeys: string[],
  filters: unknown[],
): boolean {
  const fields = channelScopeFields(entries, eventKeys);
  return fields.size > 0 && !hasChannelScopeFilter(filters, fields);
}
```

- [ ] **Step 2: Fix the three import sites**

Update imports in `automation-wizard.tsx`, `subscriptions-panel.tsx`, and `trigger-dialog.tsx` from `~/lib/slack-mention` to `~/lib/subscription-scope`. Do not change their logic yet (Task 6 does the wizard and panel). Keep the wizard compiling: it imports `SLACK_APP_MENTION`, which still exists.

Run: `pnpm typecheck`
Expected: clean (trigger-dialog's local `storedAnyChannel` helper still exists at this point and shadows nothing — it is a module-level function; if the name collides with the new import, finish Step 3 before typechecking).

- [ ] **Step 3: Generalize the trigger dialog**

In `packages/web/src/components/workflows/trigger-dialog.tsx`:

1. Delete the local `storedAnyChannel` helper (the lib now owns it) and import `{ hasChannelScopeFilter, channelScopeFields, pinnedToCreator, requiresChannelScope, storedAnyChannel }` from `~/lib/subscription-scope`. Remove the now-unused `selectsSlackMention` / `SLACK_APP_MENTION` imports.
2. The dialog already resolves `selectedEntry` from the catalog. Everywhere it tested `eventKey === SLACK_APP_MENTION` or `selectedEntry.key === SLACK_APP_MENTION`, test `selectedEntry?.scope?.channelField !== undefined` instead (equivalently `requiresChannelScope([selectedEntry], [eventKey])` where only the key string is at hand — the dialog is single-event, so pass the catalog entries list it already has). Sites, from the 299 diff: the edit-seed effect (`setAnyChannel(storedAnyChannel(...))` — new signature: `storedAnyChannel(entries, editing.detail.eventKeys, editing.detail.filters)` where `entries` is the flattened catalog), the pre-submit validation, the `anyChannel` ride-along on update, the create body spread, and the checkbox render condition.
3. Pre-submit validation message becomes scope-aware. Replace the mention-specific string with:

```ts
        const scoped = selectedEntry !== undefined && selectedEntry.scope?.channelField !== undefined;
        if (scoped && !anyChannel && !hasChannelScopeFilter(filters, channelScopeFields([selectedEntry], [eventKey]))) {
          setFormError(
            'This event needs a channel filter (equals, or is one of). Add one, or check "Any channel".',
          );
          return;
        }
```

4. Checkbox copy splits on pinning. Where the checkbox renders (`selectedEntry.key === SLACK_APP_MENTION` today → `selectedEntry.scope?.channelField !== undefined`):

```tsx
{selectedEntry.scope?.channelField !== undefined && (
  <label className="flex items-start gap-2 text-sm text-ink">
    <input
      type="checkbox"
      className="mt-0.5"
      checked={anyChannel}
      onChange={(e) => setAnyChannel(e.target.checked)}
    />
    <span>
      Any channel
      <span className="block text-xs text-muted">
        {selectedEntry.scope?.creatorUserField !== undefined
          ? "A mention trigger fires only for your own @-mentions and needs a channel filter. Check this to listen in every channel the app can see instead."
          : "This event needs a channel filter. Check this to listen in every channel the app can see instead."}
      </span>
      {anyChannel &&
        selectedEntry.scope?.creatorUserField === undefined &&
        selectedEntry.filters?.some((f) => f.field === "text") && (
          <span className="block text-xs text-muted">
            Tip: add a text filter (for example a command prefix) so the rule fires only on
            messages addressed to it.
          </span>
        )}
    </span>
  </label>
)}
```

Adapt the `selectedEntry.filters` access to the dialog's actual entry shape (it renders filter fields already — reuse that source).

- [ ] **Step 4: Typecheck and web tests**

Run: `pnpm typecheck && pnpm --filter @valet/web test`
Expected: clean. Memory note: `tsc --build` skips web test files — the vitest run is the signal for those.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): catalog-driven scope in the trigger dialog (TKAI-302)"
```

---

### Task 6: Wizard + subscriptions panel

**Files:**
- Modify: `packages/web/src/components/events/automation-wizard.tsx` (`EventMatchStep`, `create()`, `CatalogService`)
- Modify: `packages/web/src/components/events/subscriptions-panel.tsx` (`mentionChannelScope` → generalized)
- Test: `packages/web/src/components/events/automation-wizard.test.tsx`
- Test: `packages/web/src/components/events/-subscriptions-panel.test.tsx`

**Interfaces:**
- Consumes: `requiresChannelScope`, `pinnedToCreator`, `channelScopeFields`, `ScopedEntry` from Task 5; `EventCatalogEntryWire.scope` from Task 2.
- Produces: `subscriptions-panel.tsx` exports `subscriptionChannelScope(sub: EventSubscriptionWire, entries: ScopedEntry[]): string | null` (renamed from `mentionChannelScope`; the panel test imports it by name).

- [ ] **Step 1: Write the failing panel test**

In `-subscriptions-panel.test.tsx`, find the existing `mentionChannelScope` tests (added by 299). Rename the import to `subscriptionChannelScope`, thread a minimal catalog, and add a message case:

```ts
const SCOPED_ENTRIES = [
  { key: "slack.app_mention", scope: { channelField: "channel", creatorUserField: "user" } },
  { key: "slack.message", scope: { channelField: "channel" } },
  { key: "slack.channel_archive" },
];

// Existing mention assertions: add SCOPED_ENTRIES as the second argument.

it("describes a slack.message subscription's channel scope", () => {
  const sub = makeSub({
    eventKeys: ["slack.message"],
    filters: [{ field: "channel", op: "eq", value: "C1", label: "#support" }],
  });
  expect(subscriptionChannelScope(sub, SCOPED_ENTRIES)).toBe("only #support");
});

it("describes a stored any-channel slack.message subscription", () => {
  const sub = makeSub({ eventKeys: ["slack.message"], filters: [] });
  expect(subscriptionChannelScope(sub, SCOPED_ENTRIES)).toBe("any channel");
});

it("returns null for an unscoped key", () => {
  const sub = makeSub({ eventKeys: ["slack.channel_archive"], filters: [] });
  expect(subscriptionChannelScope(sub, SCOPED_ENTRIES)).toBeNull();
});
```

`makeSub` stands for whatever full-shape builder the existing tests use — reuse it; if none exists, build the complete `EventSubscriptionWire` literal.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/web test subscriptions-panel`
Expected: FAIL (export name and signature do not exist yet).

- [ ] **Step 3: Generalize the panel**

In `subscriptions-panel.tsx`:

1. Rename `mentionChannelScope` → `subscriptionChannelScope(sub, entries)`; replace `selectsSlackMention(sub.eventKeys)` with `requiresChannelScope(entries, sub.eventKeys)` and keep the body otherwise identical (it already reads only `channel` filters; generalize the field test to `channelScopeFields(entries, sub.eventKeys).has(f.field)`).
2. In the panel component, fetch the catalog once (`useEventCatalog()` — the wizard already uses this hook) and flatten to entries: `const entries = (catalogQ.data?.services ?? []).flatMap((s) => s.entries);`. Pass `entries` down to `SubscriptionRow`, which calls `subscriptionChannelScope(sub, entries)`. While the catalog is loading, pass `[]` — the badge is cosmetic and appears on the next render.
3. Update the doc comment: the badge now covers every channel-scoped key, and a scoped row with no channel filter IS the explicit any-channel state.

- [ ] **Step 4: Generalize the wizard's event step**

In `automation-wizard.tsx`:

1. `CatalogService` entries gain `scope`: `entries: { key: string; description: string; filters?: FilterField[]; scope?: { channelField?: string; creatorUserField?: string } }[]`. Find where the catalog response maps into this shape and thread `scope` through (if the response entries pass through unmapped, only the type needs the field).
2. Compute the selected entries once where `EventMatchStep` renders or inside it: `const entries = services.flatMap((s) => s.entries);` then `const needsChannelScope = requiresChannelScope(entries, [...keys]);` and `const pinned = pinnedToCreator(entries, [...keys]);`.
3. The checkbox render condition changes from `keys.has(SLACK_APP_MENTION)` to `needsChannelScope`. Copy splits on `pinned`:
   - pinned: keep 299's mention copy verbatim.
   - not pinned: `"This event needs a channel filter. Check this to listen in every channel the app can see instead."`
   - When `anyChannel && !pinned` and some selected scoped entry declares a `text` filter field, add the tip line (same text as the trigger dialog): `"Tip: add a text filter (for example a command prefix) so the rule fires only on messages addressed to it."`
4. In `create()`, the event-outcome spread changes from `...(anyChannel && keys.has(SLACK_APP_MENTION) ? { anyChannel: true } : {})` to `...(anyChannel && requiresChannelScope(entries, [...keys]) ? { anyChannel: true } : {})`. The reply outcome is untouched (mention-specific by design).
5. Update the `EventMatchStep` comment ("A `slack.app_mention` rule…") to name catalog scope instead of the key.

The wizard deliberately keeps NO client-side channel gate on the event outcomes (same posture as 299): the server refusal surfaces in the dialog's error area, and the checkbox is the affordance.

- [ ] **Step 5: Extend the wizard test**

In `automation-wizard.test.tsx`, find 299's checkbox test (search `Any channel`). Add a sibling asserting the checkbox appears when `slack.message` is the selected event and that the created body carries `anyChannel: true` when checked — mirror the existing test's setup (mocked catalog: add `scope` to its `slack.app_mention` fixture and a `slack.message` entry with `scope: { channelField: "channel" }`, plus a `text` filter field so the tip renders). Assert the tip text renders when the box is checked for `slack.message` and does NOT render for `slack.app_mention`.

- [ ] **Step 6: Run web tests and typecheck**

Run: `pnpm --filter @valet/web test && pnpm typecheck`
Expected: PASS. 299's existing wizard/panel tests must stay green apart from the renames made deliberately here.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): scope-aware wizard checkbox and panel badge (TKAI-302)"
```

---

### Task 7: Full validation, PR, Linear

**Files:**
- No new files. Validation + delivery.

- [ ] **Step 1: Full local suites**

Run, capturing FULL output (never pipe through tail/head/grep):

```bash
pnpm typecheck
pnpm --filter @valet/api test
pnpm --filter @valet/web test
pnpm --filter @valet/engine test
```

Expected: clean. Memory notes: model-resolution/llm-providers api tests fail if `ANTHROPIC_API_KEY` is exported in the shell — do not export it; `make e2e` scrubs keys and is authoritative.

- [ ] **Step 2: e2e scorecard**

```bash
make e2e 2>&1 | tee /tmp/e2e-tkai302.log
```

Expected: clean scorecard. Acceptable red rows: pre-existing environmental failures only, and you must name why each is unrelated (memory: web-build must be run — `tsc --build` skips web test files; local store-postgres row may fail on clean checkouts — CI remote-postgres is authoritative for it; a single random Docker-suite flake under pool contention gets one `--only` re-run before it counts).

- [ ] **Step 3: Push (YubiKey) and open the stacked PR**

```bash
say "yubikey"
git push -u origin conner/tkai-302-decide-scoping-policy-for-slackmessage-subscriptions
```

Then create the PR with `gh`, base = `conner/tkai-299-scope-slack-mention-subscriptions-to-the-user-and-selected`:

```bash
gh pr create \
  --base conner/tkai-299-scope-slack-mention-subscriptions-to-the-user-and-selected \
  --title "feat(api,web): catalog-declared scope gate; channel scope on slack.message (TKAI-302)" \
  --body-file /tmp/pr-body.md
```

PR body constraints (CI-linted): ≤300 words, no em/en dashes, no marketing words, filled Validation section from `.github/PULL_REQUEST_TEMPLATE.md`. Content: the policy (channel scope or explicit any-channel on `slack.message`, no creator pinning), the mechanism (catalog `scope` declarations replace hardcoded keys, server and web both derive from them), the grandfathering note, and the stacked-on-299 note. Put extra detail in a follow-up PR comment, not the body.

- [ ] **Step 4: Close the loop on Linear**

Comment on TKAI-302 (linear-server MCP `save_comment`) with the decision so the "Decide" issue is answered even before the PR merges:

- Chosen: options 1 + 2 combined. `slack.message` requires channel scope (`eq`/non-empty `in`) or the explicit any-channel opt-out; no creator-user injection. Scoping is declared per catalog entry (`EventCatalogEntry.scope`), enforced in the one write gate, and shipped to the web on the catalog wire.
- Rejected: option 3 (match-gated persistence answers storage, not delivery: an unfiltered subscription is a whole-workspace listener). Text filters do not satisfy the gate (no crisp line between `prefix: "!deploy"` and `prefix: "a"`); they are the encouraged companion to any-channel, surfaced as a UI tip.
- Grandfathering: no match-time arm for channel scope; pre-gate `slack.message` rows keep firing (accepted pre-1.0, documented in the spec).
- Link the PR.

---

## Self-Review (completed)

- **Spec coverage:** TKAI-302 option 1 → Task 3 (gate) + Task 2 (declaration on `slack.message`). Option 2 → Tasks 2-6 (declaration, gate, matcher, web all catalog-driven; hardcoded keys removed except the wizard's deliberate mention-only reply outcome). Text-prefix discussion → UI tip in Tasks 5-6, gate unchanged. "Where the gate lives now" (one predicate change + UI surfaces) → Tasks 3, 5, 6. Spec update → Task 3 Step 8. Decision recorded → Task 7 Step 4.
- **Type consistency:** `enforceSubscriptionScope`, `storedAnyChannelState(plugins, eventKeys, filters)`, `allCatalogEntriesWithService`, `ScopedEntry`, `channelScopeFields`, `requiresChannelScope`, `pinnedToCreator`, `hasChannelScopeFilter(filters, fields?)`, `storedAnyChannel(entries, eventKeys, filters)`, `subscriptionChannelScope(sub, entries)` — names and signatures match across tasks.
- **Known adaptation points (deliberate, flagged inline):** success status code in route tests (mirror neighbors), PATCH verb (mirror neighbors), `match.test.ts` row shape (mirror existing fixtures), wizard test catalog mock shape, panel `makeSub` builder. Each says "mirror the existing pattern in the same file" — the file is always named.
