# Autoscaler-Aware Sandbox Resource Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve capacity-blocked Kubernetes pods for autoscaling, then let a parent agent retry a child task with lower CPU or memory.

**Architecture:** Capacity-related `Unschedulable` conditions stay on the existing Pending path for a ten-minute CR-age grace. After the grace, the provider returns the scheduler reason, requested resources, and a task retry action. A nested `task.resources` override flows through the engine and API, is stored on the child session, and overlays repository resources during initial creation and every reconcile.

**Tech Stack:** TypeScript, TypeBox, Vitest, Drizzle, PGlite, Kubernetes Sandbox CRs.

**Source spec:** `docs/specs/2026-09-07-autoscaler-resource-recovery-design.md`

---

## File map

- `packages/sandbox-kubernetes/src/lifecycle.ts`: classify capacity as retryable and format pod resource requests.
- `packages/sandbox-kubernetes/src/provider.ts`: use a ten-minute grace and build the actionable terminal error.
- `packages/sandbox-kubernetes/test/lifecycle.test.ts`: pin pure capacity and structural classifications.
- `packages/sandbox-kubernetes/test/provider.test.ts`: pin CR and pod retention plus terminal diagnostics.
- `packages/engine/src/types.ts`: add the resource override to `SpawnChildRequest`.
- `packages/engine/src/builtin-tools/index.ts`: expose, validate, and forward `task.resources`.
- `packages/engine/test/task-tool.test.ts`: pin task schema, validation, and forwarding.
- `packages/api/migrations/pg/0000_app.sql`: add nullable child resource override storage.
- `packages/api/src/schema/index.ts`: add the typed Drizzle column.
- `packages/api/src/lib/drizzle.ts`: repair deployed pre-1.0 databases.
- `packages/api/src/schema/pg-schema.test.ts`: verify migration and repair behavior.
- `packages/api/src/engine/session-meta.ts`: carry stored resource overrides into rebuilt sessions.
- `packages/api/src/engine/resolve-repo-resources.ts`: overlay task values one field at a time.
- `packages/api/src/engine/resolve-repo-resources.test.ts`: pin merge semantics.
- `packages/api/src/engine/host.ts`: apply the override to initial and desired sandbox resources.
- `packages/api/src/engine/host.prebuild-flags.test.ts`: verify create, reconcile, and rebuild behavior.
- `packages/api/src/orchestrator/children.ts`: pass and persist task resource overrides.
- `packages/api/src/orchestrator/children.test.ts`: verify spawner forwarding and storage.
- `docs/specs/2026-08-22-sandbox-lifecycle-design.md`: record capacity classification and the ten-minute grace.
- `docs/specs/2026-09-04-prebuild-sandbox-resources-design.md`: record task-level precedence.
- `docs/specs/2026-07-11-orchestrator-engine-design.md`: record the `task.resources` contract.

### Task 1: Keep capacity-blocked pods available to the autoscaler

**Files:**
- Modify: `packages/sandbox-kubernetes/test/lifecycle.test.ts`
- Modify: `packages/sandbox-kubernetes/test/provider.test.ts`
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts`
- Modify: `packages/sandbox-kubernetes/src/provider.ts`

- [ ] **Step 1: Write failing pure classification tests**

Replace the broad Unschedulable test with cases that require CPU, memory, and
ephemeral-storage shortages to return `null`. Add structural cases that remain
terminal.

```ts
it.each(["cpu", "memory", "ephemeral-storage"])(
  "keeps Insufficient %s on the Pending path",
  (resource) => {
    const pod: PodStatusInfo = {
      phase: "Pending",
      conditions: [{
        type: "PodScheduled",
        status: "False",
        reason: "Unschedulable",
        message: `0/3 nodes are available: 3 Insufficient ${resource}.`,
      }],
    };
    expect(classifyPodFailure(pod)).toBeNull();
  },
);

