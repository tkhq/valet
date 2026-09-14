# Part 12: Security Engagement Credentials via 1Password

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 09. Conformance: L1+ (config, preflight, broker allowlist); L3 pulls in the delivery path.*

Depends on the landed 1Password subsystem:

- `OnePasswordService` in `packages/api/src/services/onepassword.ts`.
- The sandbox secret broker at `POST /api/sandbox-secrets/resolve` in `packages/api/src/routes/sandbox-secrets.ts`.
- The `valet-secrets` CLI generator in `packages/api/src/engine/secrets-cli-script.ts`.
- The scope walk `resolveAcrossScopes` and the owner rule `onePasswordScopesFor` in `packages/api/src/services/credential-resolution.ts`.
- The shared declaration vocabulary in `packages/shared/src/security-credentials.ts`.
- The team-vault design in `docs/specs/2026-09-04-team-onepassword-vaults-design.md`.

Part 11 reads this part. This part does not read Part 11.

## Purpose

A security engagement's persona often needs a live credential: a login for a web app under test, an API token for the target's admin console, a signing key for an authenticated protocol test. Valet must not hold a copy of that value. 1Password already holds it, and the landed sandbox secret broker already gets a resolved value into a sandbox child's environment without the api process needing to keep it.

Part 12 specifies four things. First, how a security engagement declares which 1Password references it needs. Second, how those declarations are validated before any cell dispatches. Third, how the broker's existing per-owner scope check gains a per-engagement layer. Fourth, how the system detects a persona that echoes a resolved value back into the transcript.

- Secrets stay in 1Password. A security engagement holds only `op://vault/item/field` references.
- The persona child sandbox never mounts a value as a file. `valet-secrets run --env NAME=op://... -- cmd` runs one shell child with the value in its environment for the duration of one command.
- One carve-out: an `mtls` credential. `curl --cert` and `curl --key` read paths, not environment variables. The `mtls` usage hint writes the key and the certificate into a `mktemp -d` directory, sets mode 600, and deletes the directory on exit through a shell `trap`. The files live inside the one launcher child, not on a mount Valet controls.
- The broker gains a per-engagement allowlist, checked before it resolves anything for a security session (INV-34).
- `kind` is explicit in the YAML and drives the shape check plus the persona's usage hint.
- A prompt-injected persona can still echo the environment variable into the shell's stdout, which flows back as a tool result. The tripwire (INV-35) is the enforcement; the dispatch prompt telling the persona not to echo is guidance, not the safety net.

## Vocabulary

**Scope.** One of `org`, `personal`, `team`. `onePasswordScopesFor(ownerType, teamId?)` returns the ordered list a resolver may consult: `["team","org"]` for a team-owned engagement, `["org","personal"]` for a user-owned one, `["org"]` otherwise. Team is authoritative when configured; only an absent team token permits an org fallback. A configured team token that refuses a specific reference does not fall back.

**Declaration grammar.** `packages/shared/src/security-credentials.ts` in `@valet/shared` is the single authority for what a declared credential may say. It holds the seven `kind` values (`SECURITY_CREDENTIAL_KINDS`), the label rule (`CREDENTIAL_LABEL_RE`, `CREDENTIAL_LABEL_MAX`), the environment-variable rule (`CREDENTIAL_ENV_RE`), the reference grammar (`OP_REFERENCE_RE`, `isOnePasswordReference`), the reserved launcher names (`RESERVED_CREDENTIAL_LABELS`), the strict entry point `validateCredentialDecl` (and `validateCredentialDecls`), and the tolerant column reader `parseDeclaredCredentials`. The create route, the repository config parser, the broker allowlist, and the setup form all call this module. None of them reprints a rule.

**op:// reference.** A string that satisfies `isOnePasswordReference`. The grammar is 3 or 4 segments: `op://vault/item/field` or `op://vault/item/section/field`. Segments may contain spaces. Segments may not contain `/` or control characters.

**Auth error.** `OnePasswordAuthError` with `kind: "no_token" | "disabled" | "sdk" | "scope" | "reference" | "ambiguous"`. Preflight distinguishes all six values (see INV-33 below).

