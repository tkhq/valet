# New Thread Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model labels unambiguous, constrain restricted pickers to approved models, and let users choose whether new threads keep current model settings or use configured defaults.

**Architecture:** The API owns new-thread model and reasoning selection. The web client sends only the active source thread ID, while the API applies the stored user preference and creates the engine thread with its initial settings in one write. Shared web helpers resolve tier tokens to concrete model names, and the approved-models route protects tier targets from reverse invalidation.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, React 19, TanStack Query, Vitest, Testing Library, PGlite/Postgres

---

## File map

- `packages/api/migrations/pg/0000_app.sql`: Add the non-null `new_thread_behavior` user preference.
- `packages/api/src/schema/index.ts`: Mirror the user preference in Drizzle.
- `packages/api/src/lib/drizzle.ts`: Repair existing pre-1.0 databases with the new defaulted column.
- `packages/api/src/wire/types.ts`: Define the preference and the optional `sourceThreadId` request field.
- `packages/api/src/routes/me.ts`: Read, validate, and update the preference.
- `packages/engine/src/session.ts`: Persist model and reasoning settings before an API-created thread becomes visible.
- `packages/api/src/engine/host.ts`: Resolve fresh model and reasoning defaults without using persisted session choices.
- `packages/api/src/routes/messages.ts`: Apply the preference and initialize a new thread from its source or defaults.
- `packages/api/src/routes/approved-models.ts`: Reject approved-list changes that strand a configured tier target.
- `packages/web/src/lib/model-tiers.ts`: Resolve tier tokens to active catalog models and concrete display labels.
- `packages/web/src/components/session/model-picker.tsx`: Show concrete selected names and enforce restricted catalogs.
- `packages/web/src/components/settings/model-combobox.tsx`: Show concrete names for selected tier values.
- `packages/web/src/routes/settings.assistant.tsx`: Add the two-choice new-thread behavior setting.
- `packages/web/src/components/session/thread-tree.tsx`: Send the active thread as the source for a new thread.
- `packages/web/src/api/settings.ts`: Optimistically update the new preference.
- `docs/specs/2026-09-04-new-thread-model-picker-design.md`: Record implementation details and any verified deviations.

### Task 1: Persist the new-thread preference

**Files:**

- Modify: `packages/api/src/wire/types.ts`
- Modify: `packages/api/src/routes/me.test.ts`
- Modify: `packages/api/src/routes/me.ts`
- Modify: `packages/api/migrations/pg/0000_app.sql`
- Modify: `packages/api/src/schema/index.ts`
- Modify: `packages/api/src/lib/drizzle.ts`
- Modify: `packages/api/src/schema/pg-schema.test.ts`

- [ ] **Step 1: Add failing API contract tests**

Add tests that assert `GET /api/me` returns `newThreadBehavior: "keep_current"`, that `PATCH /api/me` accepts both supported values, and that it rejects other values with a corrective error. Add a schema test for the defaulted, non-null text column.

```ts
expect(body.newThreadBehavior).toBe("keep_current");

const response = await app.request("/api/me", {
  method: "PATCH",
  headers: authHeaders,
  body: JSON.stringify({ newThreadBehavior: "use_defaults" }),
});
expect(response.status).toBe(200);
expect((await response.json()).newThreadBehavior).toBe("use_defaults");
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm --filter @valet/api test me.test pg-schema.test`

Expected: FAIL because the wire type, response field, and database column do not exist.

- [ ] **Step 3: Add the wire type and database column**

Define the closed union and expose it in both me payloads.

```ts
export type NewThreadBehavior = "keep_current" | "use_defaults";

export interface MeResponse {
  // existing fields
  newThreadBehavior: NewThreadBehavior;
}

export interface PatchMeRequest {
  // existing fields
  newThreadBehavior?: NewThreadBehavior;
}
```

Add `new_thread_behavior text DEFAULT 'keep_current' NOT NULL` to `0000_app.sql`, its Drizzle equivalent to `users`, and a matching additive `SCHEMA_REPAIRS` entry.

