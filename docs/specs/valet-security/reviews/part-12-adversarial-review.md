# Adversarial review: Part 12 (credentials via 1Password)

Reviewer: automated design review against invariants, PR #421 design, threat model, and implementation.
Date: 2025-07-14.
Status: open findings. Numbered for tracking.

---

## 1. Invariant-level findings

### 1.1 INV-30: preflight resolution may leak values into error messages

INV-30 says no credential value at rest in Valet. The preflight step (section "Preflight validation") resolves each `op://` reference and shape-checks the result. The spec says step 4 zeros every buffer in `finally`. But it does not constrain what `SecurityCredentialPreflightError` carries.

If the shape check fails (for example, `headerToken` value length < 8), the error includes `label`, `ref`, and `reason`. The `reason` string could contain a substring of the resolved value (e.g., "value is 3 bytes: 'abc'") depending on how the implementer writes the check. The spec should add: "The reason MUST NOT include any bytes of the resolved value."

The preflight also calls `OnePasswordService.resolveReference`, which may throw its own error containing the value or part of it. The spec does not require wrapping that call in a try/catch that scrubs the error message before re-throwing.

**Severity: medium.** A careless implementation leaks values into structured errors that reach the HTTP response body and could be logged.

**Recommendation:** Add a normative requirement: "No error thrown during preflight carries any byte of the resolved value. The catch block around `resolveReference` strips the upstream error message and substitutes a generic '1Password resolution failed for label <label>' message."

### 1.2 INV-31: persona can echo the env var

INV-31 says the persona never sees the value. The delivery mechanism is `valet-secrets run --env NAME=op://... -- cmd`. The dispatch prompt says "Do not print $ADMIN. Do not stash it in a tool arg."