it.each([
  "0/3 nodes had untolerated taint {dedicated: platform}",
  "0/3 nodes did not match Pod's node affinity/selector",
])("fails structural Unschedulable conditions: %s", (message) => {
  // Build the same Pending condition and expect `unschedulable: ${message}`.
});
```

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run: `pnpm --filter @valet/sandbox-kubernetes test lifecycle.test`

Expected: the three capacity cases fail because `classifyPodFailure` returns an
`unschedulable:` string.

- [ ] **Step 3: Implement the narrow capacity classification**

Add a case-sensitive scheduler-message expression near the other classifiers:

```ts
const CAPACITY_UNSCHEDULABLE_PATTERN = /Insufficient (cpu|memory|ephemeral-storage)/;
```

In the `Unschedulable` branch, return `null` when the message matches. Keep the
existing terminal string for every other message. Update the function comment so
it does not claim that all Unschedulable conditions are terminal.

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run: `pnpm --filter @valet/sandbox-kubernetes test lifecycle.test`

Expected: all lifecycle tests pass.

- [ ] **Step 5: Write failing provider retention and error tests**

Use fake timers and a stateful fake that keeps one CR and one pod identity.
Prove these behaviors:

1. At 60 seconds, a fresh capacity-blocked create throws the retryable readiness
   timeout. The CR still exists and neither CR nor pod deletion ran.
2. A second create adopts the same CR. It reads the same pending pod and does not
   delete it.
3. After ten minutes of CR age, the adopted create throws
   `SandboxStartupError`. The message includes the scheduler reason,
   `cpu=4`, `memory=8Gi`, `task.resources`, `.valet/prebuild.yaml`, and the
   largest-node check.
4. An ephemeral-storage-only shortage names the deployment request and node
   capacity. It does not claim that lower CPU or memory fixes the shortage.

- [ ] **Step 6: Run the provider test and verify RED**

Run: `pnpm --filter @valet/sandbox-kubernetes test provider.test`

Expected: retention fails because capacity still fast-fails, and the message
still reports a five-minute generic capacity error.

- [ ] **Step 7: Implement the grace and terminal diagnosis**

Set:

```ts
const PENDING_TERMINAL_GRACE_MS = 10 * 60_000;
```

Change the private pending diagnosis to return the scheduler detail and the
live pod's request values. Format known values as `cpu=<value>` and
`memory=<value>`. Build two corrective messages:

- CPU or memory shortage: retry a child with a lower `task.resources` value,
  reduce `.valet/prebuild.yaml` for a durable default, and check the largest
  node if the lower value still fails.
- Ephemeral-storage shortage: check node capacity and the deployment's
  ephemeral-storage request.

Keep pre-grace timeouts as plain `Error`. Keep post-grace failures as
`SandboxStartupError`.

- [ ] **Step 8: Run the Kubernetes package suite**

Run: `pnpm --filter @valet/sandbox-kubernetes test`

Expected: 381 existing tests plus the new tests pass. Cluster-gated tests skip
without a configured test cluster.

- [ ] **Step 9: Commit the lifecycle fix**

```bash
git add packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/test/lifecycle.test.ts packages/sandbox-kubernetes/test/provider.test.ts
git commit -m "fix(kubernetes): preserve autoscaler capacity signals"
```

### Task 2: Add validated resources to the task tool

**Files:**
- Modify: `packages/engine/test/task-tool.test.ts`
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/builtin-tools/index.ts`

- [ ] **Step 1: Write failing task-tool tests**

Add one forwarding case with `{ resources: { cpu: 2, memory: "4Gi" } }`.
Assert the spawner receives the normalized object. Add rejection cases for CPU
`0`, CPU above 64, memory `"0"`, memory `"8GB"`, and non-string memory. Assert
the spawner is not called and each error includes a corrective example.

Also assert the parameter schema describes nested `cpu` and `memory` fields.

- [ ] **Step 2: Run the task-tool test and verify RED**

Run: `pnpm --filter @valet/engine test task-tool`

Expected: TypeScript or assertions fail because `resources` is absent from the
tool and spawn request.

- [ ] **Step 3: Implement the engine contract**

Add this field to `SpawnChildRequest`:

```ts
resources?: Pick<SandboxResources, "cpu" | "memory">;
```

Add a nested optional `resources` object to `taskTool.parameters`. Use
`isValidSandboxCpu`, `sandboxCpuRange`, and `parseResourceQuantity` from
`@valet/shared` in a small normalization helper. Trim memory. Convert an empty
object to `undefined`. Throw errors with a `[task_resources]` prefix and a valid
example before the spawner call.

