# Commit signing with user-registered keys and passkey approvals

Status: implemented (2026-11-17). This design changes `2026-09-12-agent-commit-signing-design.md`. When it ships, that spec gets a "Changed by" note and its Decision 3, Decision 4, Flow, and Phase 2 sections point here.

## Intent

Commit signing gives commits that an agent makes a GitHub "Verified" badge after a person approves. The shipped design has the Valet GitHub App add a fresh SSH signing key to the person's GitHub account for each approval. That needs the GitHub App user permission "SSH signing keys" with write access.

We will not grant that permission. An app that can write signing keys can add an attacker's key to every connected account if the app's credentials leak. The attacker then makes Verified commits as anyone, with no Turnkey involvement.

The shipped design has a second gap. During an approved window, the sandbox holds an expiring Turnkey session API key. Whoever holds that key can sign any bytes until the window ends. Moving the key from the sandbox to the Valet api does not fix this: the holder changes, the authority does not. Turnkey policy cannot read payload bytes, so nothing ties a session key to the commits a person approved.

This design keeps the Verified badge and closes both gaps:

1. The person adds their Valet signing key to GitHub themselves, once, from a guided modal.
2. By default, the person's passkey stamps each signature request. Valet holds no signing authority between passkey taps. One tap gives one signature over bytes the person was shown.
3. Any approval can ask for a passkey tap, not only signing. The approval record says which kind of approval it got.

## Goals

- Valet never writes to a person's GitHub account to set up signing. The GitHub App needs no "SSH signing keys" permission.
- In the default mode, no Valet component can get a signature without a passkey tap: not the sandbox, not the api, not its Turnkey parent key, not its database, not the GitHub App.
- Each approval records its assurance: a click in a signed-in session, or a proof of presence that Turnkey verified.
- A deployment can keep the shipped window model as a lower-assurance option.

## Non-goals

- Binding a signature to a repository or branch. A commit object does not name either.
- Key rotation in the UI. The person deletes the key on GitHub and sets up again.
- Signing in workflow runs, schedules, or event deliveries with no person present.
- Passkey approvals in Slack, the CLI, or MCP clients. WebAuthn needs the Valet web app.

## Anti-goals

These make the design a failure even if commits show Verified:

- A presence approval that Valet verifies by itself. Turnkey must verify the passkey assertion, or the label is not true.
- In the default mode, any Valet-held credential that can ask Turnkey for a signature.
- A setup step that asks the person to paste a private key anywhere, or that shows them one.

## Approval assurance

Every decision gate carries an assurance:

- `session`: a signed-in person clicked Approve. This is every approval today.
- `presence`: the approver's passkey stamped a Turnkey activity with user verification, and Turnkey executed it. Turnkey checks the assertion. Valet only reads the completed activity back.

`presence` is a property of the proof, not of the card.

### Proof of presence, in AuthZEN terms

A passkey approval is a proof of presence: evidence that a person was present at the moment of the action, not only signed in. The AuthZEN specifications do not define a "proof of presence" object. They define the pieces this design uses, and the names come from them:

| Concept | AuthZEN or RFC source | In Valet |
| --- | --- | --- |
| Requirement for presence | Obligations profile, `step-up` obligation (`acr_value`, `amr_values`) | A gate's `context.assurance: "presence"`. In policy terms, a `step-up` obligation with `amr_values: ["pop", "user"]`. |
| Presence methods | RFC 8176 `amr` values: `user` (user presence test), `pop` (proof of possession of a key) | `amr: ["pop", "user"]` in the proof. |
| The approval fact | Access Request and Approval Profile, section 8.1 `approval` object: `id`, `approved_at`, `approved_until`, `state` | `DecisionResolution.approval`, one per resolved passkey gate. A gate approval is single use, so `approved_until` equals `approved_at`. |
| Verifier state | The approval's opaque `state`, which the verifier must check for integrity, issuer, and binding | `state` is a `PresenceProof`: `iss: "turnkey"`, `organization_id`, `amr`, `approver` (`user_id` and the vote's `authenticator`: `scheme`, `public_key`), and `activities` (`activity_id`, `payload_sha256`, `approved_at`), one per passkey tap. |

`payload_sha256` binds each tap to the exact bytes it approved. A replayed or substituted approval cannot cover other bytes.

Where each part of the authority stack does its job:

- **Facts (policy information point):** Turnkey's completed activities are the trusted facts. Valet reads them back with the parent key. It does not trust the browser's account of what happened.
- **Approvals verifier:** two checks. The passkey endpoint checks each activity's type, organization, passkey vote, and signature before it builds the approval. Then, when any path resolves a `presence` gate, the engine calls the host's verifier (`ProviderBundle.verifyPresenceApproval`). It trusts nothing in the record: it reads every listed activity back from Turnkey, rebuilds the payload each step had to cover from the gate itself, and checks the vote, the signature, and the payload digest. A record written by any other path fails. A fully compromised api could replace this code too; the check protects against forged or corrupted records, not a hostile server.
- **Records (decision log):** the engine persists the resolution, including the full approval object, on the gate. When the authorization contracts land, `ApprovalFact` carries `assurance` and the same `approval` object into the decision record. `ApprovalRequirement` and the `approval_tier` obligation gain an `assurance` member beside `tier`, so a policy can require a proof of presence at any tier.

The contracts are not on `dev-v2` yet. This work ships the gate field, the engine check, the verifier, and the persisted approval on their own.

### How a gate asks for a passkey

- A tool asks with `DecisionGateRequest.assurance: "presence"`. The engine stores it on the gate.
- The engine refuses an approving resolution for a `presence` gate unless the resolution carries `assurance: "presence"` and an approval whose proof lists at least one activity. This check lives in `Session.resolveDecision`, so the web route, Slack buttons, bulk answers, MCP, and the CLI all meet it. Reject and decline stay one click everywhere.
- Only the api's passkey endpoint sets `assurance: "presence"` on a resolution, after Turnkey verified the stamp.
- Every passkey step is the same Turnkey activity: `SIGN_RAW_PAYLOAD_V2` in the approver's own sub-organization, with their signing key, stamped by their passkey user. The approver is a root user, so no policy grant is involved.
- A plain approval gate signs a challenge: SHA-256 over `valet-approval`, the session id, the gate id, the title, and the body. The api checks the signature with the person's public key. A challenge cannot pass for a git signature, because a git signature covers an `SSHSIG` blob, which starts with different bytes.
- Signing gates sign commits (below). A gate can take more than one step.

### The passkey endpoint

`GET /api/sessions/:id/decisions/:gateId/passkey` returns the next step: the unsigned Turnkey request body, and a label for the card ("Commit 2 of 3: fix the parser"). `POST` to the same path takes the body and the passkey stamp header. The api then:

1. Checks that the caller is the gate's approver and that the body is the step it issued: activity type, the approver's sub-organization, their signing key, the expected payload, and a timestamp less than five minutes old.
2. Forwards the body and stamp to Turnkey unchanged. A changed body breaks the stamp.
3. Reads the completed activity back and checks that the passkey user approved it and that the signature verifies with the person's public key.
4. Records the step: the activity id, the signature, the payload digest, and the vote's authenticator. After the last step, it resolves the gate with `assurance: "presence"` and the approval object.

A person who has not set up commit signing has no sub-organization yet. The card then links to Settings, Commit signing, and offers only Reject.

### Channels

Slack and other channels post a `presence` gate with a Reject button and a link: approve with your passkey in Valet. A Slack Approve click on an older card gets the same message.

## Commit signing

### Whose key signs

The key of the person who asked for the work signs: the author of the queue item that started the turn. Only that person can approve. This holds in personal and team threads and in Slack-started turns. A child session inherits the person from the parent turn. A turn with no person behind it cannot ask for signatures. The action answers with a message that names the fix: run the step from a thread.

### One signing key per person, registered by the person

Each person has one Ed25519 signing key. It replaces the per-approval keys and never expires: setup happens once, and the key lasts until the person deletes it on GitHub. The person does not run `tk`.

In presence mode, setup never gives Valet's server authority in the person's sub-organization:

1. The browser creates a passkey. The api creates the sub-organization with that passkey as its only root user. The parent key never joins it. A parent organization can still read its sub-organizations, which the endpoint and the verifier need, but cannot write to them.
2. The api checks that the root quorum is exactly the passkey, records a pending enrollment, and returns an unsigned `CREATE_PRIVATE_KEYS_V2` body for one Ed25519 key named `valet-signing`.
3. The browser stamps that body with the same passkey. The api checks the body is the one it issued, forwards it to Turnkey, checks the completed activity carries the passkey's vote, and records the key.

Setup is two passkey prompts. If the second fails, Settings shows "Finish setup", which issues a fresh key-creation body. Setup needs a sign-in less than 15 minutes old, so a stolen session cannot enroll its own passkey for someone else.

In session mode, the parent key is a temporary root during setup so it can create `valet-agent`, the tags, the key, and the policies. That mode trusts Valet's server at setup.

After enrollment, Settings, Commit signing, shows a setup modal:

```
Add your Valet signing key to GitHub

1. Open GitHub, Settings, SSH and GPG keys, New SSH key.   [Open GitHub]
2. Title: Valet commit signing
   Key type: Signing Key            (not Authentication Key)
3. Key:  ssh-ed25519 AAAAC3Nza...  valet-signing          [Copy]

[Check GitHub]
```