- [ ] **Step 4: Validate and persist the preference**

Add `newThreadBehavior` to the strict whitelist. Reject values outside the two-value union. Include the stored value in `loadMeResponse`.

```ts
if (raw.newThreadBehavior !== "keep_current" && raw.newThreadBehavior !== "use_defaults") {
  return c.json({
    error: "newThreadBehavior must be keep_current or use_defaults. Select a supported new-thread behavior.",
  }, 400);
}
update.newThreadBehavior = raw.newThreadBehavior;
```

- [ ] **Step 5: Run the focused API tests**

Run: `pnpm --filter @valet/api test me.test pg-schema.test`

Expected: PASS.

- [ ] **Step 6: Commit the preference contract**

```bash
git add packages/api/migrations/pg/0000_app.sql packages/api/src/schema/index.ts packages/api/src/lib/drizzle.ts packages/api/src/schema/pg-schema.test.ts packages/api/src/wire/types.ts packages/api/src/routes/me.ts packages/api/src/routes/me.test.ts docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "feat: add new-thread behavior preference"
```

### Task 2: Initialize engine threads atomically

**Files:**

- Modify: `packages/engine/src/session.ts`
- Modify: `packages/engine/src/model-switching.test.ts`

- [ ] **Step 1: Add failing engine tests**

Create a thread through a new asynchronous factory with explicit initial settings. Assert that its first `ThreadData` record contains the tier token and reasoning level.

```ts
const thread = await session.createThread("web:new", { model: "s", reasoning: "high" });
expect(thread.modelId()).toBe("s");
expect(thread.reasoning()).toBe("high");
expect(thread.toThreadData()).toMatchObject({ model: "s", reasoning: "high" });
```

Also assert that existing callers without initial settings still inherit the session model and reasoning. Make the store's `saveThread` reject, then assert that `createThread` rejects and that `threadById` and `threadByKey` cannot find the failed thread.

- [ ] **Step 2: Run the focused engine test and verify failure**

Run: `pnpm --filter @valet/engine test model-switching`

Expected: FAIL because `Session.createThread` and typed initial settings do not exist.

- [ ] **Step 3: Add an awaited engine thread factory**

Add a focused `ThreadInitialSettings` interface and a private data builder shared with the current synchronous get-or-create path. Add `createThread`, which awaits `saveThread` before it attaches the thread to the session maps. If persistence rejects, the method must reject without leaving a cached thread.

```ts
export interface ThreadInitialSettings {
  model?: string;
  reasoning?: ReasoningLevel | null;
}

async createThread(key: string, initial?: ThreadInitialSettings): Promise<Thread> {
  const data = this.buildThreadData(key, initial);
  await this.providers.store.saveThread(this.id, data);
  const thread = new Thread(this, data);
  this.attachThread(thread);
  return thread;
}
```

Keep `thread()` backward-compatible for existing engine call sites. Make `newThread()` use the awaited factory. The API route in Task 3 must also use the awaited factory.

- [ ] **Step 4: Run the focused engine test**

Run: `pnpm --filter @valet/engine test model-switching`

Expected: PASS.

- [ ] **Step 5: Commit the engine change**

```bash
git add packages/engine/src/session.ts packages/engine/src/model-switching.test.ts docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "feat: initialize thread model settings"
```

### Task 3: Apply new-thread behavior on the server

**Files:**

- Modify: `packages/api/src/wire/types.ts`
- Modify: `packages/api/src/engine/host.ts`
- Modify: `packages/api/src/engine/host.default-model.test.ts`
- Modify: `packages/api/src/routes/messages.ts`
- Modify: `packages/api/src/routes/messages.test.ts`

- [ ] **Step 1: Add failing default-resolution tests**

Add host tests for a fresh default resolver. Cover personal, team, assistant, host, and `s` model fallbacks. Assert that a historical session model does not enter this resolver. Cover the matching reasoning cascade.

