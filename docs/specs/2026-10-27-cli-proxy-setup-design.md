# CLI proxy setup

**Date:** 2026-10-27
**Status:** Proposed
**Relates to:** `docs/specs/2026-08-26-llm-proxy-mitm-design.md`, `docs/specs/2026-07-15-single-binary-cli-design.md`, `docs/specs/2026-09-04-team-api-keys-design.md`

## Scope

`valet proxy setup <harness>` points a local coding harness at the Valet LLM proxy in one step. The command mints a personal `vlt_` key, stores it in the CLI profile, and writes the harness config. The first harness is Claude Code (`claude-code`). The command shape and an adapter registry leave room for Codex and OpenCode later.

## Context

The gateway at `/proxy/anthropic/*` accepts a personal `vlt_` key and records each call under the key's user (`packages/api/src/routes/proxy-gateway.ts`). Today a person sets it up by hand. They create a key in Settings, then copy shell exports from the onboarding panel (`packages/web/src/components/usage/OnboardingPanel.tsx`).

`valet login` stores a CLI token, not an API key (`packages/api/src/cli/commands/login.ts`). Better-auth's `/api/auth/api-key/create` needs a browser session, so the CLI cannot mint a key through it.

## Decisions

1. **One command per harness.** The commands are `valet proxy setup <harness>`, `valet proxy token <harness>`, and `valet proxy remove <harness>`. If the harness is missing or unknown, the CLI lists the supported harnesses and exits non-zero.

2. **One key per harness per profile.** The profile stores `proxyKeys: { [harness]: { id, key, createdAt } }` in the CLI config. The config file is mode 0600. The key name is `<harness>@<hostname>`. Then `remove` revokes only the key of that harness, and the usage dashboard can show spend for each harness by key name.