"Check GitHub" reads GitHub's public endpoint `GET /users/{login}/ssh_signing_keys`, which needs no token or permission. The login comes from the person's GitHub connection. The modal shows found, not found yet, or no GitHub connection. The signing action runs the same check and, if the key is missing, answers with a message that names the fix.

### Presence mode (default): the passkey signs each commit

1. The agent commits without signing, then calls `turnkey.sign_commits` with the repository, the branch, and the base it branched from.
2. The action reads the commits in `base..HEAD` from the sandbox with `git cat-file`. It refuses more than 10 commits with a message that names the fix: squash to fewer commits. It refuses SHA-256 object format repositories.
3. The action refuses anything that is not a well-formed commit object: `tree`, any `parent` lines, `author`, `committer`, then only `encoding`, `gpgsig`, or `mergetag`. Without this check a compromised sandbox could get a signature over a tag object, which git would accept as a signed tag.
4. The gate opens with `assurance: "presence"`. The card lists each commit with its short id, subject, files changed, and line counts. If GitHub already has the commit, the counts come from GitHub and the card links to the commit there. The commit id fixes the content, so that page shows exactly what the signature covers. If the commit is not pushed, the counts come from the sandbox, and the card says so. The button reads "Sign with passkey".
5. For each commit, oldest first, the browser stamps one `SIGN_RAW_PAYLOAD_V2` request. The payload is the `SSHSIG` signed-data blob for the commit object: namespace `git`, hash `sha512`.
6. A commit object names its parent's hash, and signing changes that hash. So the api builds commit N+1 only after commit N is signed. The person taps once per commit. One commit per push means one tap.
7. When the gate resolves, the action verifies every stored signature against the person's key, then writes the signed objects into the sandbox with `git hash-object -w`, checks each hash against the one the api computed, and moves the branch with `git update-ref`. The agent force-pushes with lease.

A rejection answers every later signing request for the same branch in that turn, so a looping agent cannot keep asking for taps.

The signed commits exist only in the sandbox until the agent pushes them. If the sandbox is replaced first, for example by an api restart, the agent checks out the pushed unsigned branch again and calls the action again. The action keeps the verified signatures of each signed chain in the plugin store (`signed_chains`, scope session, keyed by repository, branch, and head commit). On a call with the same commits it verifies them against the person's current key and writes them again without a gate. A signature covers the exact commit bytes, so reuse cannot sign anything the person did not approve. The rebuilt commits are byte-identical to the first ones. A signature from an older key fails the check, and the action opens a new gate. Reuse stays within one session.

Each new passkey approval also adds a row to the person's signing history (`signing_history`, scope user): repository, branch, each unsigned commit and the signed commit that replaced it, the time, the Turnkey activity id of each signature, and the session and thread that hold the approval card. Settings, Commit signing lists the 50 newest rows. Each row links each signed commit to GitHub and the approval to its thread. The activity id finds the signature in the person's Turnkey organization, so the history can be checked without trusting Valet's record. A reused approval adds no row.

Turnkey app proofs are not stored. The shipped design planned to store the `POLICY_OUTCOME` app proof of each signing activity. On 2026-11-18 Turnkey returned no app proofs for `SIGN_RAW_PAYLOAD_V2` activities: the activity's `appProofs` was empty, and `get_app_proofs` returned none. No other activity type in the parent or sub-organization had one either. If Turnkey adds them, the change is small. Read `appProofs` with the activity, check each with `verifyAppProofSignature` from `@turnkey/crypto`, and add them to each activity in the approval's `state`.

The rewrite sets the committer email to the person's GitHub noreply address, read with their token (`GET /user`), as the shipped design does. It keeps the committer name and time, the author, the tree, and the message.

### Session mode: the shipped window

A deployment can set `VALET_TURNKEY_SIGNING_ASSURANCE=session`. Enrollment then also creates the `valet-agent` user, its signing policy, and a parent grant for `CREATE_API_KEYS_V2` and `DELETE_API_KEYS` whose condition names the `valet-agent` user id through `activity.params.user_id`. `CREATE_PRIVATE_KEYS_V2` is not granted: keys are made at enrollment.

`turnkey.request_signing_key` keeps the shipped flow: a `session` approval, an expiring session API key on `valet-agent`, and `tk ssh git-sign` in the sandbox. It signs with the person's key and no longer registers a key on GitHub.

Each enrollment records the mode it was created in. A person enrolled in presence mode has no parent grant and no `valet-agent`, so the parent key has no authority in their sub-organization. To change mode, the person sets up again.