```ts
const settings = await host.resolveFreshThreadSettings(sessionId);
expect(settings).toEqual({ model: "s", reasoning: "high" });
```

- [ ] **Step 2: Add failing route tests**

Cover these POST cases:

1. The default `keep_current` preference copies the source thread model and reasoning.
2. The copy preserves a tier token instead of its current concrete target.
3. `use_defaults` ignores source values and uses the fresh cascade.
4. Omitted `sourceThreadId` uses fresh defaults for either preference.
5. A supplied missing or cross-session source returns 404 before it creates a thread.
6. Existing threads remain unchanged.

Use a request shape such as:

```ts
const response = await app.request(`/api/sessions/${sessionId}/threads`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ sourceThreadId }),
});
expect(await response.json()).toMatchObject({ model: "m", reasoning: "medium" });
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `pnpm --filter @valet/api test host.default-model.test messages.test`

Expected: FAIL because the resolver and request field do not exist.

- [ ] **Step 4: Add the wire field and fresh resolver**

Extend `CreateThreadRequest` with `sourceThreadId?: string`. Add a public, focused host method that identifies the session owner and applies the existing assistant, personal, team, organization, and host default helpers without an existing session row.

The method returns the chosen model spec and reasoning value. It must not persist or resolve a tier token to a concrete model.

- [ ] **Step 5: Apply the preference in the create-thread route**

Validate the request as a plain object. If a source ID is supplied, resolve it within the loaded engine session and return `thread not found. Select a thread from this session.` when absent.

Load the caller's `newThreadBehavior`. For `keep_current` with a valid source, copy `source.modelId()` and `source.reasoning()`. Otherwise call the fresh resolver. Pass both values into `await engineSession.createThread(key, initial)`. If persistence fails, use the route's existing error handling and do not return a thread summary.

- [ ] **Step 6: Run the focused API tests**

Run: `pnpm --filter @valet/api test host.default-model.test messages.test`

Expected: PASS.

- [ ] **Step 7: Commit server-owned new-thread behavior**

```bash
git add packages/api/src/wire/types.ts packages/api/src/engine/host.ts packages/api/src/engine/host.default-model.test.ts packages/api/src/routes/messages.ts packages/api/src/routes/messages.test.ts docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "feat: apply model settings to new threads"
```

### Task 4: Connect the user preference and source thread in the web app

**Files:**

- Modify: `packages/web/src/routes/settings.assistant.tsx`
- Modify: `packages/web/src/routes/-settings.sections.test.tsx`
- Modify: `packages/web/src/api/settings.ts`
- Modify: `packages/web/src/components/session/thread-tree.tsx`
- Modify: `packages/web/src/components/session/thread-tree-new-thread.test.tsx`
- Modify: web test fixtures that construct a complete `MeResponse`

- [ ] **Step 1: Add failing settings tests**

Assert that the Assistant settings page shows a `New thread behavior` control with two options. Assert each selection sends the correct PATCH field.

```ts
await user.selectOptions(screen.getByLabelText("New thread behavior"), "use_defaults");
expect(patchMeMutate).toHaveBeenCalledWith({ newThreadBehavior: "use_defaults" });
```

- [ ] **Step 2: Add a failing thread-tree test**

With an active thread, click `New thread` and assert that the mutation receives its ID. With no active thread, assert that the request omits the source.

```ts
expect(createThreadMutate).toHaveBeenCalledWith({ sourceThreadId: "thread-active" });
```

- [ ] **Step 3: Run the focused web tests and verify failure**

Run: `pnpm --filter @valet/web test settings.sections thread-tree-new-thread`

Expected: FAIL because the control and request field are not wired.

- [ ] **Step 4: Add the two-choice setting**

Use the existing select primitive and these labels:

- `Keep current settings`
- `Use configured defaults`

The hint must state that the choice controls both model and thinking. Extend `usePatchMe` optimistic cache updates to include `newThreadBehavior`.

- [ ] **Step 5: Send the active source thread**

Call `createThread.mutateAsync(activeThreadId ? { sourceThreadId: activeThreadId } : {})`. Keep all existing navigation and focus behavior.

- [ ] **Step 6: Update complete `MeResponse` fixtures**

Add `newThreadBehavior: "keep_current"` to each typed fixture. Do not weaken fixture types.

- [ ] **Step 7: Run the focused web tests**

Run: `pnpm --filter @valet/web test settings.sections thread-tree-new-thread`

Expected: PASS.

- [ ] **Step 8: Commit the web preference flow**

```bash
git add packages/web/src/routes/settings.assistant.tsx packages/web/src/routes/-settings.sections.test.tsx packages/web/src/api/settings.ts packages/web/src/components/session/thread-tree.tsx packages/web/src/components/session/thread-tree-new-thread.test.tsx packages/web/src docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "feat: configure new-thread model behavior"
```

### Task 5: Show concrete model names for selected tiers

**Files:**

- Modify: `packages/web/src/lib/model-tiers.ts`
- Modify: `packages/web/src/lib/model-tiers.test.ts`
- Modify: `packages/web/src/components/session/model-picker.tsx`
- Modify: `packages/web/src/components/session/model-picker.test.tsx`
- Modify: `packages/web/src/components/settings/model-combobox.tsx`
- Modify: `packages/web/src/components/settings/model-combobox.test.tsx`

- [ ] **Step 1: Add failing tier-resolution tests**

Test a helper that scans tier targets in order and returns the first active catalog model, including bare and provider-qualified matches. Test a shared selected-value label that shows that model's name and falls back to the tier label only when no target resolves.

```ts
expect(resolveTierModel("l", tierMap, models)?.name).toBe("GPT-5.6 Sol");
expect(selectionLabel("l", tierMap, models)).toBe("GPT-5.6 Sol");
```

- [ ] **Step 2: Add failing component tests**

For both picker components, set the selected value to `l` and assert the closed control says `GPT-5.6 Sol`. For the chat picker, assert the thinking suffix remains separate, for example `GPT-5.6 Sol · medium`. Open each control and assert that its tier row still says `Large` with the concrete model as helper text.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `pnpm --filter @valet/web test model-tiers model-picker model-combobox`

Expected: FAIL because closed tier values still use `TIER_LABELS`.

- [ ] **Step 4: Implement shared resolution and labels**

Add `resolveTierModel` and `selectionLabel` to `model-tiers.ts`. Reuse the resolver for `tierSubtitle` and for the chat picker's thinking-level lookup so all three surfaces identify the same target.

- [ ] **Step 5: Use the shared label in closed controls**

Replace tier-label branches in `ModelPicker` and `ModelCombobox`. Keep `TIER_LABELS` only for open tier rows, search terms, and the unresolved fallback.

- [ ] **Step 6: Run the focused web tests**

Run: `pnpm --filter @valet/web test model-tiers model-picker model-combobox`

Expected: PASS.

- [ ] **Step 7: Commit concrete model labels**

```bash
git add packages/web/src/lib/model-tiers.ts packages/web/src/lib/model-tiers.test.ts packages/web/src/components/session/model-picker.tsx packages/web/src/components/session/model-picker.test.tsx packages/web/src/components/settings/model-combobox.tsx packages/web/src/components/settings/model-combobox.test.tsx docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "fix: show resolved model names for tiers"
```

### Task 6: Enforce the approved-model boundary

**Files:**

- Modify: `packages/api/src/routes/approved-models.ts`
- Modify: `packages/api/src/routes/approved-models.test.ts` or create it if absent
- Modify: `packages/web/src/components/session/model-picker.tsx`
- Modify: `packages/web/src/components/session/model-picker.test.tsx`

- [ ] **Step 1: Add a failing route test for reverse invalidation**

Configure a tier target, then try to remove it from the approved list. Assert 400 and a corrective error that tells the admin to repoint the tier first. Also assert that an unrestricted `null` list remains valid.

```ts
expect(response.status).toBe(400);
expect((await response.json()).error).toContain("Change the model tier first");
```

- [ ] **Step 2: Add failing restricted-picker tests**

Mock a non-null approved-model response for both member and admin callers. Assert that the open picker shows every approved model, shows no unapproved model, and has no `Show all models` button. If the current model is now unapproved, assert that it stays visible in the closed trigger but is absent from selectable options.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `pnpm --filter @valet/api test approved-models`

Run: `pnpm --filter @valet/web test model-picker`

Expected: FAIL because admins can reveal the catalog and the API can strand tier targets.

- [ ] **Step 4: Guard configured tier targets in the API**

After normal approved-list validation, load the org tier map. For a non-null list, use the existing normalized `isApproved` comparison on every concrete target. Reject the update when any target would become unapproved. Do not reject `null`, which disables the restriction.

- [ ] **Step 5: Make the restricted picker exact**

Load `useApprovedModels`. Treat a loaded non-null list as restricted. In that state, render all and only catalog entries marked approved for every role. Do not readmit the current unapproved pin into the options. Do not render the catalog reveal button. Preserve the full catalog only for trigger-label lookup.

- [ ] **Step 6: Run the focused approved-model tests**

Run: `pnpm --filter @valet/api test approved-models`

Run: `pnpm --filter @valet/web test model-picker`

Expected: PASS.

- [ ] **Step 7: Commit the approved-model boundary**

```bash
git add packages/api/src/routes/approved-models.ts packages/api/src/routes/approved-models.test.ts packages/web/src/components/session/model-picker.tsx packages/web/src/components/session/model-picker.test.tsx docs/specs/2026-09-04-new-thread-model-picker-design.md
git commit -m "fix: constrain approved model selection"
```

### Task 7: Validate, review, and publish

**Files:**

- Modify: `docs/specs/2026-09-04-new-thread-model-picker-design.md`
- Modify: `docs/plans/2026-09-04-new-thread-model-picker.md`

- [ ] **Step 1: Wipe this worktree's development database**

Run: `make dev-clean`

Expected: the worktree-local `.valet-dev` data is removed. Do not delete another worktree's database.

- [ ] **Step 2: Run package validation**

Run: `pnpm --filter @valet/engine test model-switching`

Run: `pnpm --filter @valet/api test host.default-model.test messages.test me.test approved-models pg-schema.test`

Run: `pnpm --filter @valet/web test model-tiers model-picker model-combobox settings.sections thread-tree-new-thread session-header`

Run: `pnpm typecheck`

Expected: all commands pass.

- [ ] **Step 3: Run documentation checks**

Run: `make e2e E2E_ARGS="--only docs-lint"`

Expected: PASS. If it reports an edited-file issue, fix the prose and run it again.

- [ ] **Step 4: Run the complete repository validation**

Run: `make e2e`

Expected: a clean scorecard. Capture the complete output. If an environment row fails, name the missing credential or unavailable daemon and rerun any affected in-scope suite when possible.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review`. Give the reviewer the approved spec, the plan, and the full diff from `origin/dev-v2`. Resolve all blocking findings and rerun affected tests.

- [ ] **Step 6: Record verified deviations and commit final documentation**

Update the design spec only if the implementation differs. Mark this plan complete.

```bash
git add docs/specs/2026-09-04-new-thread-model-picker-design.md docs/plans/2026-09-04-new-thread-model-picker.md
git commit -m "docs: record model picker implementation"
```

Skip the commit when the files have no new changes.

- [ ] **Step 7: Publish the branch and create the PR**

Push `fix/model-picker-defaults` to `origin`. Create a PR into `dev-v2` with a filled `Summary` and `Validation` section from `.github/PULL_REQUEST_TEMPLATE.md`. Keep the description under 300 words and comply with the repository prose rules.

- [ ] **Step 8: Check the PR state**

Run `gh pr view` and `gh pr checks`. Report the PR URL and any checks that remain in progress.
