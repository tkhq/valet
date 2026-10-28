# CLI proxy setup

**Date:** 2026-10-27
**Status:** Implemented (PR #1072)
**Relates to:** `docs/specs/2026-08-26-llm-proxy-mitm-design.md`, `docs/specs/2026-07-14-auth-v2-design.md`, `docs/specs/2026-07-15-single-binary-cli-design.md`, `docs/specs/2026-09-04-team-api-keys-design.md`

## Scope

`valet proxy setup <harness>` points a local coding harness at the Valet LLM proxy in one step. The command gets a proxy key that the person approves in the browser, stores it in the CLI profile, and writes the harness config. The first harness is Claude Code (`claude-code`). The command shape and an adapter registry leave room for Codex and OpenCode later.

## Context

The gateway at `/proxy/anthropic/*` accepts a personal `vlt_` key and records each call under the key's user (`packages/api/src/routes/proxy-gateway.ts`). Before this change, a person set it up by hand. They created a key in Settings, then copied shell exports from the onboarding panel (`packages/web/src/components/usage/OnboardingPanel.tsx`).

`valet login` stores a CLI token, not an API key (`packages/api/src/cli/commands/login.ts`). A CLI token is an agent credential: `refuseAgentAuthority` refuses it every write outside `AGENT_WRITES`.

Claude Code chooses one credential in a fixed order: `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then a claude.ai login (https://code.claude.com/docs/en/authentication#authentication-precedence). Managed settings that set `forceLoginMethod` or `forceLoginOrgUUID` stop Claude Code from starting with a key helper.

## Decisions

1. **One command per harness.** The commands are `valet proxy setup <harness>`, `valet proxy token <harness>`, and `valet proxy remove <harness>`. If the harness is missing or unknown, the CLI lists the supported harnesses and exits 2. `--help` exits 0.

2. **One key per harness per profile.** The profile stores `proxyKeys: { [harness]: { id, key, name, createdAt } }` in the CLI config. The config file is mode 0600. The key name is `<harness>@<hostname>`. Then `remove` revokes only the key of that harness, and the usage dashboard can show spend for each harness by key name. `valet login` to the same URL keeps `proxyKeys`, because signing in again is how a person recovers an expired CLI sign-in.

3. **Claude Code reads the key through `apiKeyHelper`.** The adapter writes two values to the Claude Code user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`):
   - `env.ANTHROPIC_BASE_URL = <profile url>/proxy/anthropic`
   - `apiKeyHelper = "[VALET_DATA_DIR=<dir>] <valet path> proxy token claude-code --instance <name>"`

   The key stays in one secret store. A key rotation does not edit the Claude Code settings. The helper path is absolute, so `claude` does not depend on `PATH`. The path is the running binary, unless the CLI runs as a script under `node` or `bun`; then it is the first `valet` on `PATH`. A release binary keeps its download name (`valet-darwin-arm64`), so the file name is not the test. `VALET_DATA_DIR` goes into the command when it is set, because a harness started from an IDE may not inherit the shell environment.

   Before setup writes the settings, it runs the helper command once in a shell and checks that it prints the stored key. If it does not, setup prints the command and its error, and leaves the settings unchanged. This catches an older `valet` on `PATH`.

4. **Claude Code supports centralized mode only.** Claude Code sends the helper value as both `x-api-key` and `Authorization: Bearer`. In pass-through mode the gateway needs the person's own provider key in `x-api-key` (`extractPassthroughKey`). The helper would replace that key. Each adapter declares the modes it supports. In pass-through mode the Claude Code adapter refuses and points to Settings > Proxy. A Codex adapter can support pass-through later through `env_http_headers`.

5. **A person approves the key in the browser.** A new credential must not come from an agent alone. So the CLI asks, and the person approves on the device sign-in page:
   - The CLI starts a request with `POST /api/cli/device/code { device, purpose: "proxy-key", key_name }` and sends its CLI token in `x-api-key`. The route requires a valid CLI token for this purpose, and stores its user as `requested_by`.
   - The response echoes `purpose`. An older instance ignores `purpose` and starts a sign-in, so the CLI stops when the echo is missing, before it opens the browser.
   - The CLI opens `/cli/device` and shows the user code. The page names the purpose, the key name, and what the key can do.
   - Only the browser session of the `requested_by` user can approve. Another account gets the same "nothing is waiting" answer as an unknown code, with a hint to sign in with the CLI's account. A code that someone sends to another person cannot give the sender a key for that person's account.
   - On the approved poll, `POST /api/cli/device/token` mints the key with `auth.api.createApiKey({ body: { name, userId, metadata: { scope: "proxy" } } })` and returns it once as `{ proxy_key: { id, key, name, created_at } }`.
   - `cli_device_requests` gets `purpose` (`login` default), `key_name`, and `requested_by`, with `SCHEMA_REPAIRS` entries. A login request stays as it was.
   - The server's expiry and rate-limit messages name no command. The CLI adds the command to run again.