**Engagement credentials.** A per-engagement list of declared references, `SecurityConfig.credentials[]`, each `{label, kind, env, reference, refShape?, meta?}`. Declared in `.valet/security.yml`, or in the setup wizard's Advanced Credentials sub-section, before the review starts. Nothing declares a credential mid-run. Persisted on `security_engagements.credentials_json`. Ephemeral: it dies with the engagement, and this part adds the column (see Implementation checklist).

**Broker.** The sandbox-authenticated `POST /api/sandbox-secrets/resolve` route. Called by the in-sandbox `valet-secrets` script. Returns base64-encoded values in a positional array, one per requested reference.

**Preflight.** A validation pass run by `seedSecurityReview` at engagement start. Resolves each declared reference once, shape-checks it by `kind`, and drops the value. On failure the engagement refuses to seed with a corrective error (INV-33).

**Cred-typed need.** A `security_needs` row whose `kind` is `credential`. That enum value already exists on dev-v2. Its answer names a credential the engagement already declared: the human picks a `label`, and the resolve path stamps that label on `security_needs.credential_label` (a new column). `resolution` stays `NULL`. The answer never carries an `op://` reference, and the handler never declares a credential mid-run.

## Owner precedence

The owner rule `onePasswordScopesFor(ownerType, teamId?)` decides the ordered scope list a preflight or resolve may consult. A team-owned engagement's declared references resolve against `["team","org"]`. A user-owned engagement's references resolve against `["org","personal"]`. A repo-owned or workspace-owned engagement's references resolve against `["org"]`. A team engagement whose team token is configured but refuses a specific reference does not fall back to org for that reference; a configured team is authoritative.

## Global invariants

New for v2 (INV-33 through INV-36), then four invariants carried forward from the prior draft, renumbered to sit above Part 11's INV-30 and INV-31.

**INV-33 (Preflight resolves every declared reference under the owner rule).** At engagement start, `seedSecurityReview` iterates `securityConfig.credentials` and resolves each declared reference through `resolveAcrossScopes`, the same scope walk the broker runs at run time. The scope order comes from `onePasswordScopesFor(ownerType, teamId?)`. The value is discarded immediately after a shape check by `kind`. A failed resolve refuses the seed with a corrective error keyed on `OnePasswordAuthError.kind`:

- `no_token`: name the scopes tried and the settings path to connect a token.
- `disabled`: name the org toggle (Organization > 1Password > Allow personal) that must be flipped.
- `scope`: name which scopes were tried and ask the user to move the item or pick another scope.
- `reference`: name the credential that failed and hint that the item may have been deleted or renamed.
- `ambiguous`: say the reference matches more than one item and ask for a section segment.
- `sdk`: name the operation only; do not leak upstream text or the token.

**Scope fall-through.** A non-team scope that refuses one reference falls through to the next scope in the list. A configured team scope stops the walk on anything but `no_token`: a team token that exists and refuses is authoritative. When every scope refused, the reported error is the first refusal whose kind is not `no_token` and not `disabled`, because those two kinds name a missing token rather than a wrong reference. The last refusal is reported only when every refusal is one of those two kinds.

A seventh outcome, `shape_failed`, is distinct from all six `OnePasswordAuthError.kind` values: the reference resolved but the resolved value failed the `kind`'s shape check (see Preflight validation below). Its corrective error names the shape rule, never the value.

**INV-34 (Broker allowlist is per-engagement).** The broker gates access by owner scope and the sandbox token principal. A second gate permits only the current running cell in a running security engagement. The runner, settled cells, and replaced child sessions cannot resolve or find engagement credentials. The broker loads `security_engagements.credentials_json` and refuses references outside the declared list before it calls `resolveReference`. The list includes each primary `reference` and each mTLS `meta.certRef`. Non-security sessions continue to use owner-scope gating. A refused request returns 403 and does not name other allowlisted references.

