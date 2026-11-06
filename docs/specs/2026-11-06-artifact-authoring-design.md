# Artifact authoring MVP

Date: 2026-11-06
Status: implemented
Extends: `2026-09-02-artifact-pages-design.md`

## Product

Create artifact opens a template chooser in the workspace gallery. Document starts a Markdown project brief. HTML Page starts a self-contained page. Creation uses the existing publisher, scoped to the selected workspace, and a fresh authorized conversation. The editor keeps the existing team sidebar and pairs the linked conversation with a larger sandboxed preview. Conversation and artifact headers share the navigation height. The artifact title stays in one row, with preview/source and download actions in a quiet footer. Only these two formats appear as supported choices.

Select preview text or pick an element, choose Edit with Valet, and describe the change in the existing conversation input. Selection does not steal focus until the person chooses that action. The selected fragment appears as context above the same message field; failed delivery retains the fragment and draft. The request identifies the artifact, base revision, and exact source fragment. Source selection is available when rendered text cannot map uniquely to source. The server rejects stale or ambiguous selections. A persisted edit request bounds the agent's replacement to that fragment. The agent uses an artifact edit tool; the server checks the base revision again and appends the result. Other source bytes stay unchanged. Polling refreshes the managed preview while the conversation runs.

Revision history previews previous source and rendered snapshots. Restore appends a copy as a new revision after checking the current revision. It preserves token, visibility, provenance, and the shared revision pin. The footer version menu opens revision history and explains whether the shared view follows the latest revision or a pin. Historical previews show Back to latest and an explicit restore action. Public readers continue to see only the served snapshot.

Broad requests use the same conversation input and include the current source as agent context. The editor fetches a fresh authorized snapshot before sending and keeps its session/thread binding. Full-source requests are limited to 100,000 characters; larger artifacts direct the person to selection editing. This path can update the complete artifact. Only the selection path guarantees unchanged source outside the chosen fragment.

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

The reference interaction is: start from chat or a template, open the artifact beside the conversation, highlight text, choose Edit with Claude, and type the change in chat. The revised editor follows that sequence with Edit with Valet and one composer. Broad requests use that same conversation. Version selection and recovery stay near the artifact rather than taking a permanent panel. The current Claude guides and public demo informed this flow; a signed-in Claude session was not part of browser validation.

Valet retains its team sidebar, workspace navigation, agent execution controls, access rules, and snapshot semantics. This MVP does not implement Claude Docs direct editing or Claude Design's slides, design-system import, or integration-backed output.