6. **A proxy key works only at the gateway.** The key sits in a local file that agents on the computer can read. `identityFromApiKey` refuses a key with `metadata.scope = "proxy"`, so the key cannot call the Valet API, approve gates, or act as the person. The gateway verifies keys on its own path and accepts it. The key stays valid until the person runs `valet proxy remove` or `valet logout`, or revokes it in Settings > API keys. Disconnecting the CLI does not revoke it. The approval page says so.

7. **The CLI token reads and revokes its proxy keys.** `GET /api/proxy/keys/:id` answers 200 for a proxy key the caller owns that is enabled and not expired. `DELETE /api/proxy/keys/:id` revokes one. Both answer 404 for any other key, so they never confirm a key exists to a caller who cannot manage it. `DELETE` is the one new `AGENT_WRITES` route. Removing a key grants nothing, and the route deletes only proxy-scoped keys.

8. **Setup checks before it changes anything.** All of these run before the key request, so a refused setup leaves no key behind:
   - The gateway is on, and the adapter supports the org's mode.
   - **Admin policy.** The adapter reads `managed-settings.json` and `managed-settings.d/*.json`. It refuses when they set `forceLoginMethod`, `forceLoginOrgUUID`, `apiKeyHelper`, `env.ANTHROPIC_BASE_URL`, or an `allowedProviders` list without `customEndpoint`. `--force` does not skip this. The CLI cannot read MDM profiles or server-managed settings.
   - **Shell keys.** If the shell exports `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, Claude Code uses it before the helper and sends it to the proxy, which fails. Setup refuses. `--force` skips this check, and setup then warns after it writes. An exported `ANTHROPIC_BASE_URL` gets a warning.
   - **Settings conflicts.** If `apiKeyHelper`, `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, or `env.ANTHROPIC_API_KEY` holds a value that setup did not write, setup refuses and lists each one. `--force` replaces them after it saves `settings.json.valet-backup`. A helper with this harness and instance's arguments counts as setup's own value, wherever the valet binary was.

9. **The settings write is safe.** If the settings file is not valid JSON, setup refuses and writes nothing. Setup keeps every key it does not own. It writes a temp file in the same directory and renames it, so a crash cannot leave half a file. It writes through a symlinked settings file to its target and keeps the file mode. A second run changes nothing and reports "already set up".

10. **Re-runs check the stored key.** If the profile holds a key for the harness, setup reads `GET /api/proxy/keys/:id`. If the key still works, setup reuses it. If the person revoked it, setup says so and requests a new key. `--rotate` requests a new key, stores it after approval, and then revokes the old key. If the revoke fails, setup warns and names the old key id.

11. **Agents can finish setup.** An agent's command can time out during the ten-minute approval wait. Setup saves a waiting request in `pendingProxyKeys` in the CLI config, keyed by `<profile>/<harness>`. A later setup resumes it, and its first poll is immediate. `--no-wait` starts or resumes the request, prints the code, and exits. A denied or expired request is forgotten, so the next setup starts a new one.

12. **Setup says what changes.** After it writes the settings, setup prints that the helper ranks above a claude.ai login, so model use bills through Valet and not the person's Claude subscription. It also prints that a repository's `.claude/settings.json` or `settings.local.json` can override the values, and tells the person to start a new `claude` session and check `/status`.

## Command flow

### `valet proxy setup <harness>`

1. Load the selected profile. If it has no CLI token, exit 5 and name `valet login <url>`. An API key profile and a stub-auth profile get their own message.
2. Read `GET /api/proxy/settings`. If the gateway is off, or the adapter does not support the mode, exit 1.
3. Find the valet binary. Run the adapter preflight (decision 8). Plan the settings change.
4. Check, reuse, or request the key (decisions 10 and 11). Store it.
5. Run the helper and compare its output with the key (decision 3).
6. Apply the plan. With `--rotate`, revoke the old key. Print warnings, the notices, and the next step.