**INV-35 (Tripwire seed is a broker resolve for a security cell).** When the broker resolves a reference for a running security cell, it registers the value and its common encodings in the per-session tripwire index, grouped by engagement. The engine scans tool inputs and results before model consumption, persistence, and event emission. A matching output atom becomes a fixed security error with no credential bytes. Security file and finding routes also refuse matching input before a write. The host drops the session entry when the cell settles or its session is destroyed. INV-35 is a safety net with a stated residual (see Tripwire below). INV-34 remains the primary control.

**INV-36 (`commandWrapperScript` alignment).** `commandWrapperScript` (`packages/api/src/engine/secrets-cli-script.ts`) accepts a `CredentialCommand`. A repository declaration wraps a same-named binary. A security credential sets `launcher: true`, which runs the command in the wrapper's arguments. `label` names the launcher's `command`. `env` and `reference` pass through unchanged. An mTLS declaration also injects `meta.certRef` as `${env}_CERT` in the same launcher call. `kind`, `refShape`, and `meta` otherwise stay security-only. They drive preflight and the dispatch prompt. One generator serves both surfaces. The persona runs `<label> <command> [args...]` without seeing a reference.

**INV-37 (No credential value at rest in Valet).** No table, column, log, event, entry, report, or artifact holds a credential value or ciphertext. Postgres carries `op://` references only. A future column that would carry an encrypted or decrypted credential fails code review. Every error thrown during preflight, resolution, or broker dispatch must not include any byte of the resolved value; the catch block around `OnePasswordService.resolveReference` strips the upstream error message and substitutes the `OnePasswordAuthError.kind`-keyed reason from INV-33.

**INV-38 (Persona MAY glimpse the value; the tripwire is the safety net).** The dispatch prompt tells the persona not to echo the value. That is guidance, not enforcement. The persona knows the launcher label `admin` and the environment name `ADMIN`, because the prompt names both. A prompt-injected persona can therefore run `admin sh -c 'echo $ADMIN'`; the launcher child's stdout flows back as a tool result and lands in the persisted entry and on the wire. INV-35 is the enforcement: the tripwire scans every persist and every send against the per-session tripwire index, grouped by engagement, and hard-fails a match.

**INV-39 (Cred-typed need never carries the value).** `security_needs.resolution` stays `NULL` for a cred-typed need. The value never rides in the resolution column, in a request body, or in a wire answer frame. The needs panel sends one field, `credentialLabel`, naming a credential the engagement already declared. The service layer refuses an answer that carries a non-empty `resolution` on a cred-typed need, with the message "A credential need takes a credential label, not a resolution. Choose a declared label in credentialLabel and leave resolution empty." A database CHECK constraint on `security_needs` enforces the same rule on every write.

**INV-40 (Reference is not a value).** Storing, logging, or emitting an `op://` reference is safe. A reference alone does not authorize resolution; the broker still enforces the sandbox token, the session's token scope, and the allowlist (INV-34). A reference can appear in logs and on the wire without redaction. This does not license a reference in the dispatch prompt. The prompt names labels only, because a reference in the prompt teaches the persona a destination the broker would answer for (see Persona invocation).

## Credential shape and delivery

Seven `kind` values, each mapping to a persona-side usage pattern the dispatch prompt spells out. The `reference` for each kind resolves to a single 1Password field's value (a string). Consider a multi-field bundle, for example an X-Stamp-style tool credential carrying a public key, a private key, an org id, and a user id. Declare either one credential per field with related labels, or one `toolAuth` credential whose `refShape: json` says the field value is JSON that the persona's launcher parses.

