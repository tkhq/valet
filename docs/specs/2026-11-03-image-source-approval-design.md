# Image-source changes need a second admin

**Status:** implemented 2026-11-03. **Code:** `packages/api/src/bakes/source-change-requests.ts`, `packages/api/src/routes/sources.ts`, `packages/web/src/components/settings/source-changes-panel.tsx`.

## Context

An image source decides what code runs in every sandbox built from it: the image it starts FROM, its setup commands, and the base that a repository image inherits. On 2026-11-02 one org admin account on a new instance created image sources and changed the built-in base's setup commands to run an encoded script in every later bake. No second person saw the change. The post-mortem asks for second-admin approval of image-source changes.

## Decisions

1. **What waits.** A create (`POST /api/org/sources`) and a patch that touches a content field (`name`, `setupCommands`, `externalRef`, `parentId`, `pullSecretName`) become a pending change request. The route validates the body first, so a request holds a valid row or patch. The response is 202 `{ pendingChange }`. Nothing reaches `image_sources` yet.
2. **What applies at once.** A patch of only `enabled`, `schedule`, or `sandboxResources` applies at once. These fields do not change what an image runs.
3. **Bakes.** A source's content cannot change without approval, so a manual bake (`POST /:id/bake`) always builds approved content and needs no second approval. Repository sources take their build steps from the repository; write access to the repository is that trust boundary.
4. **Who approves.** Any org admin other than the requester approves (`POST /changes/:id/approve`) or rejects (`POST /changes/:id/reject`). Only the requester withdraws (`DELETE /changes/:id`). The requester cannot approve or reject the own request.
5. **Stale requests.** A request stores the source's `updated_at`. Approval refuses with 409 when the source changed or was deleted after the request. A request expires after 7 days. One target holds at most one pending request (unique index on `org_id, target_key`).
6. **Notification.** The request routes an `approval` attention item to every other org admin (inbox, plus the admin's channel tiers). A decision marks those items read.
7. **Single-admin organizations.** With no second admin, the request is refused with 409 and a message that names both fixes: add a second org admin, or set `VALET_IMAGE_SOURCE_APPROVAL=off`. A pending request that nobody can approve helps no one.
8. **Override.** `VALET_IMAGE_SOURCE_APPROVAL=off` turns the gate off. Any other value keeps it on, so a typo cannot turn it off. The api logs a `[security]` warning at boot when the gate is off.
9. **Reuse.** The engine decision gate serves agent tool calls inside a session and does not fit an admin REST change. The flow follows the team deletion request pattern (`services/team-deletion-requests.ts`): a request table, a different decider, and attention routing.

## Limits

- Rows created or changed before this gate are not re-reviewed.
- The built-in sources (`stock-full`, `default-full`) are code-managed in a separate change and refuse API edits.
- Decisions write `[security]` log lines. The admin audit log records them when it lands.
