# Agent commit signing

**Date:** 2026-09-12
**Status:** Proposed (Phase 1 in progress)
**Relates to:** `docs/specs/2026-09-01-sandbox-secret-broker-design.md`, `docs/specs/2026-08-02-sandbox-reconcile-design.md`, `docs/plans/2026-03-06-ssh-2of2-commit-signing-design.md` (superseded)
**Supersedes:** the TVC signer kernel spec in `tkhq/test-tvc-signer-kernel` (`spec/v1-draft`)

## Purpose

Give commits an agent makes in a Valet sandbox a GitHub "Verified" badge, after one human approval per pull request, with a durable record of who approved what.

## Decision

1. **The signing key lives in Turnkey. The sandbox signs through `tk`.** Valet creates one Ed25519 private key in Turnkey per approved pull request. Git in the sandbox uses `tk ssh git-sign` as its SSH signing program. Each commit signature is one `SIGN_RAW_PAYLOAD_V2` activity, stamped by a session API key that expires with the approval window. No private key material enters the sandbox or the Valet api process.

2. **One Turnkey sub-organization per Valet user.** The user's passkey is the root user. A second user, `valet-agent`, holds the session API keys. Policies let `valet-agent` do one thing: sign with a private key that carries the `agent-signing` tag.

3. **Approval is a Valet decision gate in Phase 1.** The `turnkey.request_signing_key` action opens a `credential_request` gate. Its body names the repository, the branch, and the window. Approve creates the key, registers its public half on the user's GitHub account, and returns. Phase 2 moves the approval to Turnkey consensus stamped by the passkey.

4. **Keys are disposable.** GitHub keeps a commit's Verified status after the signing key is deleted, and has no limit on signing keys per account. When the window ends or the pull request closes, Valet deletes the GitHub key and the Turnkey session API key. The Turnkey private key and its activities stay as the issuance record.

## What changed from the earlier plans

The kernel spec (`test-tvc-signer-kernel`) put a remote signer in a TVC enclave. Its repo and branch checks ran on caller-supplied claims, and its commit counter reset on restart. Neither enforced more than "this human approved this agent to sign on this branch for this window." Turnkey policy cannot read raw payload bytes (mono `src/rust/policy/src/evaluator/values.rs:1537`), so native policy could not replace it either.

The plan that replaced the kernel (`.plans/agent-commit-signing-v1.md`) exported an OpenSSH private key from Turnkey Secrets into sandbox tmpfs. That path transits the key through Valet api memory at generation and leaves a private key on the runner for the window.

`tk ssh git-sign` already exists in `tkhq/tk` (`auth/src/git_sign.rs`). It removes both costs: the key never leaves Turnkey, and each signature is its own audited activity. The sandbox already needed `tk` for the export path, so the image cost is the same. The spike in this document confirms it works from git.

## Threat model

The sandbox is trusted for the approval window. Prompt injection on the runner can produce Verified commits on the approved branch until the window ends or the session key is deleted. Mitigations: a short window (2 h default, 24 h cap), one key per pull request, deletion on merge or close, and one Turnkey activity per signature that names the session.

What the design does enforce:

- A commit is signed only after a human approved that repository, branch, and window.
- The session API key can sign with `agent-signing` keys only. It cannot create keys, change policies, export anything, or act outside its sub-organization.
- The signing key is unusable after the window: the session API key has expired and the GitHub key is gone.
- Every signature is a Turnkey activity with the session key's user and the private key id. Every key issuance is a `CREATE_PRIVATE_KEYS_V2` activity.

What it does not enforce:

- That the signed payload is a git commit, or that it is on the approved branch. Turnkey signs raw bytes.
- A commit count. `tk` cannot count across invocations without local state that the sandbox owns. The gate does not promise a count.

## Flow

```
Valet web (passkey)      Valet api                      Turnkey sub-org            Sandbox
     |                       |                                |                       |
 1. Settings: "Set up commit signing" -> CREATE_SUB_ORGANIZATION_V7                   |
     |   passkey = root user, valet-agent user, tags, policies                         |
     |                       |                                |                       |
 2. session prep ---------> CREATE_API_KEYS_V2 on valet-agent   <-- tk api-key generate (P-256, private half stays in sandbox)
     |                       |  expiration_seconds = session window                    |
     |                       |                                |   --> TURNKEY_* env + git config
 3. PR ready: agent calls turnkey.request_signing_key(repo, branch, window_minutes)   |
     |   <-- credential_request gate: "Sign commits in {repo}, branch {branch}, for {window}?"
 4. Approve ------------> CREATE_PRIVATE_KEYS_V2 (Ed25519, tag agent-signing)          |
     |                     POST /user/ssh_signing_keys (title names session and PR)    |
     |                     plugin_store: signing_keys row                              |
     |                                                                                 |
 5.                                                              <-- git commit -S: tk ssh git-sign -> SIGN_RAW_PAYLOAD_V2
 6. PR merged / window end -> DELETE /user/ssh_signing_keys/{id}, DELETE_API_KEYS, row closed
```