| kind | Ref value | Persona usage |
|---|---|---|
| `password` | password bytes (login URL and username live in `meta`) | Launcher posts the login URL with `-d "user=<username>&pass=$PASSWORD"` |
| `session` | Netscape cookie jar bytes | Launcher feeds `-b -` from `$COOKIES_JAR` into curl |
| `headerToken` | token bytes | Launcher sends `Authorization: <scheme> $TOKEN` |
| `mtls` | private key PEM (certificate through a second reference in `meta.certRef`) | Launcher writes key and certificate to a `mktemp -d` directory and runs curl with `--cert`/`--key` |
| `signingKey` | private key PEM or hex bytes (algorithm in `meta.algo`, key id in `meta.keyId`) | Launcher signs a request body with `$SIGNING_KEY` |
| `toolAuth` | opaque blob (`meta.tool` names the consumer, `meta.format` in `{json, raw}`) | Launcher parses `$TOOL_AUTH` (jq if `json`) and uses its fields |
| `testData` | opaque value (label and scope in `meta`) | Launcher sends `$TEST_DATA` as the request body |

## Persona invocation

Each declared credential surfaces in the dispatch prompt as a launcher label. The dispatch prompt names labels, not references. A reference is not a secret (INV-40), but the prompt still withholds it: a persona that knows a reference knows a destination the broker would answer for, and the prompt is the persona's only source for either.

Every usage hint is a quoted `sh -c` script, invoked as `sh -c '<script>' sh <url>`. The single quotes delay `$VAR` expansion until after the launcher injects the value, and the literal `sh` fills `$0` so the URL lands in `$1`. The `commandWrapperScript` generator in `packages/api/src/engine/secrets-cli-script.ts` produces repository wrappers and security launchers from one code path.

The dispatch prompt renders each credential as:

```md
--- Credentials ---

Available credentials (resolved at run-time; the value never appears in this transcript):
- admin -> command "admin" (usage: run `sh -c 'curl -H "Authorization: Bearer $ADMIN" "$1"' sh <url>`; the quoted script expands only after injection)
- signer -> command "signer" (usage: run `sh -c 'your-signer --key "$SIGNER" "$1"' sh <url>`; the quoted script expands only after injection)

Example: `admin <the command that needs this credential>`

The wrapper resolves the credential and injects it into that one command's environment. It is not in this turn's transcript. Do not print the wrapper's output verbatim if it might contain the value.
If the target rejects the credential, raise a `credential` need naming the label; the human replaces the reference.
```

## Config schema

`SecurityConfig.credentials`:

```yaml
credentials:
  - label: admin
    kind: headerToken
    env: ADMIN
    reference: op://Security/admin-token/credential
    meta:
      host: api.example.com
      scheme: Bearer
  - label: turnkey-preprod
    kind: toolAuth
    env: TOOL_AUTH
    reference: op://Security/turnkey-preprod/bundle
    refShape: json         # the 1Password field body is JSON; the wrapper parses the env value
    meta:
      tool: turnkey-x-stamp
      format: json
```

Rules. Every one of them lives in `@valet/shared`'s `validateCredentialDecl` (see Declaration grammar above); this list is the reading, not a second copy.

- `label` is unique per engagement and identifies the credential to the persona and in the needs panel. It also names a launcher under `/usr/local/bin`. It must start with a letter or digit and contain at most 128 letters, digits, periods, underscores, or hyphens (`CREDENTIAL_LABEL_RE`, `CREDENTIAL_LABEL_MAX`). `RESERVED_CREDENTIAL_LABELS` reserves `git-credential-valet`, `valet-gh`, `gh`, `valet-secrets`, `op`, `sec-preflight`, `gitleaks`, and `semgrep`.
- `env` is the variable name the launcher injects and must match `CREDENTIAL_ENV_RE` (letters, digits, underscore; not starting with a digit), the same shape `export` accepts.
- `kind` is one of the seven values in `SECURITY_CREDENTIAL_KINDS`, listed in Credential shape and delivery above.
- `reference` must satisfy `isOnePasswordReference`.
- `refShape` defaults to `raw`; `json` is an assertion that the resolved value parses as JSON.
- `meta` is an opaque per-kind sidecar of text values (host, algorithm, scheme, tool, format, role, key id, and so on). One key has a meaning: `meta.certRef` on an `mtls` declaration names the certificate's `op://` reference, and the broker allowlist and the preflight both read it.

Persisted on `security_engagements.credentials_json` as the array literal above.

## Preflight validation

