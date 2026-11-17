# Commit signing with user-registered keys and presence approvals

Status: proposed (2026-11-17). This design changes `2026-09-12-agent-commit-signing-design.md`. When it ships, that spec gets a "Changed by" note and its Decision 3, Decision 4, Flow, and Phase 2 sections point here.

## Intent

Commit signing gives commits that an agent makes a GitHub "Verified" badge after a person approves. The shipped design has the Valet GitHub App add a fresh SSH signing key to the person's GitHub account for each approval. That needs the GitHub App user permission "SSH signing keys" with write access.

We will not grant that permission. An app that can write signing keys can add an attacker's key to every connected account if the app's credentials leak. The attacker then makes Verified commits as anyone, with no Turnkey involvement.

This design keeps the Verified badge and removes that path:

1. The person adds their Valet signing key to GitHub themselves, once, from a guided modal.
2. A deployment can require a passkey touch for every signing approval. Turnkey verifies the touch, so a compromised Valet server cannot open a signing window.
3. The sandbox no longer holds a credential that can ask Turnkey for signatures.

## Goals

- Valet never writes to a person's GitHub account to set up signing. The GitHub App needs no "SSH signing keys" permission.
- With presence approvals on, no Valet component can create signing authority without the person's passkey: not the api, not its Turnkey parent key, not its database, not the GitHub App.
- The approval record says how strong the approval was: a click in a signed-in session, or a proof of presence.
- A compromised sandbox can get only git commit objects signed, only for its own session, and only while an approved window is open.

## Non-goals

- Binding a signature to a repository or branch. A commit object does not name either, and Turnkey cannot read payload bytes. The window and the audit trail stay the controls, as in the shipped design.
- Key rotation in the UI. The person deletes the key on GitHub and in Settings and sets up again.
- Signing in workflow runs with no person present.
- Slack approval buttons for presence approvals. Slack cannot run WebAuthn.

## Anti-goals

These make the design a failure even if commits show Verified:

- Any Valet-held credential that can add a key or an API key to a person's sub-organization at will while presence approvals are on.
- A presence approval that Valet verifies by itself. Turnkey must verify the passkey assertion, or the label is not true.
- A setup step that asks the person to paste a private key anywhere, or that shows them one.

## Threat model

| Attacker | Shipped design | This design |
| --- | --- | --- |
| GitHub App credentials leak | With the write permission, adds its own key to every connected account and signs as anyone, forever. | No path. The app has no key permission. Verified status needs a key the person added. |
| Sandbox compromised (prompt injection, malicious repository code) | Holds the session API key. Signs any bytes until the window ends. | Holds only its sandbox token. The signing service signs only commit objects for an open window of this session. |
| Valet api, database, or parent key compromised | The parent key can create private keys and API keys in any sub-organization, and the approval card is a database row. Signs as anyone, any time. | Presence mode: the parent key has no grant after enrollment, and windows need a passkey assertion that Turnkey verifies. The attacker can use only windows a person opened, until they expire. Session mode: same exposure as shipped, but the parent grant is limited to the `valet-agent` user. |
| Turnkey sub-organization | Root is the person's passkey. | Unchanged. |

## Approaches considered

1. **Turnkey verifies the passkey (chosen).** The approval card runs WebAuthn through Turnkey's browser passkey stamper. The passkey stamps the `CREATE_API_KEYS_V2` activity that creates the window's expiring session API key. Turnkey checks the assertion. The parent key holds no grant, so Valet cannot create the credential another way. Cost: presence approvals work only in the Valet web app.
2. **A Turnkey consensus policy holds the request.** Valet submits the activity, and a policy keeps it in `CONSENSUS_NEEDED` until the passkey approves it with `APPROVE_ACTIVITY`. It gives the same guarantee with a pending state to track, expire, and reconcile. Rejected: more moving parts for no gain.
3. **Valet verifies the WebAuthn assertion, then the parent key acts.** It is simple, but a compromised api skips the check. It fails the anti-goal above. Rejected.

## Design

### 1. Approval assurance labels

Every decision gate carries an approval assurance:

- `session`: a signed-in person clicked Approve. This is every approval today.
- `presence`: a user-verified passkey assertion that a third party verified. For signing, Turnkey verifies it when it accepts the stamped activity.