### What is removed

- `github-keys.ts` `create` and `remove`, and the "SSH signing keys" permission. `noreplyEmail` stays.
- Per-approval `CREATE_PRIVATE_KEYS_V2`, and the unscoped parent grant.
- In presence mode: `tk`, the session key file, and the `TURNKEY_*` env file in the sandbox. Git signs nothing in the sandbox.

### Migration

Sub-organizations from the shipped design have per-approval keys and an unscoped parent grant. Settings shows "Set up again" for any enrollment without a person signing key. A new sub-organization replaces the old one. The old one stays as the record of past issuance. Its keys stay on GitHub until the person deletes them, and GitHub keeps past commits Verified.

## Threat model

| Attacker | Shipped design | Presence mode | Session mode |
| --- | --- | --- | --- |
| GitHub App credentials leak | With the write permission, adds its own key to every account and signs as anyone, forever. | No path. The app has no key permission. | Same as presence mode. |
| Sandbox compromised (prompt injection, hostile repository code) | Holds the session key. Signs any bytes until the window ends. | Holds no Turnkey credential. Can ask for signatures, and each one needs the person's tap. | Same as shipped. |
| Valet api, database, or parent key compromised | The parent key creates keys and API keys in any sub-organization. Signs as anyone, any time. | The parent key was never a member of the sub-organization. A forged approval record fails the verifier. The attacker needs a live tap for each signature. | The parent grant can add API keys to `valet-agent` only. The attacker opens windows at will. |
| Valet api compromised during a person's setup | Not relevant. | It chooses the root users when it creates the sub-organization, and could add its own. The api checks the quorum is exactly the passkey, but a compromised api could skip that. | It is a root during setup and can leave any policy behind. |
| Stolen Valet session | Approves windows. | Cannot approve: approval needs the passkey. Cannot enroll a new passkey without a sign-in less than 15 minutes old. | Approves windows. |
| Valet web app served by a compromised api | Not relevant. | Can show commit A and ask the passkey to stamp commit B. The passkey prompt does not show the payload. The attacker still needs a live tap and gets one signature per tap. | Not relevant. |
| Turnkey sub-organization | Root is the person's passkey. | Unchanged. | Unchanged. |

Two gaps remain, both needing a live attack on Valet's server or web app. The compromised web app row needs an approval page that Valet does not serve, such as a Turnkey-hosted iframe that shows the payload, or `tk` on the person's own machine. The setup row needs the person to confirm the root quorum from a surface Valet does not control. Both are future work. The card's GitHub link narrows the first gap for pushed commits: an honest page shows the real diff, and the commit id it names is the one the person approves.

## Approaches considered

1. **The passkey stamps each signature (chosen).** No standing signing authority anywhere. Cost: one tap per commit, and no unattended signing.
2. **The passkey opens a window: it stamps the `CREATE_API_KEYS_V2` for an expiring session key.** It proves presence at window creation only. After that the session key is a bearer credential that signs anything until it expires. Rejected as the default, and kept in spirit as session mode.
3. **A signing service in the Valet api holds the window key.** It moves the bearer credential from the sandbox to the api. A compromised api signs anything during any open window. Rejected.
4. **A Turnkey consensus policy holds each request until the passkey approves it.** Same guarantee as approach 1, with a pending state to track and expire. Rejected: more moving parts.
5. **Valet verifies the WebAuthn assertion itself.** A compromised api skips the check. Fails the first anti-goal. Rejected.

## Constraints

- Turnkey policy cannot read payload bytes.
- WebAuthn needs a browser with the person's passkey.
- `tkhq/valet` is public. Policy text and flows in this document are already public in code.

## Left to the builder

- The exact copy in the modal and the card, within the repo's writing rules.
- How the forwarded stamp is represented on the wire.
- Test structure, and fakes for Turnkey and GitHub.
- The org-level setting. This design uses a deployment variable. An org setting can replace it later without changing enrollment records.

## Validation

- Unit: the `SSHSIG` blob and armor against `ssh-keygen -Y verify`, the commit rewrite and its hashes against `git hash-object`, the step checks in the passkey endpoint, the engine refusing an approving resolution on a `presence` gate without a proof, and enrollment in both modes.
- Live, against a Turnkey organization and a test repository:
  1. Enroll, add the key on GitHub from the modal, and see the check pass.
  2. Commit unsigned, call `turnkey.sign_commits`, tap the passkey, force-push, and see Verified on every commit.
  3. Click Approve on the same kind of gate from Slack or the API and see it refused.
  4. Confirm the parent key cannot create an API key or sign in a presence-mode sub-organization.
  5. Confirm each signature is a Turnkey activity approved by the passkey user.