At `seedSecurityReview` (`packages/api/src/services/security-seed.ts`), before any sandbox exists:

1. Load the declared credentials. The request may declare them, and `.valet/security.yml` may declare them. Both lists preflight the same way: a repository-declared credential is not trusted more than a request-declared one. An explicit empty request list is authoritative and suppresses the repository list.
2. For each entry, resolve `reference` through `resolveAcrossScopes` using the scopes `onePasswordScopesFor(ownerType, teamId?)` returns for the engagement's owner.
3. Shape check by `kind`:
    - `password`: value length at least 1 (allow any bytes).
    - `session`: value contains at least one line matching the Netscape cookie format (`\thostOnly\tpath\tsecure\texpiry\tname\tvalue`).
    - `headerToken`: value length at least 8.
    - `mtls`: value contains `-----BEGIN (RSA |EC )?PRIVATE KEY-----`; if `meta.certRef` is present, check its grammar, resolve it, and check the certificate contains `-----BEGIN CERTIFICATE-----`.
    - `signingKey`: value contains `-----BEGIN ` or matches `^[0-9a-fA-F]{32,}$` (hex bytes).
    - `toolAuth`: if `refShape === "json"`, `JSON.parse` succeeds; otherwise value length at least 1.
    - `testData`: value length at least 1.
4. Zero every buffer used in the check (`Buffer.fill(0)` in a `finally` block).
5. On failure, refuse the seed with a corrective error naming the label and one of two outcomes: an `OnePasswordAuthError.kind` (see INV-33) when `resolveReference` threw, or `shape_failed` when the value resolved but the kind's shape check refused it.
6. On every error path, the error text must not contain any byte of the resolved value. A `shape_failed` reason names the shape rule (for example, "headerToken value length is 3; minimum is 8"), never the value bytes.

**Two modes: report and refuse.** The same preflight runs on two routes and answers differently.

- `POST /api/sessions/security/preview` runs it in report mode. Each declaration preflights on its own, and a failure becomes one `{label, message}` entry in `credentialWarnings` on a 200 response. The wizard shows the warnings and the user can still read the plan. Preview refuses nothing over a credential.
- `POST /api/sessions` (create) runs it in refuse mode. The first failure refuses the seed. An engagement never starts with a credential the broker could not resolve.

Preflight never contacts the target host. A 401 at run time is a run-time surprise, not a config failure; the persona surfaces it as a fresh `needs_human`. Preflight validates a point-in-time snapshot: a value rotated in 1Password between preflight and cell dispatch may pass preflight and fail at run time with no preflight warning.

## Broker allowlist enforcement

Extend `POST /api/sandbox-secrets/resolve` (`packages/api/src/routes/sandbox-secrets.ts`):

1. From `c.var.sandbox`, look up the `security_cells` row that names the calling session.
2. Permit the caller only if the cell and its engagement are both `running`.
3. Refuse the engagement runner, a settled cell, or a replaced child whose watch points to the runner.
4. If the caller is not part of a security engagement, use owner-scope gating only.
5. For a permitted cell, load `securityEngagements.credentials_json`.
6. Check each request against every primary `reference` and mTLS `meta.certRef`. Return 403 on a miss.
7. Run this check before `OnePasswordService.resolveReference`.
8. On pass, use the existing owner-scope resolution.

The check is O(references × declared), bounded in practice (declared references are typically under 10; the broker already caps a request at `MAX_REFERENCES = 25`).

**`POST /api/sandbox-secrets/find` carries the same lifecycle gate.** Discovery answers a search term with vault, item, and field titles. A security runner or a stale child must not enumerate those names. So `/find` runs the same caller classification as `/resolve`. A refused caller gets 403 and the message "Only a running security persona cell may search for engagement credentials." `/find` does not apply the reference allowlist: the caller supplies no reference, and the answer carries no value.