This is guidance, not enforcement. A prompt-injected persona (or a persona following instructions from a malicious repo's README) can run:

```bash
valet-secrets run --env ADMIN=op://Security/admin/api-token -- bash -c 'echo $ADMIN'
```

The stdout of that child flows back to the persona as a tool result. The persona now holds the value in its context window. The value appears in `engine_entries.parts` (tool result content) and on the WS bus.

The spec explicitly drops the tripwire (section "Non-goals", "Value-echo redaction"). The stated reason is "the persona doesn't hold the value." But it does hold the value the moment it reads stdout from a `valet-secrets` child that echoes the env var.

**Severity: high.** The primary defense (dispatch prompt instruction) is bypassable by prompt injection, which is the exact threat the credential system exists to mitigate.

**Recommendation:** Either (a) the `valet-secrets` script must capture stdout and redact any substring matching the resolved value before returning it to the persona, or (b) the `beforeEntryPersist` hook must carry a credential fingerprint index (like Part 10's tripwire) to catch leaked values before they reach the store, or (c) the spec must acknowledge this as an accepted risk and document the blast radius.

### 1.3 INV-32: broker allowlist does not cover api-side resolution

INV-32 says the broker refuses refs outside the declared list. The broker is `POST /api/sandbox-secrets/resolve`. But Part 12 section "Preflight validation" step 2 resolves refs via `OnePasswordService.resolveReference` on the api side, not through the broker route.

The spec does not say whether `OnePasswordService.resolveReference` is the same code path as the broker route's resolver. If the preflight calls the 1Password SDK directly (as the implementation in `packages/runner/src/onepassword-provider.ts` does), it bypasses the broker entirely. That path has no allowlist check.

Question: can a persona tool call invoke the api-side `OnePasswordService.resolveReference` with an arbitrary ref? If any api-side endpoint accepts an `op://` ref from the persona and resolves it without checking the allowlist, the invariant is violated.

The `resolveEngagementNeeds` handler (section "Needs routing") does preflight-resolve the ref before appending it. This resolution also happens api-side. If a persona crafts a need with kind=credential and ref=`op://Personal/wallet/seed`, does the handler check the ref against the existing allowlist before resolving it?

The spec says the handler "preflight-resolves the ref" and "appends to `credentials_json`." If resolution happens before the append, the arbitrary ref was already resolved (the value was fetched from 1Password) even if it would later fail an allowlist check. The needs routing path does not mention an allowlist check at all. It only mentions preflight (shape check). A new ref added via needs routing is by definition not yet in the allowlist (it gets appended after validation). So the allowlist cannot protect the needs path. The question becomes: does the session's token scope (step 2 in preflight) prevent the persona from reaching vaults it shouldn't?

**Severity: medium.** The needs routing path resolves arbitrary refs before adding them to the allowlist. The token scope is the only gate.

**Recommendation:** Document explicitly that the needs routing path relies on the session's token scope (not the broker allowlist) as its authorization gate. Consider whether the human reviewer (who pastes the `op://` ref in the needs panel) is the authorization gate by design, and state that.

### 1.4 INV-33: 1Password outage at engagement start

INV-33 says preflight refuses a bad engagement. The spec describes the failure mode (throw `SecurityCredentialPreflightError`, engagement stays `planning`) but does not address 1Password unavailability.

If 1Password is down or the service account token has expired, every `resolveReference` call fails. The engagement refuses to start, but the error message is a 1Password SDK error, not a corrective credential-shape error. The user sees a cryptic failure and cannot distinguish "your ref is wrong" from "1Password is temporarily unavailable."

The spec covers all seven kinds in the shape checks. So the "does the preflight cover all seven kinds" question: yes, all seven have explicit checks in step 3.

**Severity: low.** Operational, not a security gap. But the corrective error contract should distinguish resolution failure (1Password down) from shape failure (value has wrong format).

**Recommendation:** Add a resolution-failure error variant: "When `resolveReference` throws, the preflight emits a corrective error with `reason: 'resolution_failed'` and the upstream error message (scrubbed of any value bytes). The user can retry after fixing the 1Password connection."

### 1.5 INV-34: CHECK constraint status

INV-34 says a CHECK constraint catches regressions where plaintext lands in `security_needs.resolution` for cred-typed needs. The spec says "the CHECK constraint from Part 10's INV-14 belt survives here."

Part 10's implementation checklist item 1 says: "The CHECK constraint on `security_needs.resolution` is deferred to 1.0 numbered migrations; the service layer refuses cred-typed writes to `resolution` in the meantime."

So the CHECK constraint is not shipped. It is deferred. The only protection today is the service-layer code. If a code path bypasses `resolveEngagementNeeds` and writes directly to the `security_needs` table (e.g., a migration script, a manual SQL fix, or a new feature that touches the needs table), the constraint does not catch it.

**Severity: medium.** The spec claims a belt that does not exist in the codebase yet. The service-layer guard is sufficient for now, but the spec should not say "is caught by the CHECK constraint" without noting it is deferred.

**Recommendation:** Add "(deferred; service-layer guard active)" after the CHECK constraint mention, or land the constraint in this PR's schema changes.

---

## 2. Against PR #421's design

### 2.1 Allowlist check ordering: before or after resolution?

The broker allowlist section says: extend `POST /api/sandbox-secrets/resolve` with steps 1-4. Step 3 checks refs against the allowlist. Step 4 says "on pass, proceed with PR #421's resolution."

This ordering is correct: the allowlist check happens before the value is fetched from 1Password. Good.

But the spec should state this explicitly as a normative requirement: "The allowlist check MUST execute before any call to `resolveReference`. A ref that fails the allowlist MUST NOT trigger a 1Password API call." Otherwise an implementer could check the allowlist after fetching (to provide a better error message), which would leak the value into server memory before the rejection.

**Severity: low.** The spec's step ordering implies the right sequence, but "proceed with PR #421's resolution" in step 4 is the only signal. An explicit "before resolution" statement would prevent a subtle implementation bug.

### 2.2 Token scope for security engagement sessions

PR #421's design restricts personal vault access for team/org-owned sessions. The preflight section says the token scope for resolution is: "user session -> `["org", "personal"]`; team/org session -> `["org"]`."

This means a security engagement created under a team session cannot use credentials from a user's personal vault. This is correct behavior but creates a usability gap: a security engineer who stores pentest credentials in their personal vault and creates the engagement under a team workspace gets a preflight failure with no obvious explanation.

The spec does not document this restriction in the "Config schema" or "Non-goals" sections.

**Severity: low.** Not a security issue, but a usability gap that will generate support requests.

**Recommendation:** Add a note in the Config schema section: "Refs to personal vaults work only for user-owned sessions. Team or org-owned sessions resolve against org vaults only."

### 2.3 Preflight vs. runtime resolution divergence

The spec says preflight resolves each ref once at start and drops the value. The broker resolves again at runtime. There is no caching.

If a 1Password item is deleted between engagement start and cell dispatch, the preflight passed but the runtime resolution fails. The persona surfaces a `needs_human` need (correct behavior per the Non-goals section: "A dead token surfaces at run-time as a `needs_human`").

But there is a subtler case: if the item's value changes between preflight and runtime (e.g., the user rotates the token in 1Password), the shape check at preflight validated the old value. The new value may not match the shape (e.g., a Bearer token replaced with an API key that is now 5 chars, failing the `length >= 8` check). The persona receives a value that was never shape-checked.

**Severity: low.** The preflight is a "best effort" early-exit, not a guarantee. The persona handles bad credentials as runtime surprises. But the spec should acknowledge that preflight validates a point-in-time snapshot.

---

## 3. Against the threat model

### 3.1 Tripwire removal leaves the stdout channel undefended

Part 10 had a tripwire on three seams (persist, send, egress). Part 12 drops all three as "vestigial." The stated reason: the persona doesn't hold the value.

But the persona can obtain the value through the `valet-secrets` stdout channel (finding 1.2 above). Once the value is in a tool result, it flows through:
- `engine_entries.parts` (persisted to Postgres),
- WS frames to the browser,
- the report cell's context (which can quote it into `report_markdown`).

With the tripwire removed, none of these channels have a scanner. A prompt injection that runs `echo $TOKEN` inside `valet-secrets` exfiltrates the credential with no detection or blocking.

The `beforeEntryPersist` hook survives (the spec says "the security-engagement caller is removed" but the hook stays as a general seam). But without a caller wiring the hook to a credential index, it is inert.

**Severity: high.** This is the same attack Part 10's tripwire was designed to catch, minus the defense.

**Recommendation:** Keep the `beforeEntryPersist` hook wired to a credential-pattern scanner. The scanner does not need the fingerprint index from Part 10 (there are no stored ciphertext values to fingerprint). Instead, it can use the `op://` refs to resolve values on-demand for pattern matching, or it can accept that the dispatch prompt instruction is the primary defense and document the accepted residual risk with a severity tag.

### 3.2 Sandbox token on the creds mount is accessible

The spec acknowledges that `valet-secrets` unsets `VALET_SANDBOX_TOKEN` before exec, but the token remains on the creds mount file. In a security engagement, a prompt-injected persona has strong motivation to read `/etc/valet/creds/token` and call the broker directly.

With the token, the persona can call `POST /api/sandbox-secrets/resolve` with any ref. The broker allowlist (INV-32) would reject refs outside the engagement's declared set. So the blast radius is limited to the declared refs.

But the persona already has access to the declared refs through `valet-secrets`. The additional risk is that the persona can retrieve all declared credential values in one broker call, decode the base64 responses, and stash them in a tool call argument or message. The `valet-secrets` script resolves one ref per invocation, so the persona would need N invocations to get N values. Direct broker access collapses this to one call.

**Severity: low.** The allowlist bounds the blast radius to declared refs, which the persona already has access to by design. The risk is speed of exfiltration, not scope.

### 3.3 Base64 response body readable via curl

The spec says the broker returns base64-encoded values in a positional array. A persona with the sandbox token (finding 3.2) can `curl` the broker directly and read the response body. The response is base64, but `base64 -d` is trivial.

This is the same risk as finding 3.2 (direct broker access). The allowlist limits the refs. But if the persona echoes the decoded values into a tool result, they enter the transcript with no redaction (finding 3.1).

**Severity: medium.** The combination of 3.1 + 3.2 + 3.3 creates a viable exfiltration chain: read sandbox token from creds mount, curl the broker with all declared refs, decode base64, echo values into a tool result. No tripwire catches any step.

---

## 4. Against the implementation in this PR

### 4.1 `parseSecurityConfig` regex: vault names with spaces

The `op://` regex in config.ts is:

```
/^op:\/\/[^/]+\/[^/]+\/[^/]+(\/[^/]+)?$/
```

`[^/]+` matches any character except `/`, including spaces and special characters. This is correct: 1Password vault and item names can contain spaces (e.g., `op://My Vault/Admin Token/password`). The regex accepts these.

However, the spec says: "`label` is unique per engagement; 1..128 chars; `A-Za-z0-9_.-`." The implementation does NOT validate the label against the `A-Za-z0-9_.-` pattern. The parser checks only `typeof rec.label !== "string" || rec.label.trim() === ""`. A label like `"admin token"` (with a space) or `"admin;rm -rf /"` (with shell metacharacters) would pass validation.

Since the label becomes an environment variable name in `valet-secrets run --env NAME=op://...`, a label with shell metacharacters could break the command or enable injection.

**Severity: medium.** The spec defines a label charset but the implementation does not enforce it. Shell metacharacters in labels could cause unexpected behavior in `valet-secrets`.

**Recommendation:** Add label validation to `parseSecurityConfig`:
```ts
if (!/^[A-Za-z0-9_.-]{1,128}$/.test(rec.label)) {
  throw new Error(`credentials[${i}] label must be 1-128 chars of A-Za-z0-9_.-`);
}
```

### 4.2 `NeedAnswerInput` type change: resolution is now optional

The `NeedAnswerInput` type makes `resolution` optional (`resolution?: string`). The old inline type required it (`resolution: string`).

The `resolveEngagementNeeds` function now does `(answer.resolution ?? "").trim()`. For non-credential, non-dismissed needs, the empty-string check catches the missing `resolution` case. So functionally this is equivalent.

But the route handler in `security.ts` also changed: it now builds the `NeedAnswerInput` with `...(typeof rec.resolution === "string" ? { resolution: rec.resolution } : {})`. This means a request body with no `resolution` field at all (and `dismiss: false`) will pass route validation (line 2461 checks `!dismiss && ... rec.resolution.trim() === ""`, but `rec.resolution` is `undefined` when the field is absent, so `typeof rec.resolution !== "string"` triggers a 400 at line 2460-2461). Actually, looking more carefully: the check at line 2460 is `if (!dismiss && (typeof rec.resolution !== "string" || rec.resolution.trim() === ""))` which correctly rejects missing resolution for non-dismissed needs. So this is safe.

**Severity: none.** The type change is backward-compatible. Existing callers that always send `resolution: string` still work. The route handler correctly rejects missing resolutions for non-dismissed needs.

### 4.3 `resolveEngagementNeeds` refactor: dismissed needs with no resolution text

The old code:
```ts
resolution: dismiss ? (resolution !== "" ? resolution : "Dismissed by the reviewer.") : resolution,
```

The new code:
```ts
const storedResolution = dismiss
  ? inputRes !== ""
    ? inputRes
    : "Dismissed by the reviewer."
  : inputRes;
```

Functionally identical. A dismissed need with no resolution text gets "Dismissed by the reviewer." A dismissed need with resolution text keeps the text. A non-dismissed need stores the resolution. Correct.

**Severity: none.**

### 4.4 Needs-section UI: no frontend validation of op:// format

The needs-section widget now shows "Paste an op://vault/item/field reference" as placeholder text for credential-typed needs. But the component does not validate that the pasted value matches the `op://` pattern before submission.

The route handler validates the answer, and `resolveEngagementNeeds` would reject a malformed ref during preflight. But the user gets no client-side feedback that their pasted value is wrong. They submit, wait for the round trip, and get a 400 error.

**Severity: low.** Usability issue, not a security gap. The server-side validation is the real gate.

**Recommendation:** Add a client-side regex check on the input that matches `/^op:\/\/[^/]+\/[^/]+\/[^/]+(\/[^/]+)?$/` and disables the submit button when the value doesn't match.

### 4.5 `beforeEntryPersist` hook: tested independently?

The `beforeEntryPersist` hook is added to `@valet/engine` in this PR (thread.ts, types.ts). The hook is a general-purpose seam. Part 12 says the security-engagement caller is removed but the hook stays.

The hook implementation in `Thread.applyBeforePersist` has a fail-closed design: if the hook throws, the entry is not persisted (returns `null`). This is tested implicitly by the code path, but there are no unit tests for the hook in this PR.

The hook is wired into four persist paths:
1. User message append (line ~2616)
2. Assistant entry append (line ~3460)
3. Tool execution end update (line ~3534)
4. Turn end update (line ~3598)

All four paths check `if (transformed)` before writing. If the hook returns `null` (threw), the entry is silently dropped. For path 2 (assistant entry append), this also means `this.currentAssistantEntry` is not set, so subsequent tool_execution_end events that try to update it will skip (the entry variable is scoped inside the block). This is correct fail-closed behavior.

**Severity: low.** The hook is untested but the code is structurally correct. The hook will need tests when the first caller (security tripwire or otherwise) is wired.

---

## 5. Cross-check with Part 10 supersession

### 5.1 Migration plan for shipped Part 10 tables

Part 10's checklist says items 1-8 are "Shipped." This means `engagement_credentials`, `engagement_credential_access`, `security_incidents`, and the `EngagementVault` service exist in the codebase. Part 12 says these are all removed.

Part 12's implementation checklist item 1 says "Drop `engagement_credentials`, `engagement_credential_access`, `security_incidents`." Item 2 says "Delete `packages/api/src/services/security-vault.ts`" and other files.

But there is no migration step for existing data. If any engagement has rows in `engagement_credentials`, the DROP cascades through `ON DELETE CASCADE` from `security_engagements`. But the `security_incidents` table may have rows that reference credentials. The DROP order matters.

The spec does not name a migration script or a data-cleanup step. Pre-1.0, the answer is "run `make dev-clean`" (Part 10 checklist item 9 precedent). But the spec should say so explicitly.

**Severity: low.** Pre-1.0, `make dev-clean` is the answer. The spec should name it.

**Recommendation:** Add to the implementation checklist: "Pre-1.0: `make dev-clean` clears the old tables. Post-1.0: a numbered migration drops the three tables in dependency order."

### 5.2 `beforeEntryPersist` hook tested independently

Covered in finding 4.5 above. The hook is structurally sound but untested. It stays as a general seam, which is good. When Part 12's implementation PR lands, the security caller is removed, but the hook remains available for future callers.

---

## Summary of actionable findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1.1 | Medium | Preflight errors may leak credential bytes | Add normative "reason must not contain value bytes" requirement |
| 1.2 | High | Persona can echo env var from `valet-secrets` stdout | Add stdout redaction or re-enable persist-seam tripwire |
| 1.3 | Medium | Needs routing resolves arbitrary refs before allowlist append | Document that token scope (not allowlist) gates the needs path |
| 1.5 | Medium | CHECK constraint is deferred, spec claims it as active | Add "(deferred)" note or land the constraint |
| 2.1 | Low | Allowlist-before-resolution ordering is implicit | Add normative "before resolution" statement |
| 3.1 | High | Tripwire removal leaves persist + send + egress undefended | Keep at least the persist-seam scanner wired |
| 3.3 | Medium | Direct broker + base64 decode + echo = exfiltration chain | Acknowledge or mitigate the chain |
| 4.1 | Medium | Label charset `A-Za-z0-9_.-` not enforced in parser | Add regex validation for labels |
| 5.1 | Low | No migration plan for shipped Part 10 tables | Add explicit `make dev-clean` step |

Findings 1.2 and 3.1 are related (both concern the missing tripwire). Together they represent the largest security gap in the design: the `valet-secrets` stdout channel leaks values into the transcript with no detection or blocking. The spec should either re-enable a lightweight scanner on the persist seam or document this as an accepted risk with a clear blast-radius statement.
