# Passkey Approvals and Per-Commit Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any decision gate can require a passkey tap that Turnkey verifies, and commit signing defaults to the person's passkey stamping each commit signature, with the person registering their key on GitHub themselves.

**Architecture:** A gate asks for `presence` through `context.assurance`. The engine refuses an approving resolution without presence evidence. A new api endpoint hands the browser one Turnkey `SIGN_RAW_PAYLOAD_V2` body per step, forwards the passkey-stamped body to Turnkey, checks the completed activity, and resolves the gate after the last step. `turnkey.sign_commits` uses this to sign a commit chain and rewrites the branch in the sandbox.

**Tech Stack:** TypeScript, Hono, React 19, `@turnkey/sdk-server` 8.9, `@turnkey/sdk-browser` 8.8 (`WebauthnStamper`), Node `crypto` (Ed25519 verify, SHA-1/256/512), vitest.

**Spec:** `docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`

## Global Constraints

- Assurance values: `"session" | "presence"`. A gate asks with `context.assurance = "presence"`.
- Every passkey step is `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`, `encoding: "PAYLOAD_ENCODING_HEXADECIMAL"`, `hashFunction: "HASH_FUNCTION_NOT_APPLICABLE"`, in the approver's sub-organization, `signWith` = their signing key id.
- Step body timestamp must be at most 5 minutes old.
- Challenge payload: SHA-256 of the UTF-8 join with `\n` of `valet-approval`, sessionId, gateId, title, body.
- Git payload: `SSHSIG` signed data, namespace `git`, hash `sha512`.
- At most 10 commits per `turnkey.sign_commits` call. SHA-1 object format only.
- Deployment mode: `VALET_TURNKEY_SIGNING_ASSURANCE` = `presence` (default) or `session`.
- Every user-facing error names the fix (CLAUDE.md). No `any`, no double casts.
- `tkhq/valet` is public: no private names in code, comments, or commits.

## Review Focus

- A Slack or API Approve click on a presence gate: refused with "approve with your passkey in Valet"; the gate stays pending. (Task 1 test, Task 3 test)
- A stamped body whose payload differs from the issued step (replayed step 1 for step 2): refused before forwarding to Turnkey. (Task 3 test)
- A merge commit in the range: both parents remap; the rewritten hash matches `git hash-object`. (Task 4 test)
- A person enrolled under the shipped design (no signing key): the action and Settings say "set up again". (Task 5 test)
- A teammate who did not ask opens the presence endpoint: 403. (Task 3 test)

---

### Task 1: Engine presence check

**Files:**
- Modify: `packages/engine/src/types.ts` (DecisionResolution), `packages/engine/src/session.ts` (resolveDecision)
- Create: `packages/engine/src/gate-assurance.ts`
- Test: `packages/engine/test/gate-assurance.test.ts`

**Interfaces:**
- Produces: `type ApprovalAssurance = "session" | "presence"`; `gateAssurance(gate: { context?: Record<string, unknown> }): ApprovalAssurance`; `PresenceEvidence = { kind: "turnkey_activity"; organizationId: string; activityIds: string[] }`; `DecisionResolution.assurance?: ApprovalAssurance`, `DecisionResolution.evidence?: PresenceEvidence`; `presenceRefusal(gate: DecisionGate, resolution: DecisionResolution): string | null`; `PRESENCE_REQUIRED_MESSAGE`; `class PresenceRequiredError extends Error`. All exported from `@valet/engine`.

- [ ] Test: `presenceRefusal` returns the message for an approving action (`approves: true` or id `approve`) without `assurance: "presence"`, null for reject, null for a session gate, null with presence evidence. Test that `Session.resolveDecision` throws `PresenceRequiredError` and leaves the gate pending.
- [ ] Implement; `Session.resolveDecision` reads the gate with `store.getDecisionGate` first.
- [ ] `pnpm --filter @valet/engine test gate-assurance` passes; commit.

### Task 2: Gate surfaces honor presence

**Files:**
- Modify: `packages/api/src/engine/bridge.ts`, `packages/api/src/wire/types.ts` (DecisionGate gains `assurance?: "presence"`, `presence?: PresenceGateView`), `packages/api/src/routes/messages.ts` (resolve route pre-check, 400), `packages/api/src/channels/host.ts` (card drops approving actions and adds the note; callback refuses), `packages/web/src/components/home/bulk-answers.ts` (skip reason)
- Test: existing `bridge`, `messages` resolve, `host` gate tests, `bulk-answers` tests

**Interfaces:**
- Produces: `PresenceGateView = { kind: "challenge" } | { kind: "git_commits"; repo: string; branch: string; commits: Array<{ sha: string; subject: string; author: string }> }`.

- [ ] Tests: wire carries `assurance`/`presence`; resolve route answers 400 with `PRESENCE_REQUIRED_MESSAGE` for approve; Slack card for a presence gate has no approving button; bulk answers skip presence gates.
- [ ] Implement; commit.

### Task 3: Passkey step endpoint

