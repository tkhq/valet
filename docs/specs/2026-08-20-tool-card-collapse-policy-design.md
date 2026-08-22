# Tool-card collapse policy

Date: 2026-08-20
Status: implemented
Packages: `web` (`packages/web/src/components/session/tool-renderers/tool-shell.tsx`, `packages/web/src/lib/preferences.ts`, `packages/web/src/routes/settings.appearance.tsx`)
Ticket: [TKAI-199](https://linear.app/turnkey/issue/TKAI-199)

## Why

`ToolShell` is the chrome around every tool call in a session — bash,
read, write, edit, thread, and every `call_tool` plugin action. Long
threads accumulate completed cards. The shell already mounted completed
cards collapsed to keep the chat dense, and that read ran once, at
mount, off a `useState(status !== "completed")` initialiser. Two gaps
broke that promise.

First, a card that mounted while `running` and then transitioned to
`completed` stayed expanded. Nothing synchronised `expanded` to the new
`status`. A chat that felt tidy at load slowly filled with expanded
completed cards as new tool calls streamed in.

Second, the policy was fixed. Some users want every card collapsed on
mount, running included. Others want every card expanded. The single
mount-time read did not fit either group.

This spec pins the policy down: a preference key, a documented
interaction matrix, and one auto-collapse effect that respects an
explicit user toggle.

## What changes

`ToolShell` now reads a per-browser preference at mount and applies one
of three policies. It also runs an effect on `[status]` that
auto-collapses a `running→completed` transition unless the user touched
the card (header click or body pointer-down) while it was running.

The preference module `packages/web/src/lib/preferences.ts` exposes
`getToolCardDefault()` and `setToolCardDefault()`. Both accessors take an
injectable `storage` that defaults to the shared `safeLocalStorage()` shim
(`packages/web/src/lib/safe-storage.ts`, extracted from `theme.ts` and
`command-recency.ts`). The shim tolerates an unavailable or hostile
localStorage: it degrades to an in-memory Map, reads fall back to `smart`,
and writes swallow quota and permission errors.

Two supporting fixes keep the per-card state trustworthy:

- `message-item.tsx` keys tool_call parts by their stable `callId`. An
  index key hands one call's expansion and user-touch state to a
  different call whenever the parts array shifts (streaming sweep,
  `message_update` replacement).
- Each card derives its body element id from `useId()`. `toolName`
  repeats across calls in a thread, so a name-derived id duplicated, and
  `aria-controls` is set only while the body is mounted.

A toggle for the preference lives on `/settings/appearance`
(`packages/web/src/routes/settings.appearance.tsx`), under a "Chat density"
subsection alongside the light/dark and color-palette choices. The toggle is
three `RadioCard`s — one per policy value. It writes through
`setToolCardDefault`, so no new persistence path is introduced.

## Contract

- Storage: `localStorage`, per browser. No server sync.
- Key: `tool-card-default`.
- Values: `smart` (default), `always-collapsed`, `always-expanded`.
- Absent key: resolves to `smart`.
- Unknown stored value: resolves to `smart`, without a thrown error, and
  self-heals on the next write.

## Interaction matrix

The rows are the card's current `status`. The columns are the policy in
effect at mount. The cells report the mount-time `aria-expanded` value.

| Status      | smart    | always-collapsed | always-expanded |
| ----------- | -------- | ---------------- | --------------- |
| streaming   | true     | false            | true            |
| running     | true     | false            | true            |
| completed   | false    | false            | true            |
| error       | true     | true (override)  | true            |

After mount, one effect runs on every `status` change. It respects a
`userTouched` ref that flips true on the first pointer interaction with
the card — a header click or a pointer-down inside the body. Body
interactions count because a user expanding truncated output or
selecting text mid-run must not lose the body to the auto-collapse.

| Transition            | userTouched | smart action        | always-collapsed action | always-expanded action |
| --------------------- | ----------- | ------------------- | ----------------------- | ---------------------- |
| running → completed   | false       | collapse            | leave (already closed)  | no-op                  |
| running → completed   | true        | leave (user choice) | leave (user choice)     | no-op                  |
| streaming → completed | false       | collapse            | leave                   | no-op                  |
| any → error           | any         | force expand        | force expand            | force expand           |
| completed → running   | any         | leave               | leave                   | no-op                  |

Errors are the only override, and they override every policy and every
prior toggle. A user who set `always-collapsed` — or who manually
collapsed a card under `always-expanded` — still needs to read the
message that names the corrective action, so an error card opens and
never auto-collapses. In the effect, the error branch therefore runs
before the `always-expanded` no-op.

## Non-goals

- No server sync. The preference is per browser, matching V1's
  `thread-sidebar-collapsed`.
- No `packages/client` change. Legacy V1 keeps its stricter
  `ToolCardExpansionIntentContext` policy.
- No new animation. `prefers-reduced-motion` users see no visual
  change from this fix; the shell only reads and writes state.
- No cross-mount memory of a card's expansion. State lives in the
  mounted card, so a thread switch remounts every card under the
  mount-time policy. The `callId` key keeps state with the right call
  while the list is mounted; it does not survive an unmount.

## Deviations

- Preference reads are lazy `useState` initialisers, not live listeners.
  A preference change from the Appearance toggle takes effect on the next
  tool card mount, not on already-mounted cards. This matches
  `thread-sidebar-collapsed` and avoids the storage-event listener a
  live subscription would need.
- The `streaming→completed` edge is treated the same as
  `running→completed`. The engine emits `running` between them in the
  common path, so the edge is rare; treating both the same keeps the
  effect one branch smaller and matches the user's mental model — the
  args are done and the result is in.

## Class-of-bug note

The pre-fix code was `useState(status !== "completed")`. State
initialised from a prop at mount was correct at t=0 and wrong the
moment `status` transitioned. The fix is a paired `useEffect` that syncs
on the prop and respects a `userTouched` ref for the manual-override
gate. That pattern is now recorded in `CLAUDE.md` under "Rules learned
the hard way" so the next reviewer catches the shape before it ships.