**Boot-time observability.** `startEngagement` (`packages/api/src/services/security-engagements.ts`) records the declared credential count once, at the same planning-to-running write that materializes the cells. The metric is the histogram `valet.security.engagement.credentials_declared`, with bucket boundaries 0, 1, 2, 5, 10, and 20. It carries no attributes: an engagement id and a label set are unbounded cardinality, so they go in the log line beside it, never on the metric. An engagement with no declared credentials still records, at 0, so absence is a signal, not a silence. This is a read of the broker's own allowlist source (`credentials_json`), not a second registry: the broker keeps reading `credentials_json` directly on every resolve.

## Tripwire

INV-38's threat is real. The dispatch prompt tells the persona not to echo the value, but a prompt-injected persona can run `admin sh -c 'echo $ADMIN'` with the launcher the prompt names, and the child's stdout flows back as a tool result. The persona can also read the sandbox token and curl the broker directly with any allowlisted reference, decode the base64 response, and echo the value into a tool result. Either channel puts the plaintext in the transcript unless something catches it.

The tripwire is the safety net.

### Index

The per-session tripwire index, grouped by engagement, is populated on every permitted security-cell broker resolve. One entry holds one session's registered values and names the engagement the session belongs to; a resolve for a different engagement replaces the entry. The index matches the raw value, standard base64, base64url, and URL encoding. Base64 matching ignores ASCII whitespace. Two checks run on every atom. The first is the whole-value check: the atom contains a complete encoded value. The second is coverage: the index keeps one mark per character of each encoded value and sets the marks the session has already emitted. Unrelated output does not erase this taint, so a later fragment that completes the value is blocked before it reaches the model. Each entry lives until the cell settles or its session is destroyed.

Coverage only tracks runs of `MIN_CREDENTIAL_FRAGMENT` characters or longer, which is eight. At registration, the matcher indexes every window of exactly eight characters in the value. A value of eight characters or fewer is skipped: it carries no coverage index at all, so only a whole-value occurrence matches it. Do not build windows of `min(8, length)` instead. A shorter window is the false-positive path the minimum exists to close. The minimum exists because shorter runs mark common characters as covered, and ordinary source output then completes a value it never carried. Coverage blocks at 90 percent of one encoded form (`BLOCK_FRACTION`), not only at 100 percent: a copy of the value with one character altered is a leak of everything but that character, and the whole-value check never sees it. When an encoded form first reaches half covered (`ALERT_FRACTION`), the tripwire raises the counter `valet.security.credential_fragment_alerts` once for that form and logs the session and the engagement. It does not block on that signal: half a value is not a leak, and a human reads the transcript.

The scan is linear. Each candidate consumes each character of an atom once, so a persona cannot stall the api event loop by emitting near copies of a value it can read.

**Accepted residual.** The residual is a copy with characters altered at a fixed spacing, and it costs the persona two atoms, not a long drip. A copy altered every eighth character carries no run of eight, so coverage never sees it and no alert fires. A copy altered every ninth character stays at eight ninths covered, which raises the alert and does not block. A fragment shorter than eight characters is invisible to coverage in the same way. Two compensating controls cover this residual. The first is the launcher contract (INV-36 in this part): a launcher runs one command with the value in its environment, so the value is not in persona-readable output to start with. The second is rotation: rotate the 1Password item after the engagement, which retires any copy a persona kept.

### Persist seam

The engine scans tool arguments and results before it persists them. The security file and finding routes scan content again before the service writes it. A match returns a fixed security error that does not contain the value.

### Send seam

The engine sanitizes tool events before it emits them. It disables raw tool-argument deltas after the session resolves an engagement credential. The same sanitized result is stored for later REST reads.

### Cleanup

- When a cell completes or fails, its session entry is dropped.
- When the engine destroys a session, its entry is dropped.
- The tripwire index is independent of the broker cache.

### Egress seam (accepted risk)

The in-sandbox gateway does not filter a `valet-secrets` child's stdout or stderr before it crosses back to the api. A persona that echoes a value into a tool result carries plaintext across the sandbox-to-api boundary until the persist or send seam catches it. This window is short, one bus event, but it exists. In-sandbox redaction inside `valet-secrets` itself is a documented follow-up, not required here.

## Needs routing