`presence` is a property of the evidence, not of the card. A gate that asks for `presence` resolves only with evidence: the id of a completed Turnkey activity that the person's passkey user stamped, which the api reads back from Turnkey before it accepts the resolution.

Where the label lives:

- Engine `DecisionGateRequest` gains `assurance?: "session" | "presence"` (default `session`). The resolution records the assurance the approval met and an `evidence` object (`{ kind: "turnkey_activity", activityId, organizationId }` for signing).
- The resolve route refuses a plain Approve on a `presence` gate with a message that names the fix: approve with your passkey in Valet.
- Authorization contracts: `ApprovalRequirement.tier` uses the same two values, and `ApprovalFact` gains `assurance`. A policy can then require `presence` through the existing `approval_tier` obligation. The contracts are not on `dev-v2` yet. This work ships the gate label and the resolve-route check on its own. The contract fields land with the contracts, and a policy that requires `presence` follows them.
- Slack and other channels render a `presence` gate with an "Approve in Valet" link and no Approve button.

### 2. Whose key signs

A window signs with the key of the person who asked for the work: the author of the queue item that started the turn. Only that person can approve the window, and the gate is routed to them. This holds in personal and team threads, and in Slack-started turns.

- A child session inherits the person from the parent turn that started it. The parent's window does not carry over: the child's session asks for its own window, and the same person approves it.
- A turn with no person behind it, such as a scheduled workflow run or an event delivery, cannot ask for a window. The action answers with a message that names the fix: run the step from a thread.
- The signing service enforces that person's noreply address as the committer.
- If that person has not enrolled, the card says so and links to Settings, Commit signing.

### 3. One signing key per person, registered by the person

Enrollment already runs while the parent key is a temporary root of the new sub-organization. It now also creates one Ed25519 private key with the `agent-signing` tag. That key is the person's Valet signing key. It replaces the per-approval keys.

After enrollment, Settings, Commit signing, shows a setup modal:

```
Add your Valet signing key to GitHub

1. Open GitHub, Settings, SSH and GPG keys, New SSH key.   [Open GitHub]
2. Title: Valet commit signing
   Key type: Signing Key            (not Authentication Key)
3. Key:  ssh-ed25519 AAAAC3Nza...  valet-signing          [Copy]

[I added it]     Checking github.com/<login>...
```

"I added it" checks GitHub's public endpoint `GET /users/{login}/ssh_signing_keys`, which needs no token or permission. The login comes from the person's GitHub connection. The modal shows one of three results: found, not found yet (with the steps again), or no GitHub connection (with a link to connect it).

The same check runs when the agent asks for a signing window. If the key is missing, the card says so and opens the modal before it offers approval. The check result is cached for 10 minutes per person.

The committer email stays the account's noreply address, read with the person's GitHub token (`GET /user`), as today.

### 4. Presence approvals (Turnkey checks)

When the agent calls `turnkey.request_signing_key` and presence is required:

1. The api makes a P-256 key pair for the window and keeps the private half (see section 5).
2. The gate opens with `assurance: "presence"`. The card names the repository, branch, and window, as today, and its Approve button reads "Approve with passkey".
3. The browser builds a `CREATE_API_KEYS_V2` activity: user `valet-agent`, the window's public key, `expirationSeconds` equal to the window. `@turnkey/sdk-browser` stamps it with the passkey, which needs user verification.
4. The browser sends the stamped request to the api, which forwards it to Turnkey unchanged. The api cannot alter a stamped request without breaking the stamp.
5. The api reads the completed activity back, checks that its type, user, public key, and expiry match what it asked for, and resolves the gate with that activity as evidence.

The Turnkey private key and the GitHub key do not change per window. Only the session API key does.

### 5. The signing service: signing leaves the sandbox

The sandbox no longer holds a Turnkey credential. `valet-sign`, git's `gpg.ssh.program`, sends the bytes git asks it to sign to `POST /api/sandbox/signing/sign` with the sandbox token. The api:

1. Finds an open window for the sandbox's session. If there is none, it answers 403 with a message that names the fix: ask for a signing window.
2. Checks that the bytes parse as a git commit object and that its committer email is the person's noreply address. Anything else is refused and logged.
3. Builds the SSHSIG message (namespace `git`, SHA-512), has Turnkey sign it with `SIGN_RAW_PAYLOAD_V2` stamped by the window's session API key, and returns the armored signature.
4. Records the commit's object id, the session, the window, and the Turnkey activity id.

