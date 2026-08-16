# Skills as Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute in the existing worktree `/Users/conner/code/valet/.claude/worktrees/slash-commands` (branch `worktree-slash-commands`, PR #219).

**Goal:** Fold prompt templates into skills (`invocation: prompt|context` frontmatter), org-level bare-name toggle, `prompts/` repo sync, Library UI filter, and skills agent-tool extensions — all in PR #219.

**Architecture:** Delete the template subsystem (table, routes, registry source, per-user toggle). `SkillSource` gains `invocation` and `argHint`; the dispatcher branches expansion on `invocation`; workspace `.valet/prompts/*.md` loads as repo-source prompt skills through a renamed session provider; DB-stored prompt skills ride the existing `skills` table + `sessionExtras` delivery; `skill_sources` sync scans a `prompts/` directory; the org row gains the bare-name toggle.

**Tech Stack:** TypeScript, Hono, Drizzle, PGlite/node-postgres, React 19 + TanStack Query, vitest.

**Spec:** `docs/specs/2026-08-13-skills-as-commands-design.md` — read it first. It supersedes the template sections of `2026-08-12-slash-commands-design.md`.

## Global Constraints

- Node 22+; no `any`; no `as unknown as T`; no `@ts-ignore`.
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place (never ALTER-append for our own tables); after editing run `rm -rf ~/.valet/pg`.
- Commit subjects ≤72 chars; one commit per task.
- `invocation` frontmatter values exactly: `"context"` (default) | `"prompt"`. Never inferred from `$` tokens.
- Reserved-name error text exactly: `"<name>" is a reserved built-in command name. Pick a different name.`
- Every skill registers `/skill:<name>` always; bare `/<name>` only when the ORG toggle `orgs.bare_skill_commands` is true.
- Bare-name precedence (later registration wins): repo-workspace → plugin → org → team → user.
- All prose in ASD-STE100 style; user-facing errors name the corrective action.

---

### Task 1: Engine — `invocation`/`argHint` on SkillSource, dispatch branch, registry cleanup

**Files:**
- Modify: `packages/engine/src/types.ts` (SkillSource ~line 1321; delete `PromptTemplate`, `TemplateProvider`; `CreateSessionOptions`: delete `templateProvider`, add `workspaceSkillsProvider?: () => Promise<SkillSource[]>`)
- Modify: `packages/engine/src/commands/types.ts` (CommandSource narrows; ResolvedCommand loses template arm)
- Modify: `packages/engine/src/commands/registry.ts` (delete templates input/loop; skill argHint)
- Modify: `packages/engine/src/commands/dispatch.ts` (skill arm branches on invocation)
- Modify: `packages/engine/src/roles-skills/loader.ts` + `spec.ts` (frontmatter keys `invocation`, `argHint`)
- Modify: `packages/engine/src/index.ts` (export cleanup)
- Test: `packages/engine/test/commands-dispatch.test.ts`, `commands-registry.test.ts`, `roles-skills.test.ts` (extend), delete template-specific cases

**Interfaces:**
- Consumes: existing `SkillSource`, `BuildRegistryInput`, `dispatchCommand`, `substituteArgs`, `parseCommandArgs`.
- Produces (later tasks rely on these exact shapes):

```ts
// types.ts — SkillSource additions
export interface SkillSource {
  // ...existing fields...
  /** How a slash invocation expands. "context" (default): wrap in <skill> tags,
   * append args. "prompt": substitute $1/$@ into the body, send bare. Prompt
   * skills are never surfaced as capability documentation. */
  invocation?: "context" | "prompt";
  /** Autocomplete hint for the first argument, e.g. "<topic> [audience]". */
  argHint?: string;
}
// commands/types.ts
export type CommandSource = "builtin" | "skill" | "plugin";   // "template" deleted
// registry.ts
export interface BuildRegistryInput {
  skills: SkillSource[];
  pluginCommands: Array<{ pluginName: string; def: CommandDef }>;
  bareSkillNames: boolean;
}
```