## Components

### `packages/plugin-turnkey`

A v2 plugin. It holds the Turnkey client (`@turnkey/sdk-server` behind a `TurnkeyOps` interface with a fake for tests), the two actions, the skill, the enrollment sequence, and the pure logic (gate wording, policy text, key title, OpenSSH encoding). The api imports its `config`, `store`, `turnkey-client`, `enrollment`, `sandbox`, and `github-keys` entry points for the routes, the prep step, and the sweep. It reads the parent organization credential from the environment:

| Variable | Meaning |
| --- | --- |
| `VALET_TURNKEY_ORGANIZATION_ID` | Parent organization that owns every `valet-signer-*` sub-organization |
| `VALET_TURNKEY_API_PUBLIC_KEY` | P-256 API key of a parent user that may create sub-organizations |
| `VALET_TURNKEY_API_PRIVATE_KEY` | Its private half |
| `VALET_TURNKEY_API_BASE_URL` | `https://api.turnkey.com`, or a dev host |

When the variables are unset the plugin loads and its actions answer "Commit signing is not configured for this deployment. Set the VALET_TURNKEY_* variables."

Actions:

- `turnkey.request_signing_key({ repo, branch, pr_number?, window_minutes? })`. `riskLevel: "critical"`, and the plugin pins `defaultApprovalMode: "allow"` so the catalog does not open a second, generic gate: the action opens the `credential_request` gate itself, with the exact scope in the body. On approve it creates the key, registers it, stores the row, writes the sandbox git config, and returns `{ fingerprint, private_key_id, not_after }`. On reject it returns an error that tells the agent to stop and tell the user.
- `turnkey.revoke_signing_key({ fingerprint })`. Deletes the GitHub key and marks the row revoked. Low risk: revoking is always safe.

Skill `skills/commit-signing/SKILL.md`: when a pull request is ready for review, call `request_signing_key` once, then rewrite the branch with signed commits (`git rebase --exec 'git commit --amend --no-edit -S'` from the merge base), then force-push with lease.

### Enrollment (sub-organization per user)

Route `POST /api/me/commit-signing/enroll` (browser session auth); `GET /api/me/commit-signing` reports state and keys. The card lives under Settings, Connected accounts. The web client creates a passkey with `@turnkey/sdk-browser` and posts the attestation. The api runs, in order:

1. `CREATE_SUB_ORGANIZATION_V7` named `valet-signer-{userId}`. Root users: the passkey. Root quorum threshold 1 in Phase 1.
2. `CREATE_USERS_V4` in the sub-organization: `valet-agent` with one API key whose private half is generated and discarded. Turnkey refuses a user with no credential, and an API key with an expiration does not count (spike, 2026-09-12: `user missing valid credential`). The discarded key satisfies the rule and can authenticate nothing.
3. `CREATE_USER_TAG` `agent-session` with `valet-agent`, and `CREATE_PRIVATE_KEY_TAG` `agent-signing`.
4. `CREATE_POLICY_V3`, one policy: effect `EFFECT_ALLOW`, consensus `approvers.any(user, user.tags.contains('<agent-session tag id>'))`, condition `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && private_key.tags.contains('<agent-signing tag id>')`. Non-root users are denied by default, so no deny policy is needed. Tag ids, not names, go in the text.

The parent API key joins the new sub-organization as a second root user (quorum 1) so steps 2 through 4 run without a second passkey tap, and leaves the root quorum in a last step with `UPDATE_ROOT_QUORUM`. After that the parent key has no authority in the sub-organization.

The result `{ subOrgId, passkeyUserId, agentUserId, agentTagId, signingTagId, policyId }` is stored in the plugin store, scope `user`, collection `enrollment`, key `default`.

### Session key

At sandbox prep, a prep step `turnkey-session-key` runs after `git-identity` when the deployment is configured and the user is enrolled (`engine/commit-signing-resolve.ts`, `engine/commit-signing-prep.ts`). Prep runs in the api process with the sandbox handle, so no sandbox-to-api route is needed:

1. In the sandbox: `tk api-key generate --output /run/valet/turnkey/session.json` (0600). The private half never leaves the sandbox.
2. The api reads the public half from that file and calls `CREATE_API_KEYS_V2` on `valet-agent` with `api_key_name = session:<sessionId>` and a 24 h expiry. It stores `{ apiKeyId, publicKey, createdAt, expiresAt }` in the plugin store, scope `session`, collection `session_key`.
3. The step writes `/run/valet/turnkey/env` with `TURNKEY_ORGANIZATION_ID` and `TURNKEY_API_BASE_URL`, mode 0600.

The step is not critical: a Turnkey failure logs and the session starts unsigned. A resumed sandbox that already has a session key keeps it. A session with no enrollment gets no step. `git commit` then produces an unsigned commit, as today.

### Sandbox git config

After `user.name` and `user.email`:

```
gpg.format ssh
gpg.ssh.program /usr/local/bin/valet-sign
commit.gpgsign true
```

`valet-sign` is a generated POSIX script (`engine/commit-signing-script.ts`), installed by the `credential-scripts` step like `valet-secrets`. It reads `/run/valet/turnkey/env` and the session key file, exports the `TURNKEY_*` bundle, and execs `tk ssh git-sign` with git's arguments. `commit.gpgsign` stays off at prep. On approval `turnkey.request_signing_key` appends `TURNKEY_PRIVATE_KEY_ID` to the env file, sets `user.signingkey` to `key::<public key line>`, and turns `commit.gpgsign` on (`plugin-turnkey/src/sandbox.ts`). When no key has been issued `valet-sign` exits 1 with: `No signing key for this session. Call turnkey.request_signing_key first, or commit with --no-gpg-sign.`

The committer email must be an email verified on the GitHub account, or GitHub shows "Unverified" even with a valid signature. The `git-identity` step already sets `user.email` from the Valet user.

### Cleanup

`engine/signing-key-sweep.ts` runs every hour: for each index row with status `active` whose `notAfter` has passed, delete the GitHub key with the user's token, then set the user row and the index row to `closed`. A failure (no usable GitHub token, permission removed) logs and leaves the row for the next tick. The Turnkey session API key expires on its own. The Turnkey private key and the rows are never deleted. Closing a key when its pull request merges or closes, through the GitHub plugin's trigger, is a follow-up.

### Audit

Collections in the plugin store, plugin `turnkey`:

| Scope | Collection | Key | Document |
| --- | --- | --- | --- |
| user | `enrollment` | `default` | sub-organization ids, tag ids, policy id |
| session | `session_key` | `default` | Turnkey API key id, public key, expiry |
| user | `signing_keys` | `<createdAt>-<fingerprint>` | session, org, repo, branch, pr, fingerprint, public key, GitHub key id, Turnkey private key id, create activity id, notBefore, notAfter, status, gate id |
| session | `signing_keys` | `current` | the same document, for the session's active key |
| global | `signing_key_index` | `<createdAt>-<fingerprint>` | user, email, org, session, fingerprint, public key, GitHub key id, window, status. The plugin store lists within one scope, so this is how the sweep and the allowed-signers route find keys across users. |

Decision gates persist in the engine store. `action_invocations` rows come from the plugin catalog. The session UI lists the session's signing keys next to its gates.

### Local verification file

`GET /api/org/allowed-signers` renders one line per key ever issued in the caller's organization:

```
<user email> valid-after="<notBefore>" valid-before="<notAfter>" ssh-ed25519 <key>
```

A reviewer sets `git config gpg.ssh.allowedSignersFile` to a download of it, and `git verify-commit` exits 0 for commits in the window.

## Gate wording

Type `credential_request`. Title `Sign commits`. Body:

```
Sign commits in {owner}/{repo}, branch {branch}, valid for {window}?
The key is deleted after the window or when the pull request closes.
```

Actions: `Approve` (approves), `Reject` (danger). The renderer shows every value without abbreviation. The `resumeKey` is `signing-key:{repo}:{branch}`, so a retry after an expired gate does not open a second one.

## Errors

| Condition | Where | Message |
| --- | --- | --- |
| Deployment has no `VALET_TURNKEY_*` | action | Commit signing is not configured for this deployment. Ask an admin to set the VALET_TURNKEY_* variables. |
| User has no enrollment | action | Set up commit signing under Settings, Connected accounts, then run this again. |
| GitHub token lacks the permission | action | GitHub refused to add the signing key. An admin must grant the GitHub App the "SSH signing keys" write permission, then reconnect GitHub. |
| Gate rejected | action | The user rejected signing for this branch. Do not retry. Push unsigned, or ask the user. |
| No key issued yet | `valet-sign` | No signing key for this session. Call turnkey.request_signing_key first, or commit with --no-gpg-sign. |
| Session key expired | `valet-sign` | The session's Turnkey key expired. Start a new session. |
| Turnkey asks for consensus (Phase 2) | `valet-sign` | Signing needs approval in Valet. Ask the user to approve, then commit again. |