The window's private half is stored encrypted with the instance encryption key, so windows survive api restarts the same way sandbox tokens do (`2026-09-16-durable-sandbox-tokens-design.md`). Revoking a window, by the revoke action or at window end, deletes the stored private half. The Turnkey key expires on its own schedule, and with the private half gone nothing can use it in the meantime.

### 6. Deployment option and policies

An org setting, `commitSigning.approvalAssurance`, takes `presence` or `session`. Org admins set it in Settings. The default is `presence`.

The parent key's grant depends on the setting:

- `presence`: enrollment creates no parent grant. After enrollment the parent key has no authority in the sub-organization.
- `session`: enrollment creates a grant for `CREATE_API_KEYS_V2` and `DELETE_API_KEYS` whose condition names the `valet-agent` user id through `activity.params.user_id`, so the grant cannot add a credential to any other user. `CREATE_PRIVATE_KEYS_V2` is not granted, since keys are made at enrollment.

A policy change in an existing sub-organization needs the person's passkey, so the org setting and a person's sub-organization can differ. Each enrollment records its effective mode: the grant its sub-organization actually holds. The effective mode decides what a person's windows can be:

- Org `presence`, person still holds the parent grant: no window opens until the grant is gone. The person's next signing card removes it with a passkey-stamped policy activity in the same touch as the approval. Only then does the gate resolve as `presence`.
- Org `session`, person holds no grant: the person stays on `presence`, the stricter mode. Their approvals need the passkey, and they are labeled `presence`. The card offers to add the grant. Declining keeps `presence`.
- Settings shows org admins how many enrolled people do not match the org setting yet.

A person who holds the grant and never signs again keeps it. This happens only when an org moves from `session` to `presence`. It is accepted and visible in that count.

The agent's signing policy is unchanged: `valet-agent` may sign with `agent-signing` keys only.

### 7. What is removed

- `github-keys.ts` `create` and `remove`, the GitHub part of the hourly sweep, and the "SSH signing keys" permission message. `noreplyEmail` stays.
- Per-approval `CREATE_PRIVATE_KEYS_V2`.
- `tk`, the session key file, and the `TURNKEY_*` env file in the sandbox. `valet-sign` becomes a small HTTP client like `valet-secrets`.

The hourly sweep keeps one job: close window rows past `notAfter` and delete their stored private halves. Expiry is normal operation, so this repair is expected (CLAUDE.md, invariants rule).

### 8. Migration

Sub-organizations from the shipped design have per-approval keys and an unscoped parent grant. They must enroll again: Settings shows "Set up again" for any enrollment without a person signing key. The old sub-organization stays as the record of past issuance. Its keys remain on GitHub until the person deletes them, and GitHub keeps past commits Verified.

## Constraints

- Turnkey policy cannot read payload bytes, so the commit-object check runs in the api.
- WebAuthn needs a browser with the person's passkey. Presence approvals cannot happen in Slack, the CLI, or a workflow run.
- `tkhq/valet` is public. Policy text and flows in this document are already public in code.

## Left to the builder

- The exact copy in the modal and the card, within the repo's writing rules.
- How the forwarded stamped request is represented on the wire.
- Test structure, and fakes for Turnkey and GitHub.
- The order of PRs, provided the policy change and re-enrollment land before or with presence approvals.
- Where the effective mode is stored, provided it is written only after Turnkey confirms the policy activity.

## Validation

- Unit: commit-object parsing and refusal cases, SSHSIG construction against `ssh-keygen -Y verify`, the activity read-back checks, the resolve route refusing a plain Approve on a `presence` gate, and policy text for both modes.
- Live, against a dev Turnkey organization and a test repository:
  1. Enroll, add the key on GitHub from the modal, and see the check pass.
  2. Request a window in presence mode, approve with the passkey, push signed commits, and see Verified.
  3. Confirm the parent key cannot create an API key in the sub-organization.
  4. In a team thread, see the gate go only to the person who asked, and the commit carry their noreply address.
  5. Try a non-commit payload from the sandbox and see it refused.
  6. Let the window expire and see the next signature refused.