A cred-typed need is answered by picking a credential the engagement already declared. The handler never declares one.

- The needs panel widget is a picker over the engagement's declared labels. It has no value input and no reference input. When the engagement declared no credential, the picker is disabled and the panel names the setup wizard's Advanced section as the place to declare one.
- `POST /api/sessions/:id/security/needs/resolve` for a cred-typed need takes one field, `credentialLabel`.
- The handler:
  1. Refuses the answer when `resolution` is non-empty (INV-39).
  2. Refuses the answer when `credentialLabel` is empty, unless the answer dismisses the need.
  3. Refuses the answer when the label is not in the engagement's declared labels, and names the setup wizard's Advanced section as the remedy.
  4. Sets `security_needs.credential_label` to the label and leaves `resolution` `NULL`.
  5. Resets the cell to pending (existing Part 09 behavior).
- The dispatch that follows renders the answer as a launcher instruction naming the label. The reference never enters that line.

## Wire API

New:
- `SecurityEngagementWire.credentialLabels: string[]` on `GetSessionSecurityResponse`. The labels the engagement declared, in declaration order. This is the read surface for the needs picker and the engagement panel's credential badges. There is no separate credentials endpoint: the engagement read surface carries labels only. `SecurityPreviewResponse.config.credentials` is the one place a reference reaches the browser, and it carries what the repository declared, which INV-40 permits.
- `SecurityNeedWire.credentialLabel: string | null`. The label that answered a cred-typed need.
- `SecurityCredentialWarningWire: { label, message }`, returned as `SecurityPreviewResponse.credentialWarnings` (see Preflight validation, report mode).

Extended:
- `POST /api/sessions/:id/security/needs/resolve` accepts `credentialLabel` for a cred-typed need, and rejects `resolution` on one.
- `POST /api/sessions/security/preview` accepts an optional `teamId`. The route checks that the caller is a member of that team before it preflights, so a preview resolves under the team's scopes exactly as the created engagement will.
- `POST /api/sandbox-secrets/resolve` gains the per-engagement allowlist check (INV-34) for sessions owned by a security cell; every other caller is unaffected.
- `POST /api/sandbox-secrets/find` gains the same lifecycle gate, without the reference allowlist (see Broker allowlist enforcement).

## Non-goals

- **Cross-engagement credential sharing.** Two engagements sharing one credential still declare the same `reference` in both configs. 1Password is the shared store; Valet does not reference-share.
- **Live-target validation at preflight.** Preflight checks the shape, never the target. A dead token surfaces at run time as a `needs_human`.
- **In-browser vault picker.** The wizard accepts a pasted `op://` reference. Listing a user's 1Password vaults from the browser is a future ergonomic pass.
- **In-sandbox egress-seam redaction.** The persist and send seams catch value bytes that reach the api process. A `valet-secrets` child that echoes a value into a tool result carries plaintext across the sandbox-to-api boundary until the persist or send seam catches it. Wrapping the child's own stdout inside `valet-secrets` is a follow-up, not required here.
- **Zero value memory in the api.** The api process holds resolved values in memory for the calling session's lifetime, as a byproduct of the broker's resolution and the tripwire's index. This is a bounded, documented residual risk under Tripwire above.
- **A tripwire index that survives one process.** The index lives in the memory of the api process that served the resolve. Two consequences follow, and both are accepted here. Across replicas: a resolve served by one replica registers only there, so a seam running in another replica sees no candidate and does not block. Across restarts: an api restart drops the index while the sandboxes keep running, so a value resolved before the restart is no longer matched. A shared index would need shared state that holds credential values outside one process, which INV-37 rules out. INV-34 is the primary control and is unaffected: it reads `credentials_json` from Postgres on every resolve.
- **Sub-minimum fragment detection.** Coverage cannot see a fragment shorter than eight characters, and does not try to. The Accepted residual paragraph under Tripwire names the two compensating controls.

## Implementation checklist

### Landed in PR 523

