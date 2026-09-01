# Sandbox Secret Broker and `valet-secrets` — Design

**Date:** 2026-09-01
**Status:** Implemented (feat/onepassword-credentials-v2)
**Branch:** `feat/onepassword-credentials-v2` → PR against `dev-v2`

## Purpose

Give an agent inside a sandbox a way to use a credential without reading it.

The 1Password credential provider (`docs/specs/2026-07-21-onepassword-credentials-design.md`)
resolves references for tools that run inside the api process. Its non-goals list
excluded the sandbox side, so an agent that needed a credential for a shell
command had only bad options: ask the user to paste one, or read one out of a
file. Both put the secret in the transcript, and a transcript is forwarded,
logged, and replayed.

The shape follows the Infisical CLI. An agent never receives a secret. It names
a destination, and the value is placed there.

    valet-secrets run --env GITHUB_TOKEN=op://Eng/GitHub/token -- gh pr list

## Scope

- `POST /api/sandbox-secrets/resolve` — the broker, authenticated by the
  sandbox token rung.
- `valet-secrets` — a generated POSIX shell script installed into
  `/usr/local/bin` by the existing `credential-scripts` prep step.
- One paragraph in `CODING_SYSTEM_PROMPT` naming the command.

**Non-goals:** listing the secrets a token can read (naming a destination is a
different capability from browsing a vault); a second provider behind the
broker; per-session reference allowlists; write access of any kind.

## Decisions

1. **The agent never holds the secret.** A tool that RETURNS a credential puts
   it in the model's context and in every log downstream. Naming a destination
   does not. This is the whole point of the feature, and every other decision
   follows from it.

2. **No bespoke auth.** The `x-valet-sandbox` rung in `middleware/auth.ts`
   already verifies the token every sandbox is started with and sets
   `c.var.sandbox`. The route requires that principal and reads `orgId` and
   `userId` from it, never from a header or a cookie. The credential is
   therefore agent-scoped and time-boxed by construction: a leaked token is
   worth its remaining lifetime, for one session's principal.

3. **A sandbox principal only.** An earlier revision read `c.var.user`, which
   the sandbox rung never sets. That answered a signed-in browser session and
   threw on the CLI's own requests. The sibling browse route
   (`/api/onepassword/items`) deliberately strips field values; a route that
   returns them must not be reachable by a cookie.

4. **Values cross as base64.** The caller is a POSIX shell with no JSON parser.
   A byte-level extractor cut every value at its first `"` and never unescaped
   a backslash or a newline, so a password containing a quote and every private
   key arrived corrupted but plausible — the worst way for a credential to
   fail. The base64 alphabet contains no JSON metacharacter, so the shell can
   cut the field safely and `base64 -d` restores the exact bytes.

5. **A generated script, not a runner or an image layer.** `git-credential-valet`
   set the precedent. The sandbox already carries `VALET_SANDBOX_TOKEN` and
   `VALET_API_URL`, and the prep step already installs generated scripts, so
   the CLI needs no image change and no new process.

6. **The token does not reach the child.** `VALET_SANDBOX_TOKEN` resolves every
   reference the broker will answer. A command given one secret must not
   inherit the key to the rest, so the script unsets it before `exec`.

## Flow

1. The agent runs `valet-secrets run --env NAME=op://vault/item/field -- cmd`.
2. The script reads the token from `/etc/valet/creds/token`, or from
   `VALET_SANDBOX_TOKEN` when no creds mount exists.
3. It POSTs every reference in one request to `/api/sandbox-secrets/resolve`.
4. The route resolves each reference through `OnePasswordService`, org scope
   first, then the personal scope of the user the session runs as.
5. The response carries `resolvedBase64` and `unresolved`.
6. The script decodes each value, unsets the sandbox token, exports the
   variables, and `exec`s the command.

The value crosses this boundary once, into a process the model does not read.

## Errors

Every failure names a corrective action, per the repo rule.

| Condition | Exit | Behavior |
| --- | --- | --- |
| Bad variable name | 2 | Refused before any shell sees the pair. The shell's own error for a bad identifier quotes the value next to the name. |
| Malformed arguments | 2 | Usage, including how to quote a reference containing a space. |
| Reference nothing resolved | 3 | Names the reference and what to check in 1Password. |
| Broker refused or was unreachable | 4 | Reports the API's own message. |

`curl` runs without `-f` and the status is checked separately: `-f` discards
the body, and the body carries the message the API composed.

## Reachability

`valet-secrets` exists only where the `credential-scripts` prep step runs, which
is where a session has a `SpecProvider`. Two builders wire one:
`EngineHost.sessionFor` and `EngineHost.buildChildSession`. Both pass
`CODING_SYSTEM_PROMPT`, so the prompt paragraph covers exactly the population
that can run the command.

Orchestrator and workflow sessions are sandbox-less by design (`host.ts`, the
`warmSandboxOnClaim: false` paths) and run no prep, so they do not have the
command. The orchestrator persona says to delegate credential work to a child,
next to the existing sentence about git and GitHub credentials. Workflow session
nodes receive `CODING_SYSTEM_PROMPT` without prep, so they are told about a
command they do not have; the paragraph's failure mode there is a
command-not-found, not a leaked secret.

## Testing

- `packages/api/src/routes/sandbox-secrets.test.ts` — resolves and names
  misses, requires a sandbox token and names the fix without one, names every
  unsupported reference, and round-trips a value containing a quote, a
  backslash, and a newline.
- `packages/api/src/engine/prompt-rules.test.ts` — the composed prompt names
  the command and the reference shape.
- `packages/api/src/engine/sandbox-spec.test.ts` — golden spec hashes cover the
  installed script, so editing it re-installs on sandboxes that already ran prep.
- Verified by hand against a real vault, in a real docker sandbox, with a real
  sandbox token: the secret reaches the child, `VALET_SANDBOX_TOKEN` does not,
  nothing is printed, and a coding session given only vault, item, and field
  names in prose chose the command on its own.

## Known limits

- The `org` scope crosses user boundaries inside the org. That is the point of
  a shared service account, and it is the same reach the api-side resolver
  already has, but this route returns plaintext values with no admin gate, no
  rate limit, and no audit record. An audit trail is the first thing to add.
- The token is passed on `curl`'s argv, so a same-uid process in the sandbox can
  read it from `/proc` during the request. This is shared with
  `git-credential-valet`, but the broker raises what the token is worth from one
  repo's git token to every vault the org service account can read.
- The injected value is visible in the child's `/proc/<pid>/environ` to a
  same-uid process. Environment delivery is the CLI's contract, not a defect,
  but it is not the same claim as "never leaves the process".
- `base64` must exist in the sandbox image. The script names the fix when it
  does not.