- [ ] **Step 1: Write the failing tests**

In `commands-dispatch.test.ts` (registry fixtures built via `buildCommandRegistry`):

```ts
const promptSkill = {
  name: "standup",
  description: "Daily standup",
  content: "Summarize $1 today. Audience: $2.",
  invocation: "prompt" as const,
  argHint: "<topic> [audience]",
};

it("prompt-invocation skills substitute args and expand bare", () => {
  const reg = buildCommandRegistry({ skills: [promptSkill], pluginCommands: [], bareSkillNames: false });
  const o = dispatchCommand('/skill:standup auth "the team"', reg);
  expect(o.kind).toBe("expand");
  if (o.kind === "expand") {
    expect(o.text).toBe("Summarize auth today. Audience: the team.");
    expect(o.text).not.toContain("<skill");
  }
});

it("context-invocation skills keep the <skill> wrap (default)", () => {
  const reg = buildCommandRegistry({
    skills: [{ name: "review", description: "d", content: "Review carefully." }],
    pluginCommands: [], bareSkillNames: false,
  });
  const o = dispatchCommand("/skill:review src/", reg);
  if (o.kind === "expand") {
    expect(o.text).toContain('<skill name="review">');
    expect(o.text.endsWith("src/")).toBe(true);
  }
});
```

In `commands-registry.test.ts`:

```ts
it("skill argHint reaches CommandInfo", () => {
  const reg = buildCommandRegistry({ skills: [promptSkill], pluginCommands: [], bareSkillNames: false });
  const info = reg.list().find((c) => c.name === "skill:standup");
  expect(info?.argHint).toBe("<topic> [audience]");
});
```

In `roles-skills.test.ts` (loader):

```ts
it("loadSkillFromMarkdown reads invocation and argHint", () => {
  const md = "---\nname: standup\ndescription: d\ninvocation: prompt\nargHint: \"<topic>\"\n---\nBody $1";
  const s = loadSkillFromMarkdown(md, "user");
  expect(s.invocation).toBe("prompt");
  expect(s.argHint).toBe("<topic>");
});
it("rejects an unknown invocation value", () => {
  const md = "---\nname: x\ndescription: d\ninvocation: sideways\n---\nBody";
  expect(() => loadSkillFromMarkdown(md, "user")).toThrow(/invocation/);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @valet/engine test -- commands-dispatch` etc. → FAIL.

- [ ] **Step 3: Implement**

`dispatch.ts` skill arm:

```ts
    case "skill": {
      const { skill } = resolved;
      if (skill.invocation === "prompt") {
        const args = parseCommandArgs(raw);
        return { kind: "expand", text: substituteArgs(skill.content, args) };
      }
      const block = `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`;
      return { kind: "expand", text: raw ? `${block}\n\n${raw}` : block };
    }
```

Delete the `template` case, `PromptTemplate`, `TemplateProvider`, the registry template loop, and the `templates` input. In the skill registration loop, set `argHint: skill.argHint` on both the prefixed and bare `CommandInfo`. In `loader.ts`, read `invocation` (validate against the two values; violation message names the field and the allowed values) and `argHint` (string). `CreateSessionOptions.workspaceSkillsProvider` replaces `templateProvider` (Task 2 wires it). Fix every compile error the deletions surface — including `CommandResultEntry.source` (narrowed union) and its store-postgres mapper `asCommandSource` valid-values list (`packages/store-postgres/src/helpers.ts`).

- [ ] **Step 4: Run** — `pnpm --filter @valet/engine test && pnpm --filter @valet/store-postgres test && pnpm typecheck` (template-typed fixtures elsewhere WILL break — fix them in this task) → PASS.

- [ ] **Step 5: Commit** — `feat(engine): invocation-style skills replace prompt templates`

---

### Task 2: Engine — session provider rename + registry merge

