# Part 06: Loot Catalog

*Depends on: Part 00, Part 05. Conformance: L3.*

## Purpose

This part fixes the `/loot/catalog.yml` schema, the atomic-write semantics for updates, and the session-propagation mechanics. L3 conformance requires loot catalog writes and cookie-jar propagation.

## Where the loot lives

`/loot/catalog.yml` is a virtual path in the engagement tree, backed by `security_files` revisions (base design's `sec_fs_*` shape). The pivot-coordinator is the only writer (via the new `sec_loot_write` tool, §6.4). Every persona MAY read via `sec_fs_read`.

Cookie jars live at `/loot/cookies-<session id>.txt` (Netscape format). Every session row in the catalog names its jar path.

## `loot.catalog.yml` schema

Normative.

```yaml
schema_version: 1                  # integer, MUST be 1
credentials:
  - id: <string>                   # unique per engagement (e.g. "c-human-1", "c-auto-1")
    source: <string>               # "human-provided" | "create-test-account"
    username: <string>
    password: <string>             # plaintext in v1 (Appendix C §C.3 for v2 encryption)
    role: <string>                 # "admin" | "user" | "readonly" | "<other>"
    created_at: <iso8601 UTC>
sessions:
  - id: <string>                   # "s-human-1", "s-auto-1"
    cred_id: <string or null>      # credential id (null if session was provided directly)
    host: <string>                 # host the cookies target
    cookie_jar: <path>             # relative to engagement root, e.g. "loot/cookies-s-human-1.txt"
    expires_at: <iso8601 UTC or null>
test_data:
  - id: <string>                   # "td-human-1"
    kind: <string>                 # "payment-card" | "ssn" | "test-file" | "<other>"
    source: <string>               # "human-provided"
    payload: {}                    # kind-specific (§6.2)
tool_auth:
  - id: <string>                   # "ta-human-1"
    tool: <string>                 # "nuclei" | "burpsuite" | "<other>"
    source: <string>               # "human-provided" | "tool-auth-reuse"
    payload: {}                    # tool-specific (§6.3)
```

**Id prefixes** (informative naming convention):
- `c-human-*`: human-provided credential.
- `c-auto-*`: create-test-account credential.
- `s-human-*`: session from human credential (or provided directly).
- `s-auto-*`: session from auto-created credential.
- `td-human-*`: human-provided test data.
- `ta-human-*`: human-provided tool auth.
- `ta-cache-*`: tool-auth-reuse (v2 shared store).

**Full example.**

```yaml
schema_version: 1
credentials:
  - id: c-human-1
    source: human-provided
    username: admin@example.com
    password: SecureP@ss123
    role: admin
    created_at: 2026-08-31T16:00:00Z
sessions:
  - id: s-human-1
    cred_id: c-human-1
    host: api.example.com
    cookie_jar: loot/cookies-s-human-1.txt
    expires_at: null
test_data:
  - id: td-human-1
    kind: payment-card
    source: human-provided
    payload:
      card_number: "4242424242424242"
      cvv: "123"
      expiry: "12/28"
tool_auth: []
```

## `test_data.payload` formats

Normative for the three built-in kinds. Personas MAY define custom kinds; the payload is then free-form JSON, consumed only by the persona that wrote the need.

### `payment-card`

```yaml
kind: payment-card
payload:
  card_number: <string>            # 13-19 digits
  cvv: <string>                    # 3-4 digits
  expiry: <string>                 # MM/YY
```

### `ssn`

```yaml
kind: ssn
payload:
  ssn: <string>                    # 9 digits, dashes allowed
```

### `test-file`

```yaml
kind: test-file
payload:
  filename: <string>
  content_base64: <string>         # base64 file content
  mime_type: <string>              # e.g. "application/pdf"
```

## `tool_auth.payload` formats

### `nuclei`
```yaml
tool: nuclei
payload:
  api_key: <string>                # Pro templates API key
```

### `burpsuite`
```yaml
tool: burpsuite
payload:
  license_key: <string>            # Pro license key
```

Custom tools MAY define their own payload shape.

## Atomic writes and the `sec_loot_write` tool

The coordinator MUST use the new `sec_loot_write` engine tool to update `/loot/catalog.yml`. Direct `sec_fs_write` to `/loot/catalog.yml` is REJECTED by the server (server-side path-scope check).

**Tool signature (normative):**
```
sec_loot_write {
  credentials?: [<CredentialInput>, ...],  # to append or update
  sessions?:    [<SessionInput>, ...],
  test_data?:   [<TestDataInput>, ...],
  tool_auth?:   [<ToolAuthInput>, ...],
  cookie_jars?: [{ session_id, netscape_text }, ...]  # atomic bundle with sessions
}
```

**Semantics.**
1. Load the current `/loot/catalog.yml` revision (empty catalog when none exists).
2. Merge inputs by `id`. A new id appends. An existing id updates (last-write-wins on updates).
3. Serialize the merged catalog to YAML.
4. Write the new revision through the same `security_files` append-only path.
5. Write every `cookie_jars[<session id>].netscape_text` to `/loot/cookies-<session id>.txt` in the SAME server-side transaction as the catalog write.

**Why an atomic bundle?** A session row references its cookie jar. If the catalog names `s-human-1.cookie_jar: loot/cookies-s-human-1.txt` but the jar file is empty (a crash between the two writes), a persona reading the catalog and the jar sees inconsistent state. `sec_loot_write` commits both in one server-side transaction, so a coordinator crash between the two is not observable.

**Concurrency.** Only the pivot-coordinator writes loot. `sec_loot_write` requires the acting session to be a `pivot-coordinator` cell; every other persona is refused with 403. The coordinator runs serially (one cell at a time per the base design's cell rules), so there is no intra-engagement race.

**INV-4 idempotence.** A repeat call with the same inputs is a no-op (last-write-wins by id, so the catalog is the same shape).

## Cookie jar format

Netscape cookies.txt. Plaintext, tab-separated, one cookie per line.

```
# Netscape HTTP Cookie File
# This is a generated file. Do not edit.
api.example.com	FALSE	/	TRUE	0	session_id	abc123xyz
api.example.com	FALSE	/	TRUE	1735344000	csrf_token	def456uvw
```

**Fields** (per line): `domain`, `include_subdomains`, `path`, `secure`, `expiry_epoch`, `name`, `value`. Curl, wget, and Python `requests` read this format.

**Why Netscape?** Universal support. Personas run `curl --cookie loot/cookies-s-human-1.txt <url>` without a parser step.

## Session propagation

The `propagate-session` auto-catalog pattern (Part 05 §5.6) uses `sec_loot_write` with the `cookie_jars` field to atomically copy an existing jar text into a new path under the target persona's cell dir. The catalog does NOT record per-cell jar copies; the source jar (`/loot/cookies-<source id>.txt`) is authoritative, and copies under `/cells/<target NN>-<slug>/loot/` are per-cell working copies.

**Why not symlink?** Symlinks are not part of the engagement tree (paths back-store to `security_files` rows, which store bytes). Every propagation is a full byte copy. This costs storage but keeps the tree flat and portable.

## Cross-engagement isolation

INV-7 (Part 00) and the base design's engagement-scoped `security_files` rule: `/loot/catalog.yml` in engagement A is NOT readable from engagement B. Every `security_files` row carries an `engagement_id`; `sec_fs_read` filters on it. Cross-engagement loot reuse is v2 (Appendix C §C.6).

## Loot encryption

v1 stores loot in plaintext. Deployment-level mitigations:
- Engagement trees are readable only by the engagement's owning organization users.
- Sandboxes reading `/loot/*` are isolated per-cell.
- Human-provided credentials SHOULD be revoked after engagement close.
- Ephemeral synthetic accounts (`create-test-account`) SHOULD be disabled after engagement close.

v2 encryption is Appendix C §C.3.

## Loot id generation

Counter-based, per engagement.

- Credential ids: sequential `c-human-<n>` and `c-auto-<n>`. Coordinator maintains the counter in state doc log.
- Session ids: `s-human-<n>` / `s-auto-<n>`. One session id per source (credential id or direct human provision).
- Test data ids: `td-human-<n>` / `td-auto-<n>`.
- Tool auth ids: `ta-human-<n>` / `ta-cache-<n>`.

**Determinism.** Coordinator retries generate the same ids (`n` is the count of previously-committed rows of that prefix, read from the current catalog). This is the mechanism behind INV-4.

## Conformance

**L0.** No loot at L0.

**L1.** No loot at L1.

**L2.** No loot at L2. The coordinator (discover mode) writes NO loot; every need surfaces to human.

**L3.** Coordinator MUST use `sec_loot_write`. Catalog schema MUST match §6.1. Session propagation MUST copy the cookie jar text.

**L4.** Same as L3, plus `create-test-account` writes credential + session rows; `tool-auth-reuse` writes tool_auth rows.
