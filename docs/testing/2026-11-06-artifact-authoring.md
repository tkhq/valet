# Artifact authoring validation

Date: 2026-11-06
Base: `dev-v2`, rebased onto `4a8962f80`.
Environment: Node 24, macOS, separate worktree database and ports.
No production deployment or integration configuration changed.

## Focused checks

| Check | Result |
| --- | --- |
| Authoring, rendering, templates, gallery and client web tests | 83 passed across 9 files |
| Final API, revision, selection and agent tool regressions | 36 passed across 4 files |
| Existing artifact privacy, source, publishing and memory-tool coverage | 124 passed across 10 files |
| Shared artifact document and CSP tests | 43 passed |
| Root typecheck, web build and API bundle | Passed |
| Independent code review | No remaining findings |

The independent review found three issues that now have regression coverage: working source in comment responses, another publisher's historical source, and preview text matching unrelated source.

## Browser checks

The local browser used the real API, database, conversation component and agent. The API kept the model credential server-side.

1. Create a Document from the gallery. Its template opens in the managed editor.
2. Pick a paragraph and request replacement text. The agent uses `artifact_edit`; working version 2 appears without reloading.
3. Preview version 1 and confirm Restore. Version 3 contains the original paragraph; version 2 remains in history.
4. Create an HTML Page. Pick its heading and request italic styling. Only that element changes.
5. Select one rendered word and replace it. The heading changes; its italic style and surrounding page stay unchanged.
6. Reload the editor. The artifact, conversation and revision history remain available.
7. Check 1280px, 760px and 375px widths. Desktop shows the conversation beside the preview. Compact layouts switch panes without horizontal overflow.

Empty selections disable Send edit. Automated tests cover ambiguous selections, stale revisions, delivery errors, denied source access and shared-pin preservation.

## Repository scorecard

The initial full `make e2e` run completed: 22 passed, 6 failed, 9 skipped. The full output was retained locally.

The first run overlapped implementation. Its two authoring assertions and typecheck errors were corrected and passed in final reruns.
The remaining failures were traced separately:

- Three convention violations already exist in unchanged tests: `api/src/bakes/source-service.test.ts`, `sandbox-kubernetes/test/provider.test.ts`, and `workflow/src/dag/validate.test.ts` under `packages/`.
- Local skill tests need GNU `chmod`; macOS BSD `chmod` rejects the existing `chmod 700 --` invocation.
- Four checkpoint tests passed alone with their original five-second timeout.
- The GitHub REQUEST_CHANGES test passed alone with unchanged timeouts.
- The 100,000-row usage export passed alone in 14.79 seconds, within its original 60-second timeout.
- The Keycloak fixture defaults to password-only authentication. Its complete flow passed with the process-only `AUTH_METHODS=password,oidc` override.

Credential-gated suites were skipped by the canonical runner. Browser authoring separately exercised three real agent edits.
The final serial scorecard result is recorded in the pull request.

## Limits and follow-up

Preview selections that cross formatting, entities or ambiguous source require selection in Source. Legacy artifacts without a source thread support preview and restore only.
Historical bodies require their recorded author because old versions lack source-conversation metadata. This also applies to org admins.
Slides, team design systems, per-version provenance and integration-backed dashboards remain proposed work.