**Files:**
- Modify: `packages/engine/src/session.ts` (`commandRegistry()` ~895, `refreshCommandRegistry()` ~912, cache field)
- Test: extend `packages/engine/test/commands-session.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `Session.commandRegistry()` merges `options.skills` (constructor-loaded) with the cached result of `options.workspaceSkillsProvider` (workspace prompt skills, loaded by `refreshCommandRegistry`). Workspace skills register FIRST so DB/plugin skills of the same name win (repo lowest precedence).

- [ ] **Step 1: Failing test**

```ts
it("workspace prompt skills join the registry after refresh and lose ties", async () => {
  const session = await makeSession(faux, {
    skills: [{ name: "standup", description: "user copy", content: "USER $1", invocation: "prompt" }],
    workspaceSkillsProvider: async () => [
      { name: "standup", description: "repo copy", content: "REPO $1", invocation: "prompt", source: "repo" },
      { name: "deploy-notes", description: "repo only", content: "Notes $1", invocation: "prompt", source: "repo" },
    ],
  });
  await session.refreshCommandRegistry();
  const reg = session.commandRegistry();
  const standup = reg.resolve("skill:standup");
  expect(standup?.source === "skill" && standup.skill.content).toBe("USER $1"); // user beats repo
  expect(reg.resolve("skill:deploy-notes")).toBeDefined();
});
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** — rename `templateCache` → `workspaceSkillsCache: SkillSource[] | null`; `refreshCommandRegistry` loads the provider (same load-first-invalidate-after comment); `commandRegistry()` builds `skills: [...(this.workspaceSkillsCache ?? []), ...this.skills.values()]` (workspace first = lowest precedence; the registry's later-wins rule keeps DB/plugin winners). Registration order inside registry.ts already handles same-list ordering via `overwrite`.

- [ ] **Step 4: Run** — engine suite + typecheck → PASS.

- [ ] **Step 5: Commit** — `feat(engine): workspace skills provider feeds the command registry`

---

### Task 3: API — delete templates + per-user toggle; add the org toggle

**Files:**
- Delete: `packages/api/src/routes/prompt-templates.ts` + its test; the `user_prompt_templates` CREATE TABLE + index in `packages/api/migrations/pg/0000_app.sql`; the `userPromptTemplates` Drizzle table; `users.bareSkillCommands` column (migration + schema) and its `PATCH /api/me` block (`routes/me.ts:118-122`) + me tests for it.
- Modify: `packages/api/migrations/pg/0000_app.sql` `orgs` CREATE TABLE gains `"bare_skill_commands" boolean NOT NULL DEFAULT false`; Drizzle `orgs` gains `bareSkillCommands`.
- Create: `PATCH /api/org/settings` accepting `{ bareSkillCommands: boolean }`, org-admin gated — follow the admin-router pattern of `routes/sources.ts` (mounted under `/api/org/...`); if an org-settings route already exists, extend it.
- Modify: router registration (unmount prompt-templates).
- Test: new `packages/api/src/routes/org-settings.test.ts` (or extend the file's existing suite): non-admin 403; admin toggles true → read back; non-boolean 400.

- [ ] **Step 1: Failing tests** (bootTestApi harness; admin/member fixtures per existing role tests — grep `role: "admin"` in api tests for the pattern):

```ts
it("org admin toggles bareSkillCommands", async () => {
  const res = await patchAsAdmin("/api/org/settings", { bareSkillCommands: true });
  expect(res.status).toBe(200);
  // read-back through the same surface the host uses:
  expect((await getOrgRow()).bareSkillCommands).toBe(true);
});
it("member cannot", async () => {
  expect((await patchAsMember("/api/org/settings", { bareSkillCommands: true })).status).toBe(403);
});
```

- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Implement** the deletions + column move + route. Run `rm -rf ~/.valet/pg` after the migration edit.
- [ ] **Step 4: Run** — `pnpm --filter @valet/api test && pnpm typecheck` (expect fallout in host.ts/command-providers from the deleted table — Task 4 owns the rewrite; if compile blocks, do Tasks 3+4 as one commit-pair with typecheck green only after Task 4. Note this in the report.)
- [ ] **Step 5: Commit** — `feat(api): org-level bare-skill-commands toggle; drop template routes`

---

### Task 4: API host — workspace prompt-skills provider + org-toggle wiring

**Files:**
- Modify: `packages/api/src/engine/command-providers.ts` — `makeTemplateProvider`/`readRepoTemplates`/`parseRepoTemplates` become `makeWorkspaceSkillsProvider(sandbox: () => Sandbox | undefined): () => Promise<SkillSource[]>` + `readRepoPromptSkills(sandbox)`; same `===VALET-TMPL` exec, emitted rows are `SkillSource { source: "repo", invocation: "prompt", name, description?, argHint?, content }` (frontmatter `argHint:` honored).
- Modify: `packages/api/src/engine/host.ts` — `buildCommandOptions`: `bareSkillNames` now reads `orgs.bareSkillCommands` (one select by orgId; the `userId` param and users read delete); return `workspaceSkillsProvider` instead of `templateProvider`; orchestrator + interactive call sites updated (orchestrator no longer needs the personal-user distinction here — stored skills already scope via `sessionExtras`).
- Modify: `packages/api/src/services/skills.ts` — `rowToSkillSource` maps `invocation`/`argHint` out of `row.frontmatter`.
- Test: rewrite `packages/api/src/engine/command-providers.test.ts` (parse cases keep their fixtures, expectations become SkillSource shape); extend `command-route.test.ts`: seeded org row with `bareSkillCommands: true` → GET /commands lists a bare stored prompt skill.

**Interfaces:**
- Produces: `makeWorkspaceSkillsProvider` (exact name; Task 2's session option receives its return).

- [ ] **Step 1: Failing tests** — port the existing four parse tests to the new shape, e.g.:

```ts
it("parses one workspace prompt skill with description and argHint", async () => {
  const stdout =
    "===VALET-TMPL /workspace/.valet/prompts/standup.md\n---\ndescription: Daily standup\nargHint: \"<topic>\"\n---\nSummarize $1\n";
  const skills = await readRepoPromptSkills(fakeSandbox({ stdout, stderr: "", exitCode: 0 }));
  expect(skills[0]).toMatchObject({ name: "standup", invocation: "prompt", source: "repo", argHint: "<topic>" });
  expect(skills[0]?.content).toContain("Summarize $1");
});
```

- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Implement.** Keep the shell-exec + delimiter parsing verbatim; only the output type changes.
- [ ] **Step 4: Run** — full api suite + typecheck → PASS (this closes Task 3's fallout).
- [ ] **Step 5: Commit** — `feat(api): workspace prompt skills + org toggle wire into commands`

---

### Task 5: Skills service/routes/wire — invocation + argHint + reserved names

**Files:**
- Modify: `packages/api/src/services/skills.ts` — create/update accept `invocation?: "context"|"prompt"`, `argHint?: string`; stored in `frontmatter`; validation: invocation enum; NEW: reject skill names in `BUILTIN_COMMAND_NAMES` (import from `@valet/engine`) with the exact reserved-name error text.
- Modify: `packages/api/src/routes/skills.ts` — request/response plumb the two fields.
- Modify: `packages/api/src/wire/types.ts` — `StoredSkillSummary` + `SkillResponse` + create/update requests gain `invocation` and `argHint`.
- Test: extend `packages/api/src/routes/skills.stored.test.ts` (or the file that covers create/update).

- [ ] **Step 1: Failing tests**

```ts
it("creates a prompt-invocation skill and reads it back", async () => {
  const created = await post("/api/skills", { name: "standup", description: "Daily standup",
    content: "Summarize $1", invocation: "prompt", argHint: "<topic>" });
  expect(created.status).toBe(200);
  const got = await get(`/api/skills/standup`);
  expect(got.invocation).toBe("prompt");
  expect(got.argHint).toBe("<topic>");
});
it("rejects a reserved built-in name", async () => {
  const res = await postRaw("/api/skills", { name: "status", description: "d", content: "x" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("reserved built-in command name");
});
```

- [ ] **Step 2: Verify failure** → FAIL. **Step 3: Implement.** **Step 4: Run** api suite + typecheck → PASS. **Step 5: Commit** — `feat(api): invocation and argHint on stored skills; reserve builtins`

---

### Task 6: Sync — `prompts/` directory imports prompt skills

**Files:**
- Modify: `packages/api/src/services/skill-sync.ts` — `readManifest` additionally scans `joinPath(source.subpath, "prompts")`: every `*.md` FILE (not dir) becomes a manifest entry `{ name: basename-without-md, path, contentSha }` whose parsed row gets `invocation: "prompt"` default (file frontmatter may override to `context`; unknown values → per-file warning, skip). Manifest hash covers both lists (skills entries + prompt entries, stable order).
- Modify: `packages/api/src/services/skill-repo-reader.ts` only if it lacks a file-listing call for a directory of files (it has `listDirectory`; reuse).
- Test: extend `packages/api/src/services/skill-sync.test.ts` with the fake reader: repo with `skills/foo/SKILL.md` + `prompts/standup.md` → two rows, the prompt row has `frontmatter.invocation === "prompt"`; a malformed prompt file records a warning and syncs the rest.

- [ ] **Step 1: Failing tests** (follow the suite's fake-reader fixture style):

```ts
it("imports prompts/*.md as prompt-invocation skills", async () => {
  reader.set("prompts/standup.md", "---\ndescription: Daily standup\n---\nSummarize $1");
  await runSync(source);
  const rows = await listRows();
  const prompt = rows.find((r) => r.name === "standup");
  expect(prompt?.frontmatter).toMatchObject({ invocation: "prompt" });
});
it("a malformed prompt file warns and does not block the sync", async () => {
  reader.set("prompts/bad.md", "---\ninvocation: sideways\n---\nx");
  reader.set("prompts/good.md", "Body $1");
  await runSync(source);
  expect((await getSource()).status).toBe("warning");
  expect((await listRows()).some((r) => r.name === "good")).toBe(true);
});
```

- [ ] **Step 2: Verify failure** → FAIL. **Step 3: Implement.** **Step 4: Run** sync suite + full api → PASS. **Step 5: Commit** — `feat(api): skill sources sync a prompts/ directory`

---

### Task 7: Agent tools — invocation-aware skills actions

**Files:**
- Modify: `packages/api/src/services/skills-actions.ts` — `skills.create_skill`/`skills.update_skill` params gain optional `invocation` (enum) and `argHint`; `skills.list_skills` output rows include both fields; param descriptions state the prompt-vs-context semantics in one sentence each.
- Test: extend `packages/api/src/services/skills-actions.test.ts`.

- [ ] **Step 1: Failing test**

```ts
it("create_skill accepts invocation and argHint and list echoes them", async () => {
  await run("skills.create_skill", { name: "standup", description: "d", content: "Summarize $1",
    invocation: "prompt", argHint: "<topic>" });
  const listed = await run("skills.list_skills", {});
  const row = listed.data.skills.find((s) => s.name === "standup");
  expect(row).toMatchObject({ invocation: "prompt", argHint: "<topic>" });
});
```

- [ ] **Step 2: Verify failure** → FAIL. **Step 3: Implement** (service already accepts the fields after Task 5 — this is param plumbing; the existing `require_approval` risk levels stay). **Step 4: Run** → PASS. **Step 5: Commit** — `feat(api): skills actions carry invocation and argHint`

---

### Task 8: Web — Library filter, prompt editor, popup source labels

**Files:**
- Modify: `packages/web/src/routes/skills.index.tsx` — an "All | Skills | Prompts" chip row filtering on `invocation` (summaries now carry it); card shows a small `prompt` badge.
- Modify: the skill editor component used by `skills.new.tsx` / `skills.stored.$skillId.tsx` (`SkillDoc` or sibling) — `invocation` select (context|prompt), `argHint` input, and for prompt bodies a muted preview line that renders the body with `$1`→`⟨arg1⟩`, `$@`→`⟨all args⟩` substitution markers (pure string replace, display only).
- Modify: `packages/web/src/api/skills.ts` + any local types for the new fields.
- Modify: `packages/web/src/components/session/command-popup.tsx` — `SOURCE_LABEL`/`SOURCE_ORDER` lose `template` (compile fallout from CommandSource narrowing); composer fixtures in tests update.
- Test: `packages/web/src/routes/skills.index.test.tsx` (or nearest existing pattern; if list pages have no tests, put coverage on the editor component: renders invocation select, preview line shows `⟨arg1⟩` for `$1`).

- [ ] **Step 1: Failing test** (editor-level):

```tsx
it("prompt invocation shows the substitution preview", () => {
  render(<SkillDoc value={{ name: "standup", description: "d", content: "Summarize $1 for $@",
    invocation: "prompt", argHint: "" }} onChange={vi.fn()} />);
  expect(screen.getByText(/Summarize ⟨arg1⟩ for ⟨all args⟩/)).toBeTruthy();
});
```

Adapt the props to `SkillDoc`'s real API — read the component first; if it is uncontrolled, drive it with userEvent instead.

- [ ] **Step 2: Verify failure** → FAIL. **Step 3: Implement.** **Step 4: Run** web suite + typecheck → PASS. **Step 5: Commit** — `feat(web): skills library filter, prompt editor, invocation badge`

---

### Task 9: Docs + end-to-end validation

**Files:**
- Modify: `docs/specs/2026-08-12-slash-commands-design.md` — mark the template sections superseded with a pointer to the new spec (do not delete the sections; annotate).
- Modify: `docs/specs/2026-08-13-skills-as-commands-design.md` — Deviations section for anything that shifted (e.g. the ambient-delivery note: no ambient injection exists; the exclusion is enforced by absence + a regression test if any surfacing exists).

Steps:
- [ ] Run the full gates: `pnpm --filter @valet/engine test`, `@valet/api`, `@valet/web`, `@valet/store-postgres`, `pnpm typecheck`, `npx vitest run scripts/e2e/lib.test.ts` (integration-file registry — if any integration test file was added/renamed, register it).
- [ ] Live check on `make dev-local` (fresh `~/.valet/pg`): create a prompt skill via `POST /api/skills`, confirm `/skill:standup` autocompletes and expands with substitution; flip the org toggle via `PATCH /api/org/settings`, confirm bare `/standup` appears after a reload.
- [ ] Record honest results (environmental reds named) in the task report; update the Deviations section; commit — `docs: record skills-as-commands outcome`.

---

## Self-Review Notes

- Spec coverage: invocation field (T1), namespace/org toggle (T1 registry unchanged prefix + T3 org column + T4 wiring), deletions (T1 engine, T3 api), workspace reader repurpose (T4), rowToSkillSource mapping (T4), reserved names + route fields (T5), sync prompts/ (T6), agent tools (T7), Library UI (T8), spec supersede + validation (T9). Precedence: sessionExtras already orders user > team > org rows (`listSkillSourcesFor` first-name-wins over `rowsForPrincipal` ordering — Task 4's implementer must VERIFY rows come back user-first and note it; if not, fix the ordering there).
- Type consistency: `workspaceSkillsProvider: () => Promise<SkillSource[]>` (T1 option, T2 consumption, T4 producer); `invocation?: "context" | "prompt"`; `argHint?: string` everywhere.
- Known unknowns stated inline: SkillDoc's real props (T8 reads first); whether org-settings route exists (T3 checks); `rowsForPrincipal` ordering (T4 verifies).
