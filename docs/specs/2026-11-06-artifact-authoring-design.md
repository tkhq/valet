# Artifact authoring MVP

Date: 2026-11-06
Status: implemented
Extends: `2026-09-02-artifact-pages-design.md`

## Product

Create artifact opens a template chooser in the workspace gallery. Document starts a Markdown project brief. HTML Page starts a self-contained page. Creation uses the existing publisher, scoped to the selected workspace, and a fresh authorized conversation. The editor pairs the existing conversation with the sandboxed preview. Only these two formats appear as supported choices.

Select preview text or pick an element, describe the change, and send it to Valet. The request identifies the artifact, base revision, and exact source fragment. Source selection is available when rendered text cannot map uniquely to source. The server rejects stale or ambiguous selections. A persisted edit request bounds the agent's replacement to that fragment. The agent uses an artifact edit tool; the server checks the base revision again and appends the result. Other source bytes stay unchanged. Polling refreshes the managed preview while the conversation runs.

Revision history previews previous source and rendered snapshots. Restore appends a copy as a new revision after checking the current revision. It preserves token, visibility, provenance, and the shared revision pin. The editor labels the latest working revision and the shared pin separately. Public readers continue to see only the served snapshot.

## Reuse and boundaries

Reuse artifact rows, immutable version rows, comment rows, publish compilation, manager and workspace checks, source-thread authorization, and AssistantPanel. Persist bounded edit requests as structured artifact comments, with the selected revision and source offsets. No new tables or credentials reach the browser.

The iframe retains its opaque origin, sandbox flags, and CSP. Selection messages carry untrusted text and element context only. The server checks every source range. Management reads, restores, and agent edits require the current workspace permissions and source visibility. Anonymous readers receive no editing surface. Creation uses current organization/team sharing defaults and explains the audience.

Authoring request rows stay out of ordinary comment responses. Historical bodies and restores require the revision's recorded author, including for org admins. Existing versions lack source provenance, so another publisher's history fails closed. Legacy artifacts without a linked source thread support preview and restore only. New templates always create a linked conversation.

## Foundation and follow-up

A typed template registry separates template identity from source format. Existing format compilation and revision storage remain the extension seam. Slides need a renderer and editing model before becoming a template. Team design systems need versioned assets and access rules. Dashboards need server-side integration queries, consent, refresh metadata, and filtered data responses. Per-version provenance can permit broader historical management. These are proposed follow-up work, not MVP features.

## Validation

Test creation scope, selection replacement boundaries, stale revisions, ambiguous source, restore history, audience/pin preservation, denied workspace/source access, and iframe message validation. Run targeted suites, typecheck, the repository e2e scorecard, and the actual local browser flow. Obtain an independent code review. No deployment is part of this work.

## References

- https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- https://support.claude.com/en/articles/14604416-get-started-with-claude-design

The useful patterns are template-led creation, a conversation beside the artifact, and selection-based refinement. Valet retains its own access and snapshot semantics.