**Files:**
- Create: `packages/api/src/services/presence/steps.ts`, `packages/api/src/services/presence/turnkey-forward.ts`, `packages/api/src/routes/decision-presence.ts`
- Modify: `packages/api/src/routes/messages.ts` (mount `GET|POST /:id/decisions/:gateId/presence`)
- Test: `packages/api/src/services/presence/steps.test.ts`, `packages/api/src/routes/decision-presence.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; Task 4 `commitChainStep`.
- Produces: `GET` → `{ done: false; index: number; total: number; label: string; body: string; rpId?: string } | { done: true }`; `POST { body: string; stampHeaderName: string; stampHeaderValue: string }` → same shape. Steps kept in plugin store session scope, collection `presence_steps`, key gateId: `{ signatures: Array<{ activityId: string; signatureHex: string }> }`.

- [ ] Tests: wrong caller 403; tampered payload 400 without a Turnkey call; old timestamp 400; activity not approved by the passkey user refused; bad signature refused; last step resolves the gate with `assurance: "presence"` and evidence.
- [ ] Implement forward as `POST {apiBaseUrl}/public/v1/submit/sign_raw_payload` with the stamp header; poll `getActivity` with the parent key when not completed.
- [ ] Commit.

### Task 4: Git commit chain and SSHSIG

**Files:**
- Create: `packages/plugin-turnkey/src/commits.ts`
- Modify: `packages/plugin-turnkey/src/ssh.ts`
- Test: `packages/plugin-turnkey/src/commits.test.ts`, `packages/plugin-turnkey/src/ssh.test.ts`

**Interfaces:**
- Produces: `sshsigSignedData(message: Uint8Array): Buffer`; `armorSshSignature(publicKeyHex: string, signature: Buffer): string`; `gitObjectId(object: string): string`; `planCommitChain(input: { commits: Array<{ sha: string; object: string }>; committerEmail: string; signatures: Buffer[]; publicKeyHex: string }): { rewritten: Array<{ oldSha: string; newSha: string; object: string }>; nextPayload?: Buffer }`.

- [ ] Tests: `gitObjectId` matches `git hash-object -t commit`; a signature from a local Ed25519 key over `sshsigSignedData` verifies with `ssh-keygen -Y verify`; a merge commit remaps both parents; committer email replaced, name and time kept; old `gpgsig` stripped.
- [ ] Implement; commit.

### Task 5: Enrollment key, modes, GitHub check

**Files:**
- Modify: `packages/plugin-turnkey/src/{config,store,enrollment,gate,github-keys}.ts`, `packages/api/src/routes/commit-signing.ts`, `packages/api/src/wire/types.ts`, `packages/api/src/engine/signing-key-sweep.ts`
- Test: matching `*.test.ts`

**Interfaces:**
- Produces: `TurnkeyDeploymentConfig.assurance: ApprovalAssurance`; `EnrollmentDoc.mode`, `EnrollmentDoc.signingKey?: { privateKeyId: string; publicKeyHex: string; publicKey: string; fingerprint: string }`, agent fields optional; `githubAccount(token).login()`, `.noreplyEmail()`, `publicSigningKeyListed(login: string, publicKeyLine: string): Promise<boolean>`; route `POST /api/me/commit-signing/github-check` → `{ listed: boolean; login?: string }`; GET adds `mode`, `signingKey`, `needsReenroll`.

- [ ] Tests: presence enrollment creates the key, no `valet-agent`, no parent policy, parent leaves quorum; session enrollment's parent policy names the agent user id and excludes `CREATE_PRIVATE_KEYS_V2`; re-enroll allowed when `signingKey` is missing; sweep no longer calls GitHub.
- [ ] Implement; delete `create`/`remove` and `GITHUB_PERMISSION_MESSAGE`; commit.

### Task 6: Signing actions

**Files:**
- Modify: `packages/plugin-turnkey/src/actions/actions.ts`, `packages/plugin-turnkey/skills/commit-signing/SKILL.md`
- Test: `packages/plugin-turnkey/src/actions/actions.test.ts`

**Interfaces:**
- Produces: action `turnkey.sign_commits { repo, branch, base, path? }` → `{ success, data: { commits: Array<{ old, new }>, next } }`; gate context `{ assurance: "presence", presence: { kind: "git_commits", repo, branch, commits }, signing: { commits: [{ sha, object }], committerEmail, publicKeyHex, privateKeyId, subOrgId, passkeyUserId } }`.

- [ ] Tests: refuses >10 commits, unlisted GitHub key, missing enrollment key; on approval writes objects, checks hashes, `update-ref`; `request_signing_key` refuses in presence mode and uses the enrollment key in session mode with no GitHub writes.
- [ ] Implement; commit.

### Task 7: Web

**Files:**
- Create: `packages/web/src/components/session/presence-approval.tsx`, `packages/web/src/components/settings/signing-key-modal.tsx`
- Modify: `packages/web/src/components/session/decision-gate-card.tsx`, `packages/web/src/components/settings/commit-signing-section.tsx`, `packages/web/src/api/commit-signing.ts`, `packages/web/src/api/client.ts`
- Test: `presence-approval.test.tsx`, `commit-signing-section.test.tsx`

- [ ] Tests: card lists commits and shows "Sign with passkey"; loops GET/stamp/POST until done; Settings shows the key and the GitHub check; "Set up again" when `needsReenroll`.
- [ ] Implement with `WebauthnStamper` from `@turnkey/sdk-browser`; commit.

### Task 8: Specs and verification

- [ ] Add the "Changed by" note to `docs/specs/2026-09-12-agent-commit-signing-design.md`; copy the design spec onto this branch.
- [ ] `pnpm typecheck`; targeted suites for engine, plugin-turnkey, api, web; docs lint.