## Spike results (2026-09-12)

S1, GitHub App permission. GitHub Apps have a user permission "SSH signing keys" (`git_signing_ssh_public_keys`). `POST` and `DELETE /user/ssh_signing_keys` are user-to-server, access `write` (docs.github.com, permissions required for GitHub Apps). The Valet App needs that permission added and users must re-authorize. Not yet exercised against a live App.

S2, sandbox tooling and GitHub. Both sandbox images install `openssh-client` and git. A Linux `tk` built from `tkhq/tk` main runs in the `Dockerfile.sandbox` base stage and authenticates with an expiring session API key. A commit signed with a disposable Ed25519 key registered through `POST /user/ssh_signing_keys` shows `verified=true reason=valid` on GitHub, and stays verified after `DELETE /user/ssh_signing_keys/{id}`. Disposable keys work.

S3, `tk ssh git-sign` from git. In a dev sub-organization laid out as this design says (passkey-approved `CREATE_SUB_ORGANIZATION_V7`, `valet-agent` with a discarded key plus an expiring session key, `agent-session` and `agent-signing` tags, the one allow policy), `git commit` with `gpg.format=ssh` and `gpg.ssh.program=tk` produced a commit that `ssh-keygen` verifies: `Good "git" signature for carey@turnkey.io with ED25519 key`. Findings:

- Git passes `-U` when `user.signingkey` is a literal `key::` public key. `tk`'s parser refused it. Fixed in `tkhq/tk` branch `carey/git-sign-accept-agent-flag`.
- Git calls `gpg.ssh.program` to verify as well (`-Y find-principals`, `-Y check-novalidate`). `valet-sign` hands every operation except `-Y sign` to `ssh-keygen`, or `git verify-commit` fails in the sandbox.
- An `EFFECT_ALLOW` policy on `user.id` and `private_key.id` evaluated `OUTCOME_ALLOW` for a non-root user with an expiring API key.
- When the signing user is a root user under a 2-of-2 quorum, `tk` exits non-zero with the activity id and fingerprint and git fails with `failed to write commit object`. This is the Phase 2 path, and it fails closed.
- Turnkey refuses `CREATE_USERS_V4` when the only API key has an expiration. Enrollment creates the agent user with a discarded non-expiring key.
- The dev API rate limits a credential after a few calls per minute. Tests must retry on 429.

## Phase 2: passkey consensus

1. Change the allow policy consensus to `approvers.any(user, user.id == '<passkey root user id>')`. A sign now parks in `CONSENSUS_NEEDED`.
2. `valet-sign` reports the pending activity id through `POST /api/sandbox/turnkey/pending`. The gate card gains "Approve with passkey", which stamps `APPROVE_ACTIVITY` with `@turnkey/sdk-browser`.
3. Git cannot resume a signature. After approval the agent commits again, and the new activity is approved the same way, or the policy consensus is satisfied by a second short-lived key issued on approval. Which one is settled in the Phase 2 spec.
4. Store the `POLICY_OUTCOME` app proof from `list_app_proofs` on the `signing_keys` row.

## Decisions still open

- Author account: the human's GitHub account in v1. The badge attributes to the human; agent provenance is in Turnkey and in the key title.
- Window: 2 h default, 24 h cap.
- `max_commits` is not in the gate. Nothing can enforce it.
- `tk` in the sandbox images: built from a pinned `tkhq/tk` commit in a builder stage until that repo publishes releases.

## Validation

- `pnpm --filter @valet/plugin-turnkey test`: gate wording, key title, OpenSSH encoding, policy text, config loading, and the action against a fake Turnkey client and a fake GitHub client.
- `packages/api/src/engine/sandbox-spec.test.ts`: the `valet-sign` script is in the `credential-scripts` hash.
- `make e2e` scorecard.
- By hand, in a dev sandbox against the dev organization: the acceptance scenario below.

Acceptance: the agent opens a pull request with unsigned commits; the gate renders the exact scope; approve; the agent rewrites and pushes; GitHub shows Verified on every commit; `git verify-commit` exits 0 with the allowed-signers file; the Turnkey activity log shows one `CREATE_PRIVATE_KEYS_V2` and one `SIGN_RAW_PAYLOAD_V2` per commit; the `signing_keys` row exists; after the window the GitHub key is gone, old commits stay Verified, and a fresh `git commit -S` fails.
