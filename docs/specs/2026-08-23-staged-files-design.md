# Staged Files Design — skill resources and parent-to-child file sharing

**Date:** 2026-08-23
**Status:** Implemented: the `session_staged_files` table, the staging service, `staged:` prep steps, skill resource loading (`loadSkillFromDirectory`), skill-tool materialization, `task.files`, and `child_push_file`.
**Scope:** One subsystem that puts files into a session's sandbox from outside the sandbox. Two producers use it: skill resource bundles (`scripts/`, `references/`, `assets/` per the Agent Skills spec) and orchestrator-to-child file sharing (the `task` tool's `files` parameter and the `child_push_file` tool).

## Context

Two features need the same missing primitive.

First, the Agent Skills specification (<https://agentskills.io/specification>) lets a skill ship files beside `SKILL.md`: executable code in `scripts/`, documentation in `references/`, templates in `assets/`. Valet parses `SKILL.md` and nothing else. A skill body that says "run `scripts/extract.py`" hands the agent a path that does not exist. The agent-skills design (`2026-08-05-agent-skills-design.md`) lists this under Not implemented.

Second, an orchestrator often holds a file its child needs: a report to revise, a config to apply, a dataset to analyze. Today nothing carries a file from parent to child. The parent can only paste content into the child's prompt, which fails for binary data and for anything large.

Both features reduce to: "make these bytes exist at this path inside that session's sandbox, and keep them there." This spec defines the shared subsystem, called staged files.

## Terminology

- **staged file**: one record that binds a session to a payload and a target path. The unit of staging.
- **payload**: the bytes of a staged file. Inline in the record for small text, or in the blob store for everything else.
- **bundle**: a payload that is a gzipped tar archive of a directory. Materialization unpacks it.
- **materialize**: write a staged file's payload to its target path inside the sandbox.
- **share**: a staged file produced by the parent-to-child path.
- **resource**: a file a skill ships beside its `SKILL.md`.
- **workspace**: in this document, always the in-sandbox path `/workspace`. The session's working directory.

## Decision 1: copy bytes, never share volumes

A shared volume between two sandboxes was considered and rejected:

1. It breaks provider portability (locked architecture decision 2). A shared PVC exists only on the kubernetes backend. Docker uses per-sandbox host bind mounts. Local and virtual have no volumes at all.
2. Cross-pod PVC sharing needs a ReadWriteMany storage class. Neither the local k3s setup nor the default EKS storage class provides one.
3. The two lifetimes rarely overlap. The orchestrator is sandbox-less in steady state, and a settled child hibernates. A live mount assumes both filesystems exist at once, which is frequently false.

Staged files copy bytes instead. Every provider already implements `readFile`, `readBinary`, `writeFile`, `writeBinary`, `mkdir`, and `exec` behind the `Sandbox` interface (`packages/engine/src/types.ts`), so one code path serves docker, kubernetes, local, and virtual.

A share is therefore a snapshot. The child gets the bytes as they were at share time. Later edits in the parent do not propagate. This is the intended semantic: a consistent copy, with `child_push_file` available when the parent wants to send a newer version.

## Decision 2: blob store between the two sandboxes, PrepStep into the target

A direct read-from-parent, write-to-child copy has two failure modes:

- **Timing.** At spawn time the child sandbox does not exist yet. Later, the parent sandbox may be gone. A direct copy needs both ends live at once.
- **Durability.** The reconcile loop replaces a sandbox container on image drift (`docs/specs/2026-08-02-sandbox-reconcile-design.md`). A one-shot write into the container is lost on replacement. Only content-hashed prep steps are re-applied.

So staging is a two-hop pipeline:

1. **Snapshot.** The producer reads the payload (from the parent sandbox, or from a plugin package on disk) and writes it to the `BlobStore`, or inline into the record when small.
2. **Record.** A `session_staged_files` row binds the payload to the target session and path. The row is the source of truth.
3. **Materialize.** The session's `SpecProvider` emits one `PrepStep` per staged file. `attachment.reconcile` applies the step at every run-start window, so the file exists after cold boot, image drift, and hibernation resume.

The step's `hash` is the payload's content hash. A re-pushed file changes the hash, so reconcile rewrites it. An unchanged file matches the applied state and costs nothing.

## Decision 3: every target path lives under the workspace

Target paths MUST resolve inside `/workspace`. Absolute paths outside it and `..` traversal are rejected at record-insert time.

Two reasons:

1. **Provider correctness.** The docker provider serves file reads and writes host-side, through the workspace bind mount. A path outside `/workspace` would hit the host filesystem, not the container (`packages/sandbox-docker/src/sandbox.ts`, `resolveHostPath`).
2. **Safety on non-isolated providers.** The local provider execs against the host. Writes confined to the session's own workspace directory are safe there; writes to global paths are not. This is the same rule that makes `buildSpecProvider` skip credential prep for non-isolated, repo-less sessions (`packages/api/src/engine/host.ts`).

Conventional locations, following the existing `/workspace/.valet/prompts` precedent:

- Skill resources: `/workspace/.valet/skills/<skill-name>/` (the skill root; `scripts/`, `references/`, `assets/` keep their relative layout under it).
- Shares: the caller names a path relative to `/workspace`. Default when omitted: `/workspace/.valet/shared/<basename>`.

## Decision 4: one table, two producers

`session_staged_files` is an app-layer table (`packages/api/migrations/pg/0000_app.sql`, Drizzle schema in `packages/api/src/schema/index.ts`):

| Column | Meaning |
|---|---|
| `id` | Row id. The prep step id is `staged:<id>`. |
| `session_id` | The session whose sandbox receives the file. |
| `origin` | `skill` or `share`. |
| `origin_key` | The skill name, or the parent session id. |
| `target_path` | Workspace-relative target. For a bundle, the directory to unpack into. |
| `kind` | `file` or `bundle`. |
| `blob_key` | Blob store key, or NULL when inline. |
| `inline_content` | Payload text, or NULL when in the blob store. Exactly one of `blob_key` and `inline_content` is set. |
| `content_hash` | SHA-256 of the payload. Becomes the prep step hash. |
| `size_bytes` | Payload size, for limits and display. |
| `created_at`, `updated_at` | Bookkeeping. |

A UNIQUE index on `(session_id, target_path)` makes a re-push an upsert: the newest payload owns the path.

Blob keys are namespaced `staged/<session_id>/<row_id>/<first 16 hex of content_hash>`. The hash suffix ties a row to exactly the payload its `content_hash` describes: two racing pushes to one target cannot leave the surviving row pointing at the other push's bytes. A superseded key's blob is deleted best-effort. Session deletion removes the rows and their blobs, including for a session that is not in the process cache at delete time.

## Decision 5: materialization is part of the sandbox spec

`resolveSnapshot` (`packages/api/src/engine/sandbox-spec.ts` consumers) reads the session's `session_staged_files` rows into the `ResolveSnapshot`. `computeSpec` emits one `StepSpec` per row after the clone steps:

- id: `staged:<row_id>`
- hash: `content_hash` plus `target_path` plus `PREP_VERSION`
- critical: `true` for shares, `false` for skill resources

Shares are critical because the file is often the reason the child exists; a child that starts without it would work from wrong inputs silently. Skill resources are non-critical because the session is useful without them, and the skill tool reports a missing root loudly at activation time.

`buildPrepSteps` pairs each `staged:` id with an apply closure:

- `kind: file`, inline: `sandbox.writeFile` (with `mkdir -p` of the parent).
- `kind: file`, blob: read the blob, `sandbox.writeBinary`.
- `kind: bundle`: write the tar blob to `/workspace/.valet/tmp/<row_id>.tgz`, `exec` `mkdir -p <target> && tar xzf <tmp> -C <target> && rm <tmp>`. The tmp path is inside the workspace so the docker provider's host-side write and the container-side exec see the same file.

Every path in an exec command goes through `shellQuote` (INV-5). After a skill script file applies (a `skill` row under a `scripts/` directory), one best-effort `exec` restores its executable bit, so a script survives sandbox replacement with the mode the skill body relies on.

## Decision 6: skill resources load from the plugin package, eagerly

`loadSkillFromDirectory(dir, source)` joins `loadSkillFromMarkdown` in `packages/engine/src/roles-skills/loader.ts`. It reads `SKILL.md`, then walks the directory for resource files, and returns a `SkillSource` whose new optional `resources` field carries them:

```ts
resources?: Array<{ path: string; data: Uint8Array }>;
resourcesHash?: string; // SHA-256 over sorted (path, bytes) pairs
```

`path` is relative to the skill root (`scripts/extract.py`). Loading is eager, at plugin module load, the same moment `SKILL.md` is read today. Two caps keep this sane: 64 files and 5 MiB per skill, both enforced by the loader with an error that names the skill. Plugin skills are ours, so an oversized bundle is a build-time bug and must be loud.

Stored skills (`skills` table) and repo-synced skills carry no resources in this design. See Not implemented.

## Decision 7: skills materialize at activation, then converge

Resources reach the sandbox on demand, honoring the spec's progressive disclosure. When the model calls the `skill` tool for a skill with resources, the tool:

1. Writes the resources into `/workspace/.valet/skills/<name>/` through `ToolContext.sandbox` (write-through, so the files exist in the same turn). Touching the sandbox warms it if it was cold, which is the normal first-touch path for orchestrators.
2. Upserts the session's `session_staged_files` rows for the skill, one `file` row per resource, so every later reconcile re-materializes them after a sandbox replacement.
3. Prefixes the rendered body with one line: `Files for this skill are in /workspace/.valet/skills/<name>/.` Relative references in the body (`scripts/extract.py`) resolve against that root.

A failed invocation (`[skill_not_found]`, `[skill_bad_args]`) materializes nothing: the model is being asked to retry, so a success-shaped root line on an error text would mislead it.

The `skill` tool is the ONLY materializing path. The other two delivery paths — slash-command expansion and `Thread.skill()` — append a note to a resource-bearing skill's body that tells the model to call the `skill` tool for the files.

If the write-through fails, the tool returns the skill body with a warning line instead of the root line, and does not insert rows. The model learns the scripts are unavailable in the same tool result.

Sessions without a `SpecProvider` (orchestrators, and repo-less sessions on non-isolated providers) get the write-through only. For them a sandbox replacement loses the files until the skill is activated again. This is accepted: the durable path covers exactly the sessions whose sandboxes the reconcile loop manages.

## Decision 8: shares snapshot the parent at share time

Two producers on the parent side:

- **`task` gains `files`**: `SpawnChildRequest.files?: Array<{ from: string; to?: string }>`. Before the child session is built, the spawner reads each `from` path out of the parent's sandbox. A directory becomes a bundle: `exec` `tar czf /workspace/.valet/tmp/<id>.tgz -C <from> .` in the parent, then `readBinary` of that tmp file, then cleanup. The payload lands in the blob store and a row lands in `session_staged_files` for the child, exactly like the repo binding row that already precedes `buildChildSession`. The child's first run-start materializes everything before the agent sees the prompt.

  Three refusals keep a spawn honest. Two `files[]` entries that resolve to one target fail the spawn (the second would silently overwrite the first). A share into a child that will get no `SpecProvider` (a repo-less child on a non-isolated backend) fails the spawn with the fix named, because nothing would ever materialize the rows. A spawn that fails after staging deletes the staged rows and blobs before the error returns, so a session id that never exists cannot strand payloads.
- **`child_push_file`**: same snapshot and upsert, against a running child. No write-through and no wake: the file materializes at the child's next run-start window. The tool result says so, and the normal pairing is `child_push_file` then `child_send` ("I put the updated config at ..."), which triggers exactly that run-start.

The parent must have a sandbox to share from. When the orchestrator's sandbox is cold, reading `from` warms it through the same first-touch path as any tool.

Limits: 256 MiB per share, 16 files per spawn. The cap is enforced from `stat` BEFORE the payload is read into API memory, for both a file and the tarball an in-sandbox `tar` just produced — an oversized share is rejected without buffering it. The error names the size and the cap. Sandbox-backend failures during the snapshot surface as themselves; only a real missing path reports "not found".

Depth stays 1 (engine rule: children get no `childSpawner`), so shares only flow parent to child. Nothing flows child to parent in this design; see Not implemented.

## Invariants

- **INV-1 — no sandbox reaches another sandbox.** Every copy is mediated by the API process using the `Sandbox` interface. The in-sandbox gateway's `sid === VALET_SESSION_ID` JWT check is untouched. Enforced by construction: no new network path exists between sandboxes.
- **INV-2 — staged writes stay inside the workspace.** `target_path` validation rejects absolute paths outside `/workspace` and any path containing `..`. Enforced at row insert (one shared validator), and covered by a unit test per producer.
- **INV-3 — a staged file survives sandbox replacement.** The row, not the sandbox, is the source of truth; reconcile re-applies from the row. Enforced by the `staged:` prep steps and covered by a reconcile test that replaces the sandbox and asserts the file returns. Exception: sessions without a SpecProvider (decision 7).
- **INV-4 — payloads are content-addressed into the step hash.** A payload change always changes the step hash, so reconcile can never skip a stale file. Enforced by `content_hash` in the step-hash input, and by the content-hash suffix in the blob key (a row can only reference the payload its hash describes).
- **INV-5 — every path in an exec command is shell-quoted.** Providers run `exec` through `sh -c`, and share paths are model-written strings. Enforced by `shellQuote` at every exec call site in the staged-files module, covered by a quoting test.

## Acceptance scenario

One run, clean start, docker backend:

1. An orchestrator session writes `report.md` and a `data/` directory in its sandbox.
2. It calls `task` with `files: [{ from: "report.md" }, { from: "data", to: "input/data" }]` and a prompt that names both paths.
3. The child starts. Before its first turn, `/workspace/.valet/shared/report.md` and `/workspace/input/data/` exist with the parent's bytes.
4. The child activates a skill that ships `scripts/summarize.py`. The tool result names `/workspace/.valet/skills/<name>/`, and the child runs the script from that path successfully.
5. The child's sandbox is destroyed and re-provisioned (image drift). At the next run-start, both shares and the skill files are back without any tool call.
6. The parent calls `child_push_file` with an updated `report.md`, then `child_send`. The child's next turn reads the new bytes.

## Not implemented

- **Resources on stored and repo-synced skills.** Sync reads `SKILL.md` only, and `github.read_repo_file` decodes UTF-8, so it cannot carry a binary asset. Re-entry seam: sync writes resource payloads to the blob store and stores `(path, blob_key, hash)` rows beside the skill; delivery then feeds the same activation path as plugin resources.
- **Child-to-parent transfer.** A child cannot push a file up. Re-entry seam: a `deliver_file` builtin that stages into the parent's `session_staged_files`, gated on the parent relationship the engine already tracks.
- **Live propagation.** A share is a snapshot; edits after the share do not flow. Re-entry seam: none planned. Re-push with `child_push_file`.
- **Streaming payloads past the caps.** Snapshot and materialize buffer the payload in API memory. The caps (256 MiB share, 5 MiB skill bundle) hold that bound. Raising them means streaming blob-to-sandbox transfer through `exec` stdin, which the kubernetes provider's base64 exec transport does not support today.
- **Durability for SpecProvider-less sessions.** Decision 7's exception. Re-entry seam: give orchestrators a minimal SpecProvider that carries only `staged:` steps.
- **Garbage collection beyond session delete.** A re-pushed path orphans its old blob until session deletion sweeps the namespace. Acceptable at current volumes; revisit with a periodic sweep if blob storage grows.
