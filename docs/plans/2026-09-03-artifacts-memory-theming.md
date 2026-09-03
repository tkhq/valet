# Artifacts: file publishing, theming, memory metadata, gallery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the artifact-pages feature with sandbox file-path publishing, a three-state viewer theming contract, memory-doc metadata passthrough, and an `/artifacts` gallery page.

**Architecture:** All four deltas build on the artifact-pages branch (PR #539). The shared shell (`@valet/shared/artifact-page.ts`) gains a `theme` input and a `valet-artifact:theme` parent message; `ArtifactFrame` stamps the initial theme into the srcDoc and restamps live over postMessage. The `artifact_publish` tool reads a sandbox file through `ctx.sandbox` (in-process; the HTTP hop to `/api/artifacts/share` stays the publish chokepoint). `shareArtifact` passes the memory row's `description` through. The gallery is one new TanStack route over the existing `useArtifacts` hook.

**Tech Stack:** TypeScript, Hono, TypeBox tools, React 19 + TanStack Router/Query, Vitest, Drizzle/PGlite.

**Spec:** `docs/specs/2026-09-02-artifact-pages-design.md` (updated by Task 6 in this plan — the deltas here are normative amendments to it).

## Global Constraints

- Branch: `feat/artifacts-memory-theming`, worktree `/Users/conner/code/valet-worktrees/artifacts-memory-theming`, based on `conner/artifact-pages`. The eventual PR base is `conner/artifact-pages` (stacked on #539).
- Run all commands from the worktree root unless a step says otherwise.
- No `any`, no `as unknown as T`, no `@ts-ignore`. Build full shapes in tests.
- Every user-facing error message names the corrective action.
- All prose (spec edits, tool descriptions, error strings, PR body) follows ASD-STE100 per CLAUDE.md. PR body: 300 words max, NO em or en dashes, filled Validation section.
- Commit subjects <= 72 chars. Update the spec in the same commit as the code it describes (Task 6 batches the spec edit; keep it in the final feature commit if you reorder).
- Test filters: `pnpm --filter @valet/<pkg> test <filter>` with NO `--` before the filter (vitest drops args after `--`).
- Node 22 (`nvm use 22`) if `WebSocket is not defined` appears.
- Before `git push`: run `say "YubiKey tap needed"` first (SSH remote needs a hardware tap).

---

### Task 1: Three-state theming in the shared shell

**Files:**
- Modify: `packages/shared/src/artifact-page.ts`
- Test: `packages/shared/src/artifact-page.test.ts`

**Interfaces:**
- Consumes: existing `ArtifactDocumentInput`, `buildArtifactDocument`, `ARTIFACT_RUNTIME_JS`, `ArtifactParentMessage`.
- Produces: `ArtifactDocumentInput.theme?: "light" | "dark"`; `buildArtifactDocument` stamps `data-theme` on `<html>`; new parent message `{ type: "valet-artifact:theme"; theme: "light" | "dark" | null }`; shell CSS resolves all three viewer states. Task 2 relies on the exact message type string `"valet-artifact:theme"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/artifact-page.test.ts` (match the file's existing describe/it style):

```ts
describe("theming", () => {
  it("stamps data-theme when a theme is given", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>", theme: "dark" });
    expect(doc).toContain('<html lang="en" data-theme="dark">');
  });

  it("leaves the root unstamped for the system default", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(doc).toContain('<html lang="en">');
    expect(doc).not.toContain("data-theme");
  });

  it("guards the media-query dark block against an explicit light choice", () => {
    const doc = buildArtifactDocument({ title: "T", content: "<p>x</p>" });
    expect(doc).toContain(':root:not([data-theme="light"])');
    expect(doc).toContain(':root[data-theme="dark"]');
  });

  it("ships a theme handler in the runtime", () => {
    expect(ARTIFACT_RUNTIME_JS).toContain("valet-artifact:theme");
  });
});
```

Add `ARTIFACT_RUNTIME_JS` to the test file's imports from `./artifact-page.js` if it is not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @valet/shared test artifact-page`
Expected: the four new cases FAIL (`data-theme` never rendered; selector absent; runtime lacks the string).

- [ ] **Step 3: Implement**

In `packages/shared/src/artifact-page.ts`:

1. Extend the input interface:

```ts
export interface ArtifactDocumentInput {
  // ...existing fields unchanged...
  /**
   * The viewer's explicit theme choice. Omit for the system default: the
   * root stays unstamped and the prefers-color-scheme media query governs.
   */
  theme?: "light" | "dark";
}
```

2. Stamp the attribute in `buildArtifactDocument`:

```ts
export function buildArtifactDocument(input: ArtifactDocumentInput): string {
  const head = buildHead(input);
  const themeAttr = input.theme ? ` data-theme="${input.theme}"` : "";
  return `<!doctype html>
<html lang="en"${themeAttr}>
<head>
${head}
</head>
${input.content}
</html>`;
}
```

3. Restructure `ARTIFACT_BASE_CSS` tokens into the three-state form. Extract the dark token set once so the two dark blocks cannot drift:

```ts
const ARTIFACT_DARK_TOKENS = `color-scheme: dark;
  --artifact-bg: #14161a;
  --artifact-fg: #e8eaee;
  --artifact-muted: #98a0ad;
  --artifact-line: #2a2e36;
  --artifact-accent: #7fb28f;`;
```

Replace the current `:root { ... }` + `@media (prefers-color-scheme: dark) { :root { ... } }` token section with:

```css
:root {
  color-scheme: light dark;
  --artifact-bg: #ffffff;
  --artifact-fg: #16181d;
  --artifact-muted: #5b6270;
  --artifact-line: #e3e5ea;
  --artifact-accent: #3d6b4f;
}
:root[data-theme="light"] { color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${ARTIFACT_DARK_TOKENS} }
}
:root[data-theme="dark"] { ${ARTIFACT_DARK_TOKENS} }
```

(`ARTIFACT_BASE_CSS` is a template literal; interpolate the const. Light values stay on bare `:root` so no color's only definition sits behind a media or attribute block.)

4. Extend the parent message union:

```ts
export type ArtifactParentMessage =
  | { type: "valet-artifact:mode"; picking: boolean }
  | { type: "valet-artifact:anchors"; vdids: string[] }
  | { type: "valet-artifact:theme"; theme: "light" | "dark" | null };
```

5. In `ARTIFACT_RUNTIME_JS`, inside the existing `message` listener where `valet-artifact:mode` and `valet-artifact:anchors` are handled, add:

```js
if (data.type === "valet-artifact:theme") {
  if (data.theme === "light" || data.theme === "dark") {
    document.documentElement.setAttribute("data-theme", data.theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @valet/shared test artifact-page`
Expected: PASS, including all pre-existing cases (some assert on the document string; if one asserts the exact `<html lang="en">` line, confirm it still matches the unstamped default).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/artifact-page.ts packages/shared/src/artifact-page.test.ts
git commit -m "feat(shared): three-state theme contract in the artifact shell"
```

---

### Task 2: Theme wiring — hook, frame prop, viewer route

**Files:**
- Create: `packages/web/src/lib/use-theme-attribute.ts`
- Create: `packages/web/src/lib/use-theme-attribute.test.ts`
- Modify: `packages/web/src/components/artifact/artifact-frame.tsx`
- Modify: `packages/web/src/routes/a.$token.tsx`
- Test: `packages/web/src/components/artifact/artifact-runtime.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `theme` input on `buildArtifactDocument` and the `valet-artifact:theme` parent message.
- Produces: `useThemeAttribute(): "light" | "dark" | null` (null = system/unstamped); `ArtifactFrame` prop `theme?: "light" | "dark" | null`.

- [ ] **Step 1: Write the failing hook test**

`packages/web/src/lib/use-theme-attribute.test.ts`:

```ts
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { useThemeAttribute } from "./use-theme-attribute";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("useThemeAttribute", () => {
  it("reads the current data-theme and null for system", () => {
    const { result } = renderHook(() => useThemeAttribute());
    expect(result.current).toBeNull();
  });

  it("tracks attribute changes", async () => {
    const { result } = renderHook(() => useThemeAttribute());
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      // MutationObserver delivers on a microtask.
      await Promise.resolve();
    });
    expect(result.current).toBe("dark");
  });
});
```

(If the web package's test setup does not include `@testing-library/react`, check how existing hook tests render — search `renderHook` under `packages/web/src`. If none exists, test through a tiny probe component with `@testing-library/react`'s `render`, which IS in the web devDependencies if other component tests use it; mirror whichever harness `artifact-comments.test.ts` uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/web test use-theme-attribute`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`packages/web/src/lib/use-theme-attribute.ts`:

```ts
import { useSyncExternalStore } from "react";

export type ThemeAttribute = "light" | "dark" | null;

function readThemeAttribute(): ThemeAttribute {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : null;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/**
 * The viewer's explicit theme choice, read from the `data-theme` attribute
 * `lib/theme.ts` stamps on <html>. `null` means the system default: the
 * attribute is absent and prefers-color-scheme governs.
 */
export function useThemeAttribute(): ThemeAttribute {
  return useSyncExternalStore(subscribe, readThemeAttribute, () => null);
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `pnpm --filter @valet/web test use-theme-attribute`
Expected: PASS.

- [ ] **Step 5: Thread the prop through ArtifactFrame**

In `packages/web/src/components/artifact/artifact-frame.tsx`:

1. Add to `ArtifactFrameProps`:

```ts
  /** Viewer theme stamped into the page: explicit choice, or null/undefined for system. */
  theme?: "light" | "dark" | null;
```

2. Freeze the mount-time theme into the srcDoc so a theme flip does NOT remount the frame (script state survives; the runtime restamps instead). Above the existing `srcDoc` memo:

```tsx
const initialThemeRef = useRef(theme);
```

and inside the `buildArtifactDocument` call add `theme: initialThemeRef.current ?? undefined,` (deps unchanged — `theme` deliberately excluded).

3. Keep a live ref and restamp on change, following the file's existing ref pattern (`pickingRef` etc.):

```tsx
const themeRef = useRef(theme);
useEffect(() => {
  themeRef.current = theme;
  if (readyRef.current) {
    post({ type: "valet-artifact:theme", theme: theme ?? null });
  }
}, [theme]);
```

4. In the `valet-artifact:ready` branch (where mode and anchors are posted), also post the current theme so a reloaded srcDoc (republish) picks up a post-mount flip:

```tsx
post({ type: "valet-artifact:theme", theme: themeRef.current ?? null });
```

(`post` posts to `contentWindow` with `"*"` — unchanged.)

5. In `packages/web/src/routes/a.$token.tsx`: `const theme = useThemeAttribute();` in `ArtifactPage`, pass `theme={theme}` to `<ArtifactFrame ...>`. Do NOT pass theme into the `download()` builder — a saved standalone file stays system-themed.

- [ ] **Step 6: Extend the runtime jsdom test**

In `packages/web/src/components/artifact/artifact-runtime.test.ts`, add a case following the file's existing execute-the-runtime harness: dispatch a `message` event with `{ type: "valet-artifact:theme", theme: "dark" }` and assert `document.documentElement.getAttribute("data-theme") === "dark"`, then `{ theme: null }` and assert the attribute is gone. Mirror the event-construction helper the existing cases use verbatim.

- [ ] **Step 7: Run the web artifact suites**

Run: `pnpm --filter @valet/web test artifact`
Expected: PASS (runtime, comments, and any frame tests).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/lib/use-theme-attribute.ts packages/web/src/lib/use-theme-attribute.test.ts packages/web/src/components/artifact/artifact-frame.tsx packages/web/src/routes/a.\$token.tsx packages/web/src/components/artifact/artifact-runtime.test.ts
git commit -m "feat(web): stamp the viewer theme into artifact pages"
```

---

### Task 3: mem_share passes the memory doc's description through

**Files:**
- Modify: `packages/api/src/services/artifacts.ts:114-123` (the `upsertArtifact` call inside `shareArtifact`)
- Test: `packages/api/src/services/artifacts.test.ts`

**Interfaces:**
- Consumes: `readFile` already returns the full `MemoryFileRow` including `description`.
- Produces: memory-sourced artifacts carry `description`; `GetArtifactResponse.description` is non-empty for docs that have one. No wire or tool changes.

- [ ] **Step 1: Write the failing test**

In `packages/api/src/services/artifacts.test.ts`, find the existing `shareArtifact` cases and mirror their setup (they write a memory file via the memory service, then share). Add:

```ts
it("carries the memory doc's description onto the artifact", async () => {
  // Mirror the file's existing writeFile(...) fixture helper; set
  // description: "Weekly deploy metrics." on the written doc.
  const row = await shareArtifact(db, scope, {
    path: "reports/deploys.md",
    orgId,
  });
  expect(row.description).toBe("Weekly deploy metrics.");
});
```

(Copy the concrete `db`/`scope`/`orgId` fixture names from the neighboring tests — do not invent a parallel harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test services/artifacts`
Expected: the new case FAILS with `expected '' to be 'Weekly deploy metrics.'`.

- [ ] **Step 3: Implement**

In `shareArtifact` (`packages/api/src/services/artifacts.ts`), replace the hardcoded empty description:

```ts
  return upsertArtifact(db, scope, {
    key: result.file.path,
    title: result.file.title,
    content: result.file.content,
    format: "markdown",
    description: (result.file.description ?? "").trim().slice(0, 1000),
    icon: "",
    orgId: opts.orgId,
    sourceSessionId: opts.sourceSessionId,
  });
```

(The 1000-char cap mirrors `publishArtifact`'s existing `description` handling. `icon` stays empty: `memory_files` has no icon column.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @valet/api test services/artifacts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/artifacts.ts packages/api/src/services/artifacts.test.ts
git commit -m "feat(api): memory shares carry the doc description onto the artifact"
```

---

### Task 4: artifact_publish from a sandbox file path

**Files:**
- Modify: `packages/api/src/orchestrator/memory-tools.ts` (the `artifactPublishTool` definition)
- Create: `packages/api/src/orchestrator/artifact-publish-tool.test.ts`

**Interfaces:**
- Consumes: `ctx.sandbox: Sandbox` on the engine `ToolContext` (`stat`, `readFile` — precedent: `packages/api/src/engine/security-tools.ts:797`); `ARTIFACT_MAX_CONTENT_BYTES` and `artifactSizeError` from `@valet/shared`; the existing `memoryRequest` HTTP transport in the same file.
- Produces: `artifact_publish` accepts `path` (sandbox file) as an alternative to `content`; `key` becomes optional and defaults to the normalized path. The wire request to `POST /api/artifacts/share` is unchanged (still `key` + `content`), so no API or wire edits.

- [ ] **Step 1: Write the failing tests**

`packages/api/src/orchestrator/artifact-publish-tool.test.ts`. Build the tool via `buildMemoryTools()`, pick the def named `artifact_publish`, and call `execute` with a stub `ToolContext`. Follow this skeleton, filling the ToolContext fields the type requires by copying how other orchestrator tool tests in `packages/api/src/orchestrator/` construct one (search `execute(` in existing `*.test.ts` there; if none constructs a full ToolContext, build the object literally — the type is `ToolContext` from `@valet/engine`, and `sandbox` accepts any object implementing the `Sandbox` interface):

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildMemoryTools } from "./memory-tools";

const publishTool = buildMemoryTools().find((t) => t.name === "artifact_publish")!;

function stubSandbox(files: Record<string, string>) {
  return {
    id: "sb-test",
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    stat: async (p: string) => ({
      isFile: p in files,
      isDirectory: false,
      size: p in files ? Buffer.byteLength(files[p]) : 0,
    }),
    // Remaining Sandbox members: implement as async () => { throw new Error("unused"); }
    // for each required method (readBinary, writeFile, writeBinary, readdir,
    // mkdir, rm, exec) so the object satisfies the interface without `as`.
  };
}
```

Cases:

1. **path publish**: stub `globalThis.fetch` (via `vi.stubGlobal`) to capture the request and return a share response `{ url: "https://x/a/t1", visibility: "org", version: 1 }`; call with `{ path: "/workspace/report.html" }` and a sandbox holding that file with `<title>Deploys</title>` content. Assert the captured body JSON has `key: "workspace/report.html"`, `content` equal to the file bytes, `format: "html"`.
2. **exactly-one-of**: `{ }` (neither content nor path) and `{ path: "/x.md", content: "hi" }` both return tool text containing `exactly one of`.
3. **missing file**: `{ path: "/workspace/nope.html" }` returns text containing `is not a file in the sandbox`.
4. **size cap**: sandbox stat reports `size: 3 * 1024 * 1024`; assert the result names the MiB limit and that `readFile` was never called (spy).
5. **markdown inference**: `{ path: "/notes/summary.md" }` produces `format: "markdown"` in the captured body.

For the ToolContext config, mirror `memoryHeaders`' needs: the tool resolves config via `resolveMemoryConfig(ctx)` — inspect that function at the top of `memory-tools.ts` and provide the `ctx.config` keys it reads (`apiBaseUrl`, `internalToken`, ...) so the handler reaches the fetch stub instead of returning the unavailable text.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @valet/api test artifact-publish-tool`
Expected: FAIL — the schema rejects `path` (unknown arg) or the handler demands `content`.

- [ ] **Step 3: Implement**

In `artifactPublishTool` (`packages/api/src/orchestrator/memory-tools.ts`):

1. Schema changes — `key` becomes optional, `path` added:

```ts
    key: Type.Optional(
      Type.String({
        description:
          "Stable publish key, e.g. 'pages/deploy-dashboard'. Re-publishing the same key updates the same page at the same URL. Defaults to `path` when publishing from a file.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "Path of a file in the sandbox to publish, e.g. '/workspace/report.html'. Pass exactly one of `path` or `content`. Format defaults from the extension: .html/.htm is html, anything else is markdown.",
      }),
    ),
```

(`content`'s description gains: "Pass exactly one of `path` or `content`.")

2. Handler, before the existing fetch. Mirror the file's existing error-return helper for tool text (the same shape the current `"[artifact_error] content is required..."` guard returns):

```ts
const hasContent = typeof args.content === "string" && args.content.length > 0;
const hasPath = typeof args.path === "string" && args.path.length > 0;

let key = args.key;
let content = args.content;
let format = args.format;

if (args.revoke === true) {
  if (!key && hasPath) key = normalizePublishKey(args.path!);
  if (!key) return /* error text */ "[artifact_error] pass `key` (or `path`) to name the page to revoke.";
} else {
  if (hasContent === hasPath) {
    return "[artifact_error] pass exactly one of `content` (inline source) or `path` (a file in the sandbox).";
  }
  if (hasPath) {
    const stat = await ctx.sandbox.stat(args.path!).catch(() => null);
    if (!stat?.isFile) {
      return `[artifact_error] ${args.path} is not a file in the sandbox. Write the page to a file first, then publish it.`;
    }
    if (stat.size > ARTIFACT_MAX_CONTENT_BYTES) {
      const mib = (stat.size / (1024 * 1024)).toFixed(1);
      return `[artifact_error] ${args.path} is ${mib} MiB, over the ${ARTIFACT_MAX_CONTENT_BYTES / (1024 * 1024)} MiB limit. Embed fewer raster images, or draw diagrams as inline SVG instead.`;
    }
    content = await ctx.sandbox.readFile(args.path!);
    const sizeError = artifactSizeError(content);
    if (sizeError) return `[artifact_error] ${sizeError}`;
    if (!format) format = /\.html?$/i.test(args.path!) ? "html" : "markdown";
    if (!key) key = normalizePublishKey(args.path!);
  }
  if (!key) {
    return "[artifact_error] `key` is required when publishing inline content. Pick a stable name like 'pages/deploy-dashboard'.";
  }
}
```

with, near the other module helpers:

```ts
/** A sandbox path as a publish key: strip leading slashes, keep the rest. */
function normalizePublishKey(path: string): string {
  return path.replace(/^\/+/, "");
}
```

3. The fetch body uses the resolved locals: `JSON.stringify({ key, content, title: args.title, format, description: args.description, icon: args.icon, revoke: args.revoke })`.

4. IMPORTANT: return errors through whatever wrapper the existing guard uses (the current tool returns a `ToolResult`; the bare strings above stand in for that exact shape — copy it from the `content is required` guard two lines up). Also update that now-redundant old guard to the new exactly-one-of logic (delete it; the new block replaces it).

5. Update the tool's `description` string: mention publishing from a sandbox file, and keep the existing audience and format guidance sentences verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @valet/api test artifact-publish-tool`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Run the neighboring suites for regressions**

Run: `pnpm --filter @valet/api test memory-tools` and `pnpm --filter @valet/api test integration/artifacts`
Expected: PASS. (The integration suite posts inline publishes; the wire shape did not change.)

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/orchestrator/memory-tools.ts packages/api/src/orchestrator/artifact-publish-tool.test.ts
git commit -m "feat(api): artifact_publish reads a sandbox file via path"
```

---

### Task 5: /artifacts gallery page

**Files:**
- Create: `packages/web/src/routes/artifacts.index.tsx`
- Modify: `packages/web/src/components/layout/top-nav.tsx` (nav link row, ~lines 245-264)
- Test: `packages/web/src/components/layout/top-nav.test.tsx` (extend)

**Interfaces:**
- Consumes: `useArtifacts()` / `useRevokeArtifact()` from `~/api/artifacts`; `ArtifactListItem` (link with `token`, never `url` — `url`'s origin is the api in dev); page scaffold copied from `packages/web/src/routes/events.index.tsx`.
- Produces: route `/artifacts`; a "Artifacts" primary-nav link.

- [ ] **Step 1: Write the failing nav test**

In `packages/web/src/components/layout/top-nav.test.tsx`, mirror an existing link assertion (the file already asserts the presence of primary links) and add one for an `Artifacts` link with `href="/artifacts"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/web test top-nav`
Expected: FAIL — no Artifacts link.

- [ ] **Step 3: Implement the route and nav link**

`packages/web/src/routes/artifacts.index.tsx` — copy the scaffold of `events.index.tsx` (public route conventions do NOT apply; this is an authed page like /events). Structure:

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useArtifacts, useRevokeArtifact } from "~/api/artifacts";
import { relativeTime } from "~/lib/time"; // ← confirm the helper a.$token.tsx uses and import the same one

export const Route = createFileRoute("/artifacts/")({ component: ArtifactsPage });

function ArtifactsPage() {
  const listQ = useArtifacts();
  const revoke = useRevokeArtifact();
  const artifacts = (listQ.data?.artifacts ?? []).filter((a) => !a.revoked);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Artifacts</h1>
        <p className="mt-1 text-sm text-muted">
          Pages you published. A link serves logged-in members of your org unless you made it public.
        </p>
        {/* rows */}
      </div>
    </div>
  );
}
```

Each row (a bordered list item, matching the events page's row styling): `{a.icon} {a.title}` linking to `/a/${a.token}` (Link `to="/a/$token" params={{ token: a.token }}`), then a `text-xs text-muted` meta line with `a.format`, `version {a.sharedVersion ?? a.version}`, `a.visibility` (render `public` in a distinct badge — reuse the badge classes ShareControls uses for its audience state if any, else `rounded bg-ink-wash px-1.5 py-0.5`), `updated {relativeTime(a.updatedAt)}`. Row actions: a Copy-link button (`navigator.clipboard.writeText(a.url)` — the absolute share URL is right for the clipboard) and a Revoke button calling `revoke.mutate({ id: a.id })` behind a `window.confirm("Revoke this link? Viewers get a 404.")`. Empty state: "Nothing published yet. Ask your agent to publish a page, or share a memory doc."

Nav: in `top-nav.tsx`, add `<NavLink to="/artifacts">Artifacts</NavLink>` after the `/memory` link, matching neighbors exactly.

- [ ] **Step 4: Run web tests and typecheck**

Run: `pnpm --filter @valet/web test top-nav && pnpm typecheck`
Expected: PASS. (Route tree regenerates via the vite plugin during dev/build; typecheck of the new route must pass on the committed `routeTree.gen.ts` — if tsc complains about the missing route id, run `pnpm --filter @valet/web dev:routes` if that script exists, else `pnpm --filter @valet/web build` once to regenerate, and commit the regenerated `src/routeTree.gen.ts`.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/artifacts.index.tsx packages/web/src/components/layout/top-nav.tsx packages/web/src/components/layout/top-nav.test.tsx packages/web/src/routeTree.gen.ts
git commit -m "feat(web): artifacts gallery page and nav link"
```

---

### Task 6: Spec update

**Files:**
- Modify: `docs/specs/2026-09-02-artifact-pages-design.md`

**Interfaces:** none (prose only). Strict STE for any procedure text; STE-flavored elsewhere.

- [ ] **Step 1: Amend the spec**

Five edits, each amending the section named:

1. **"The document shell", item 5**: replace the two-state sentence with the three-state contract: light tokens on bare `:root`; the dark media block guarded `:root:not([data-theme="light"])`; a duplicate dark block under `:root[data-theme="dark"]`; the shell stamps `data-theme` when the builder gets a `theme`; unstamped means the system default.
2. **"The picker" postMessage lists**: add `{ type: "valet-artifact:theme", theme }` to the parent → frame list: the viewer restamps the page when the app theme changes. Note the download builder passes no theme, so a saved file follows the reader's system.
3. **"Tool surface"**: document `path` on `artifact_publish` (exactly one of `path` or `content`; format from the extension; `key` defaults to the normalized path; the 2 MiB cap is checked against `stat` before the read). State that the tool reads the file through the session's sandbox handle in-process, and the publish still travels the same HTTP share route.
4. **"Publish" / `mem_share`**: one sentence — a memory share now carries the doc's `description` onto the artifact (capped at 1000 chars); title behavior unchanged.
5. **"Out of scope" table**: delete the `/artifacts` gallery row; add a sentence in "Web surfaces" describing the gallery page (list, open, copy link, revoke).

- [ ] **Step 2: Lint the docs**

Run: `make e2e E2E_ARGS="--only docs-lint"`
Expected: PASS (the spec has a per-file threshold; keep edits in budget).

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-09-02-artifact-pages-design.md
git commit -m "docs(specs): artifact pages — theming contract, path publish, gallery"
```

(If the subject's em dash trips any hook, use: `docs(specs): artifact pages theming, path publish, gallery`.)

---

### Task 7: Full validation and the PR

**Files:** none new (fixes only if the scorecard demands them).

- [ ] **Step 1: Typecheck and targeted suites**

```bash
pnpm typecheck
pnpm --filter @valet/shared test artifact-page
pnpm --filter @valet/api test artifacts
pnpm --filter @valet/web test artifact
```

Expected: all PASS.

- [ ] **Step 2: Full e2e scorecard**

```bash
make e2e 2>&1 | tee /tmp/e2e-artifacts-memory-theming.log
```

Capture the FULL output — never pipe through tail/head/grep. Expected: clean scorecard except the two known machine-environment rows (`store-postgres` local and `sandbox-k8s`), which fail identically on clean dev-v2. Any other red row: re-run in isolation (`make e2e E2E_ARGS="--only <suite-id>"`) before treating it as real (pool-contention flakes are known); a genuine failure gets fixed and committed before proceeding.

- [ ] **Step 3: Push and open the PR**

```bash
say "YubiKey tap needed"
git push -u origin feat/artifacts-memory-theming
gh pr create --repo tkhq/valet --base conner/artifact-pages \
  --title "Artifacts: file publishing, viewer theming, memory metadata, gallery"
```

PR body constraints (CI-linted): 300 words max, no em or en dashes, no marketing words, a filled Validation section naming the e2e result and the two known red rows. Structure: What (the four deltas, one line each), Why (one short paragraph: parity with the artifact model the spec adopted, and memory shares as first-class producers), Validation (typecheck, targeted suites, full e2e scorecard summary). Note in the body that the PR is stacked on #539 and retargets to dev-v2 when #539 merges. Do NOT add session links or AI co-author trailers.

- [ ] **Step 4: Report**

Report the PR URL, the scorecard summary, and any deviations from this plan.