### `valet proxy token <harness>`

The command prints only the stored key and a newline to stdout. The dispatcher skips the CLI sign-in refresh for it, so it makes no network call. If no key is stored, it exits 5 with "No proxy key for claude-code on instance "<name>". Run `valet proxy setup claude-code`." on stderr.

### `valet proxy remove <harness>`

1. Ask the adapter to remove only the values that setup wrote for this instance. A changed value, or another instance's setup, stays and is reported. An unreadable settings file is reported, and the revoke still runs.
2. Revoke the key with `DELETE /api/proxy/keys/:id`. A 404 counts as revoked. Any other failure warns and names Settings > API keys.
3. Remove the key from the profile.

### `valet logout <name>`

For each harness in the profile's `proxyKeys`, logout runs the `remove` steps first. Logout skips the usual sign-in refresh, so it refreshes an expired access token itself before the revoke.

## Components

- `packages/api/src/cli/commands/proxy.ts`: `runProxy` with injected deps, `removeProxySetup` (shared with logout), and `realProxyDeps`.
- `packages/api/src/cli/proxy/harnesses/index.ts`: the adapter registry and the `HarnessAdapter` interface.
- `packages/api/src/cli/proxy/harnesses/claude-code.ts`: the Claude Code adapter. Its plan, unapply, and managed-policy functions are pure. The file reads and the atomic write are a thin shell.
- `packages/api/src/cli/commands/login.ts`, `logout.ts`: keep keys across login; undo setup on logout.
- `packages/api/src/cli/config.ts`: `proxyKeys` on `ProfileConfig`, and `pendingProxyKeys`.
- `packages/api/src/cli/client.ts`: `proxySettings()`, `proxyKeyStatus()`, `deleteProxyKey()`.
- `packages/api/src/cli/device-login.ts`: start and poll a proxy-key request, next to the login flow.
- `packages/api/src/cli.ts`: the `proxy` entry, and the refresh skip for `proxy token`.
- `packages/api/src/routes/cli-device.ts`: the `proxy-key` purpose on start, info, approve, and poll.
- `packages/api/src/routes/proxy-usage.ts`: `GET` and `DELETE /keys/:id`.
- `packages/api/src/middleware/auth.ts`: the proxy-scope refusal and the `AGENT_WRITES` entry.
- `packages/api/src/proxy/principal.ts`: gateway 401 messages that name `valet proxy setup`.
- `packages/api/migrations/pg/0000_app.sql`, `packages/api/src/schema/index.ts`, `packages/api/src/lib/drizzle.ts`: the new `cli_device_requests` columns.
- `packages/web/src/routes/cli.device.tsx`: copy for the proxy-key purpose.
- `docs/cli.md`: the `valet proxy` section.

```ts
interface HarnessAdapter {
  id: string;                                   // "claude-code"
  label: string;                                // "Claude Code"
  modes: readonly ("centralized" | "passthrough")[];
  modeRefusal(mode: ProxyMode): string;
  preflight(env: NodeJS.ProcessEnv): { blockers: string[]; shellBlockers: string[]; warnings: string[] };
  plan(target: HarnessTarget): HarnessPlan;     // { path, changes, conflicts, apply({ force }) }
  unapply(target: Pick<HarnessTarget, "instanceUrl" | "helperArgs">): HarnessUnapplyReport;
  notices: string[];
  nextStep: string;
}
```

## Testing

- Claude Code adapter unit tests: the settings merge and unapply (including another instance's setup), each managed-policy key, the shell preflight, invalid JSON, `--force` with a backup, and a symlinked settings file.
- Command tests with stub deps: every refusal before the key request, `--no-wait` and resume, a denied request, a revoked stored key, `--rotate`, a helper that fails or prints another key, `token`, `remove`, and `--help`.
- Login tests: keys kept for the same URL, dropped with a warning for another URL.
- API route tests: the full flow against real auth, with the `purpose` echo, the account binding, the one-time key, the 401 on the Valet API, a recorded gateway call, the status route, the revoke, and the gateway 401 message.
- Web page test: the proxy-key copy and the not-found hint.
- A live run against a real-auth API with Claude Code.
- `make e2e`.

## Out of scope

- Codex and OpenCode adapters.
- Team keys from the CLI.
- Project-scoped Claude Code settings (`.claude/settings.local.json`).
- Pass-through mode for Claude Code.
- A "proxy only" label on keys in Settings > API keys.