Forward the normalized value in `SpawnChildRequest`. Update the tool description
to say that the override is useful after a child reports insufficient capacity.

- [ ] **Step 4: Run engine tests and typecheck**

Run: `pnpm --filter @valet/engine test task-tool`

Run: `pnpm --filter @valet/engine typecheck`

Expected: both commands pass.

- [ ] **Step 5: Commit the task contract**

```bash
git add packages/engine/src/types.ts packages/engine/src/builtin-tools/index.ts packages/engine/test/task-tool.test.ts
git commit -m "feat(engine): add child sandbox resource overrides"
```

### Task 3: Persist child resource overrides

**Files:**
- Modify: `packages/api/src/schema/pg-schema.test.ts`
- Modify: `packages/api/migrations/pg/0000_app.sql`
- Modify: `packages/api/src/schema/index.ts`
- Modify: `packages/api/src/lib/drizzle.ts`
- Modify: `packages/api/src/engine/session-meta.ts`

- [ ] **Step 1: Write failing schema and repair tests**

Add `agent_sessions.sandbox_resource_overrides` to `REPAIRED_COLUMNS`. Add a
schema assertion that the column is nullable JSONB. Add a Drizzle round-trip that
inserts `{ cpu: 2, memory: "4Gi" }` and reads the same object.

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm --filter @valet/api test pg-schema`

Expected: the migration does not create the new column.

- [ ] **Step 3: Implement migration, schema, and repair**

Add the nullable JSONB column to `agent_sessions` in `0000_app.sql`. Add:

```ts
sandboxResourceOverrides: jsonb("sandbox_resource_overrides").$type<PrebuildResources>(),
```

Add the matching `SCHEMA_REPAIRS` entry. Extend `SessionMetaSource` and
`SessionMeta` with the optional override. Have `loadSessionMeta` copy it without
changing ordinary or legacy sessions.

- [ ] **Step 4: Run schema and session-meta tests**

Run: `pnpm --filter @valet/api test pg-schema session-meta`

Expected: all selected tests pass, including drop-and-repair coverage.

- [ ] **Step 5: Commit persistence**

```bash
git add packages/api/migrations/pg/0000_app.sql packages/api/src/schema/index.ts packages/api/src/lib/drizzle.ts packages/api/src/schema/pg-schema.test.ts packages/api/src/engine/session-meta.ts
git commit -m "feat(api): persist child sandbox resource overrides"
```

### Task 4: Apply task overrides throughout child creation and rebuild

**Files:**
- Modify: `packages/api/src/engine/resolve-repo-resources.test.ts`
- Modify: `packages/api/src/engine/resolve-repo-resources.ts`
- Modify: `packages/api/src/engine/host.prebuild-flags.test.ts`
- Modify: `packages/api/src/engine/host.ts`
- Modify: `packages/api/src/orchestrator/children.test.ts`
- Modify: `packages/api/src/orchestrator/children.ts`

- [ ] **Step 1: Write failing pure precedence tests**

Add an exported helper that the tests require with these cases:

```ts
expect(applySandboxResourceOverrides(
  { docker: false, outcome: "declared", initialResources: { cpu: 4, memory: "8Gi" }, resources: { cpu: 4, memory: "8Gi" } },
  { cpu: 2 },
)).toMatchObject({
  initialResources: { cpu: 2, memory: "8Gi" },
  resources: { cpu: 2, memory: "8Gi" },
});
```

Also pin these cases:

- memory-only override preserves repository CPU;
- no override returns the original result;
- a repository read error plus CPU override makes only CPU authoritative;
- an empty override has no effect.

- [ ] **Step 2: Run the pure resolver test and verify RED**

Run: `pnpm --filter @valet/api test resolve-repo-resources`

Expected: the new helper is missing.

- [ ] **Step 3: Implement per-field overlay**

Implement `applySandboxResourceOverrides(flags, overrides)`. Merge overrides
over `initialResources`. If `flags.resources` is authoritative, merge over it.
If it is withheld, return only supplied override fields as the desired resource
opinion. Preserve other flags and warning metadata.

- [ ] **Step 4: Write failing child spawner and host tests**

In `children.test.ts`, spawn with resources and assert:

- `childSessionFor` receives the object;
- `agent_sessions.sandbox_resource_overrides` stores it; and
- omitted resources store `NULL`.

In `host.prebuild-flags.test.ts`, prove:

- `{ cpu: 2 }` overrides repo CPU 4 and keeps repo memory 8Gi;
- the desired spec also reports CPU 2, so reconcile does not restore CPU 4;
- after cache eviction, `loadSessionMeta` reads the stored override and the
  rebuilt child still creates with CPU 2 and memory 8Gi.

- [ ] **Step 5: Run the API tests and verify RED**

Run: `pnpm --filter @valet/api test orchestrator/children host.prebuild-flags`

Expected: the spawner, database row, and host do not carry the override yet.

- [ ] **Step 6: Thread the override through the API**

Extend `childSessionFor` and `buildChildSession` options with
`sandboxResourceOverrides`. Pass `req.resources` from the child spawner. Store it
with the child row. Include it in every child rebuild shape query.

Apply `applySandboxResourceOverrides` immediately after each
`resolveRepoPrebuildFlags` call. The initial `SandboxCreateOpts.resources` and
the `SpecProvider` result must use the same merged values.

- [ ] **Step 7: Run affected API tests and typecheck**

Run: `pnpm --filter @valet/api test resolve-repo-resources host.prebuild-flags orchestrator/children`

Run: `pnpm typecheck`

Expected: all commands pass.

- [ ] **Step 8: Commit child resource application**

```bash
git add packages/api/src/engine/resolve-repo-resources.ts packages/api/src/engine/resolve-repo-resources.test.ts packages/api/src/engine/host.ts packages/api/src/engine/host.prebuild-flags.test.ts packages/api/src/orchestrator/children.ts packages/api/src/orchestrator/children.test.ts
git commit -m "feat(api): apply task sandbox resource overrides"
```

### Task 5: Update subsystem specifications and verify the complete change

**Files:**
- Modify: `docs/specs/2026-08-22-sandbox-lifecycle-design.md`
- Modify: `docs/specs/2026-09-04-prebuild-sandbox-resources-design.md`
- Modify: `docs/specs/2026-07-11-orchestrator-engine-design.md`
- Modify: `docs/specs/2026-09-07-autoscaler-resource-recovery-design.md` only if implementation review finds a deviation

- [ ] **Step 1: Update the maintained specifications**

Record the ten-minute grace and capacity-only exception in the lifecycle spec.
Add task override precedence above repository YAML in the resource spec. Add the
nested `resources` object and per-child scope to the orchestrator task contract.

- [ ] **Step 2: Run focused affected package suites**

Run: `pnpm --filter @valet/sandbox-kubernetes test`

Run: `pnpm --filter @valet/engine test task-tool`

Run: `pnpm --filter @valet/api test resolve-repo-resources host.prebuild-flags orchestrator/children pg-schema`

Expected: all non-cluster tests pass. Cluster-gated Kubernetes tests can skip.

- [ ] **Step 3: Run repository typecheck**

Run: `pnpm typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 4: Run canonical end-to-end validation**

Run: `make e2e`

Expected: a clean scorecard. Record each environment-gated skip. Investigate any
red row and name an unrelated environmental cause before proceeding.

- [ ] **Step 5: Run the required completion review**

Use `superpowers:requesting-code-review`. Fix every blocking finding, rerun the
affected tests, and repeat review until approved.

- [ ] **Step 6: Commit documentation and review fixes**

```bash
git add docs/specs/2026-08-22-sandbox-lifecycle-design.md docs/specs/2026-09-04-prebuild-sandbox-resources-design.md docs/specs/2026-07-11-orchestrator-engine-design.md docs/specs/2026-09-07-autoscaler-resource-recovery-design.md
git commit -m "docs: document sandbox capacity recovery"
```

- [ ] **Step 7: Publish the pull request**

Rebase or merge the latest `origin/dev-v2` only after remote authentication is
restored. Push `codex/fix-autoscaler-resource-recovery`. Open a PR into
`dev-v2` with the repository template's filled Validation section and a
description under 300 words.