3. **Claude Code reads the key through `apiKeyHelper`.** The adapter writes two values to the Claude Code user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`):
   - `env.ANTHROPIC_BASE_URL = <profile url>/proxy/anthropic`
   - `apiKeyHelper = "<absolute valet path> proxy token claude-code --instance <name>"`

   The key stays in one secret store. A key rotation does not edit the Claude Code settings. The helper path is absolute, so `claude` does not depend on `PATH`. The CLI resolves the path from the running single binary, or from `valet` on `PATH` in a dev run. If neither resolves, setup refuses.

4. **Claude Code supports centralized mode only.** Claude Code sends the helper value as both `x-api-key` and `Authorization: Bearer`. In pass-through mode the gateway needs the person's own provider key in `x-api-key` (`extractPassthroughKey`). The helper would replace that key. Each adapter declares the modes it supports. In pass-through mode the Claude Code adapter refuses with: "Your org's proxy runs in pass-through mode. `valet proxy setup claude-code` supports centralized mode only. Use the manual setup in Settings → Proxy." A Codex adapter can support pass-through later through `env_http_headers`.

5. **A person approves the key in the browser.** A `valet login` CLI token is an agent credential. `refuseAgentAuthority` refuses it every write outside `AGENT_WRITES`, and a new credential must not come from an agent alone. A CLI that could mint a `vlt_` key would also outlive its own disconnect in Settings > Agent access. So the CLI asks, and the person approves on the device sign-in page:
   - The CLI starts a request with `POST /api/cli/device/code { device, purpose: "proxy-key", key_name }` and sends its CLI token in `x-api-key`. The route requires a valid CLI token for this purpose, and stores its user as `requested_by`.
   - The CLI opens `/cli/device` and shows the user code. The page names the purpose, the key name, and what the key can do.
   - Only the browser session of the `requested_by` user can approve. A code that someone else sends to another person cannot give the sender a key for that person's account.
   - On the approved poll, `POST /api/cli/device/token` mints the personal key with `auth.api.createApiKey({ body: { name, userId } })` and returns it once as `{ proxy_key: { id, key, name, createdAt } }`. The plugin call takes no metadata, so it cannot write a team pin.
   - `cli_device_requests` gets `purpose` (`login` default) and `key_name`, and `requested_by`. A login request stays as it was.

   The key stays valid until the person revokes it in Settings > API keys, or runs `valet proxy remove`. The approval page says so.

6. **The key revokes itself.** `DELETE /api/proxy/keys/:id` deletes a personal key that the caller owns. The CLI sends the proxy key itself as the credential. That is a `vlt_` API key, not an agent credential, so no `AGENT_WRITES` change is needed. If the key is a team key, or another user owns it, the route returns 404. The route never confirms that a key exists for a person who cannot revoke it.

7. **The settings merge is safe.**
   - If the settings file is not valid JSON, setup refuses and writes nothing.
   - Setup keeps every key it does not own.
   - Conflicting keys are `apiKeyHelper`, `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, and `env.ANTHROPIC_API_KEY`. If one holds a value that setup did not write, setup refuses and lists each conflict.
   - `--force` overwrites the conflicts. First it writes `settings.json.valet-backup`.
   - A second run with the same profile changes nothing and reports "already configured".
   - If the shell exports `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, setup warns. Claude Code can prefer those over the helper and skip the proxy without an error.

8. **Re-runs reuse the key.** If the profile already holds a key for the harness, setup reuses it. `--rotate` requests a new key, stores it after approval, and then revokes the old key. If the revoke fails, setup warns and names the old key id. The new key stays in use.

## Command flow

### `valet proxy setup <harness>`

1. Load the selected profile. If it has no credential, exit with: "Not signed in. Run `valet login <url>` first."
2. Read `GET /api/proxy/settings`. If the gateway is off, exit with: "The Valet proxy is off for your org. An org admin can turn it on in Settings → Proxy."
3. If the adapter does not support the org's mode, exit with the adapter's refusal.
4. Ask the adapter for a plan against the current harness config. If the plan has conflicts and `--force` is not set, exit and list them. Do not mint a key yet.
5. Reuse the stored key, or request one (decision 5). Show the user code and open `/cli/device`. Wait until the person approves, denies, or the request expires after 10 minutes. Store the key in the profile.
6. Apply the plan. Print each file and key that changed, then "Start a new `claude` session to use the proxy."

Step 4 runs before step 5, so a refused setup leaves no orphan key on the server.

### `valet proxy token <harness>`

The command prints only the stored key and a newline to stdout. It makes no network call, because Claude Code runs the helper at start and on a refresh interval. If no key is stored, it exits non-zero with: "No proxy key for claude-code. Run `valet proxy setup claude-code`." on stderr.

### `valet proxy remove <harness>`

1. Ask the adapter to remove only the values that setup wrote. It leaves a changed value in place and reports it.
2. Revoke the key with `DELETE /api/proxy/keys/:id`. If the revoke fails, warn and continue.
3. Remove the key from the profile.

## Components

- `packages/api/src/cli/commands/proxy.ts`: subcommand dispatch, plus pure `runProxySetup`, `runProxyToken`, and `runProxyRemove` with injected deps, following the `login` pattern.
- `packages/api/src/cli/proxy/harnesses/index.ts`: the adapter registry and the `HarnessAdapter` interface.
- `packages/api/src/cli/proxy/harnesses/claude-code.ts`: the Claude Code adapter. Its plan, apply, and unapply functions are pure over a settings object. The file read and write is a thin shell.
- `packages/api/src/cli/config.ts`: `proxyKeys` on `ProfileConfig`.
- `packages/api/src/cli/client.ts`: `proxySettings()`.
- `packages/api/src/cli/device-login.ts`: start and poll a proxy-key request, next to the login flow.
- `packages/api/src/routes/cli-device.ts`: the `proxy-key` purpose on start, info, approve, and poll.
- `packages/api/src/routes/proxy-usage.ts`: the `DELETE /keys/:id` route.
- `packages/api/migrations/pg/0000_app.sql`, `packages/api/src/schema/index.ts`, `packages/api/src/lib/drizzle.ts`: the new `cli_device_requests` columns and their `SCHEMA_REPAIRS` entries.
- `packages/web/src/routes/cli.device.tsx`: copy for the proxy-key purpose.
- `packages/api/src/wire/types.ts`: `CliDeviceInfo.purpose` and `keyName`, and `CliProxyKeyResponse`.
- `packages/api/src/cli.ts`: the `proxy` entry and usage line.
- `docs/cli.md`: a `valet proxy` section.

```ts
interface HarnessAdapter {
  id: string;                       // "claude-code"
  modes: ReadonlyArray<"centralized" | "passthrough">;
  modeRefusal(mode: string): string;
  plan(input: { baseUrl: string; helperCommand: string }): Promise<HarnessPlan>;
  apply(plan: HarnessPlan, opts: { force: boolean }): Promise<string[]>; // changed paths
  unapply(input: { baseUrl: string; helperCommand: string }): Promise<UnapplyReport>;
}
```

## Testing

- Claude Code adapter unit tests: missing file, empty object, invalid JSON, unrelated keys kept, each conflict key, `--force` with a backup, a no-op re-run, `$CLAUDE_CONFIG_DIR`, and an unapply that leaves a changed value.
- Command tests with stub deps: not signed in, gateway off, pass-through refusal, conflict before mint (assert no mint call), reuse, `--rotate` with a failed revoke, `token` output is exactly the key, and `remove`.
- API route tests: a CLI token starts a proxy-key request, the same user's browser session approves it, and the poll returns a key once. That key then authenticates `/proxy/anthropic/v1/messages` against a stub upstream. The `llm_proxy_requests` row has the caller's user id and org id. Another user's session cannot approve it. A start without a CLI token is refused. A CLI token still cannot write `POST /api/auth/api-key/create`. DELETE refuses another user's key and a team key with 404.
- Web page test: the proxy-key purpose shows the key name and the revoke note.
- `make e2e` for a clean scorecard.

## Out of scope

- Codex and OpenCode adapters.
- Team keys from the CLI.
- Project-scoped Claude Code settings (`.claude/settings.local.json`).
- Pass-through mode for Claude Code.
