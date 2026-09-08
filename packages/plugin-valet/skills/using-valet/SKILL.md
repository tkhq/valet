---
name: using-valet
description: Answer questions about Valet product capabilities. Use for "can Valet do X", "does Valet support", "does Valet support workflows", "how do I use Valet", or "what features does Valet have". Do not use for Valet development or a specific integration.
---

# Using Valet

Use this skill to answer questions about Valet product capabilities. Do not use it to develop Valet. For development, read `CLAUDE.md`. Do not use it for a specific integration. Use that integration's skill instead.

If a limitation affects the answer, state it before the answer. If you cannot read the repository at the required ref, say so. Do not imply that you read documentation that you cannot access.

## Research rules

1. Pin every product research claim to `tkhq/valet@dev-v2`.
2. Do not use `main` for product answers. It is the frozen legacy stack: Cloudflare Worker, Modal sandboxes, and D1.
3. Read `CLAUDE.md`, then `docs/architecture.md`, then relevant dated `docs/specs/YYYY-MM-DD-<topic>-design.md` files.
4. Read each dated spec's scope and status. Check the packages it references. Treat a spec as current only when it describes v2 packages. A current spec can be Draft or Proposed. Do not treat it as shipped status.
5. Treat undated specs as legacy. Treat `docs/plans/` as proposals.
6. Confirm every capability in code before you say that it exists.
7. Check `packages/plugin-*/plugin.yaml`. `enabled: false` excludes a plugin from the generated bundled registry. It does not guarantee that the plugin is unavailable at runtime.
8. Check `packages/workflow/` for the DAG interpreter.
9. Check `packages/api/src/routes/` for the API surface.
10. Check `packages/web/` for the UI surface.
11. Never cite `packages/client`, `packages/worker`, `packages/runner`, or `backend/` as current. They are frozen legacy code.

## Answer rules

Give each capability claim a `path@dev-v2` citation. If you cannot find a supporting path, say "I do not know." Do not describe plausible functionality as a fact.

The current primitive set includes:

- `dag/v1` workflows with nodes, edges, conditional edges, and approval gates. Approval gates suspend a run pending human sign-off.
- Skills written as markdown.
- Plugins that provide integrations.
- Sessions, threads, and child sessions.

Confirm the exact feature before you claim it. The primitive list does not prove every proposed feature is shipped.

## Worked example: vendor review workflow

Wrong path: Read architecture prose and invent a vendor-review feature.

Right path:

1. Pin research to `tkhq/valet@dev-v2`.
2. Read `CLAUDE.md` and `docs/architecture.md`.
3. Confirm the workflow primitive in `packages/workflow/` and the dated workflow design spec.
4. Answer with citations, for example `packages/workflow/src/interpreter.ts@dev-v2` and `docs/specs/2026-07-16-workflows-overhaul-design.md@dev-v2`.
5. Name missing pieces. Do not claim that a vendor-review template, integration, or UI exists until code confirms it.