1. **Schema.** `security_engagements.credentials_json JSONB`. `security_needs.credential_label TEXT`, plus the CHECK constraint `security_needs_credential_resolution_null`, which refuses a non-NULL `resolution` on a `kind='credential'` row (INV-39). `packages/api/migrations/pg/0000_app.sql` and `packages/api/src/schema/index.ts` are edited in place (pre-1.0 rule). `packages/api/src/lib/drizzle.ts` carries three `SCHEMA_REPAIRS` entries: one for `security_engagements.credentials_json`, one for `security_needs.credential_label`, and one for the constraint under a `constraint` probe kind that queries `pg_constraint`. The constraint needs its own probe because a database that has the column but lost the constraint would otherwise never regain it, and the repair report would stay silent. Run `make dev-clean` in every worktree with dev data after the edit.
2. **Shared declaration vocabulary.** `packages/shared/src/security-credentials.ts` holds the kinds, the label, environment-variable, and reference rules, the reserved labels, `validateCredentialDecl`, `validateCredentialDecls`, and `parseDeclaredCredentials`. The create route, `packages/plugin-security/src/lib/config.ts`, the broker allowlist, and `ConfigForm` all read it.
3. **Seed preflight.** `seedSecurityReview` runs the INV-33 pass through `resolveAcrossScopes`, in report mode for preview and refuse mode for create. A request-declared list and a repository-declared list preflight identically.
4. **Broker allowlist.** `packages/api/src/routes/sandbox-secrets.ts` classifies the caller with `classifySecurityBrokerCaller`, loads `credentials_json`, and checks every requested reference before any `resolveReference`. `/find` carries the same lifecycle gate.
5. **Tripwire index population.** A permitted security-cell broker resolve calls `registerSecurityCredentialValue(sessionId, engagementId, value)`.
6. **Tripwire persist seam.** `packages/engine/src/thread.ts` scans tool arguments and tool results, live and on replay. `packages/api/src/routes/security.ts` scans the security file and finding routes before the service writes.
7. **Tripwire send seam.** The engine sanitizes tool events before it emits them, and disables raw tool-argument deltas once the session has resolved an engagement credential.
8. **Tripwire session cleanup.** `clearSecurityCredentialSession` drops a session's entry when its cell settles and when the engine destroys the session.
9. **Needs routing.** The cred-typed branch of the needs-resolve handler takes `credentialLabel`, checks it against the engagement's declared labels, stamps `security_needs.credential_label`, and leaves `resolution` null. A non-empty `resolution` on a credential need is refused. An undeclared label is refused and names the setup wizard's Advanced section as the remedy.
10. **Dispatch prompt.** `buildDispatchPrompt` renders each declared credential as a launcher command with an `sh -c` usage hint, per Persona invocation above. A resolved credential need's "Resolved needs" line names the label, never the reference.
11. **Wire routes.** `credentialLabels` on `SecurityEngagementWire`, `credentialLabel` on `SecurityNeedWire`, `credentialWarnings` on `SecurityPreviewResponse`, and an optional `teamId` on the preview request.
12. **Web.** Part 13's Implementation status section lists the landed web surfaces: the wizard's Credentials sub-section, the needs picker, the Launch step rows, and the engagement panel's credential badges. This part does not repeat them.
13. **Observability.** The `valet.security.engagement.credentials_declared` histogram and the `valet.security.credential_fragment_alerts` counter, each with the log line that carries the ids.

### Follow-up

- **Engagement-level tripwire cleanup.** Dropping every session's index entry the moment an engagement is cancelled. Today cleanup is per session: a cancelled engagement's entries drop as each cell settles or each session is destroyed.
- **A shared tripwire index.** See Non-goals: the index is process-local by design today.
- **In-sandbox egress-seam redaction.** Wrapping the `valet-secrets` child's own stdout. See the Egress seam section.
- **Preset-driven credential rows.** Source-only presets seed no credential today, and a live preset does not pre-open the Credentials sub-section with empty rows.
- **An in-browser vault picker.** See Non-goals.

Every landed step above closes at least one invariant from Global invariants; every invariant has at least one step.
