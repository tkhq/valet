# Set up Valet for a local agent

These instructions are for a coding agent (Claude Code, Codex, Cursor, or a similar tool) on a person's computer. Follow them to connect to the Valet instance at {{VALET_URL}}.

Valet is your organization's agent platform. After setup, you can:

- Use the integrations your organization connected (GitHub, Slack, Linear, Google, and others). Valet holds the credentials and applies the organization's tool policies.
- Hand long or remote work to the Valet assistant and get the result back.
- Read and write the team's shared memory, skills, workflows, and published artifacts.

## Rules

1. Never ask the person to paste an API key, token, or password into the conversation. The person types secrets into their own terminal or browser only.
2. Never print, log, or commit a secret. If a command shows a secret, do not repeat it.
3. Do not approve Valet approval requests. You can answer a question that Valet asks. An approval needs the person.
4. Do the steps in order. If a step fails, stop and use the troubleshooting section.
5. If your sandbox blocks a command (network access, a local port, or a write to `~/.valet` or `~/.claude`), ask the person to allow it. If they cannot, give them the command to run in their own terminal.

The person needs a Valet account at {{VALET_URL}}. If they do not have one, ask them to get an invite from a Valet admin before you start.

## Step 1. Install the CLI

On Windows, run these steps in WSL. The installer supports macOS and Linux only.

1. Run `valet --version`.
2. If the command is not found, install the CLI:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tkhq/valet/dev-v2/scripts/install.sh | bash
   ```

3. The installer puts `valet` in `~/.local/bin`. If `valet` is still not found, add `~/.local/bin` to `PATH` for this shell: `export PATH="$HOME/.local/bin:$PATH"`.
4. Run `valet --help`. The command list must include `tools`. If it does not, the CLI is older than this instance. Run the install command in item 2 again. It replaces the old binary.

## Step 2. Log in

You run the login. The person approves it in a browser.

1. Start the sign-in. This command prints a code such as `BCDF-GHJK` and exits at once:

   ```sh
   valet login {{VALET_URL}} --name valet --no-wait
   ```

2. Give the person the code and this text: "Open {{VALET_URL}}/cli/device, sign in if Valet asks, type the code, check that the page names this computer, and choose Allow. Tell me when you are done."
3. When the person says they are done, finish the sign-in. This command picks up the same code and prints `logged in`:

   ```sh
   valet login {{VALET_URL}} --name valet
   ```

   If the person has not chosen Allow yet, the command waits for them, for up to 10 minutes from step 1.

The browser can be on any computer, so this also works over SSH. The CLI receives a CLI token directly from Valet, not an API key. It signs out after 30 days without use. The person can disconnect it in Settings > Agent access. It cannot approve requests or change policies.

When the command prints `logged in`, run `valet threads list`. It must exit with code 0. If it exits with code 5, repeat this step. If `VALET_INSTANCE` is set in the environment, it overrides the login: unset it, or set it to `valet`.

## Step 3. Connect MCP

MCP gives you the Valet tools directly. The CLI also works without MCP. Run the command for your agent:

| Agent | Command | Then ask the person to |
|---|---|---|
| Claude Code | `valet mcp setup claude-code` | Restart Claude Code, run `/mcp`, choose `valet`, and choose Authenticate. |
| Codex | `valet mcp setup codex` | Run `codex mcp login valet`. |
| Cursor | `valet mcp setup cursor` | Restart Cursor. If it does not ask to sign in, open Cursor Settings > MCP and sign in to `valet`. |

Each command adds the `valet` server for every project. No file goes into the repository, and no secret is written. For another agent, run `valet mcp setup --print` and add the printed entry where the agent reads MCP servers. If the agent cannot run OAuth, tell the person, and continue with the CLI only.

In the browser, the person checks the app name and chooses Allow. They can disconnect the app later in Settings > Agent access.

You can use the MCP tools only after the agent restarts. Continue with the CLI until then.

## Step 4. Install the Valet skill

The skill tells you when and how to use Valet. Your agent may ask the person to approve the write.

**Claude Code:**

```sh
mkdir -p ~/.claude/skills/valet
curl -fsSL {{VALET_URL}}/agent-skill.md -o ~/.claude/skills/valet/SKILL.md
```

**Codex:**

```sh
mkdir -p ~/.codex/skills/valet
curl -fsSL {{VALET_URL}}/agent-skill.md -o ~/.codex/skills/valet/SKILL.md
```

For another agent, save the same file where that agent reads skills or standing instructions.

## Step 5. Check the setup

1. Run `valet threads list`. It must exit with code 0.
2. Run `valet tools search github`. It must exit with code 0 and list tools. A listed tool does not prove that its service is connected. Report a service as connected only after a `valet tools call` to it succeeds.
3. If MCP is connected in this session, call the `whoami` tool, then `list_workspaces`. If the person still has to restart the agent, say that MCP is set up and needs that restart.
4. Tell the person what works: the CLI login, MCP, and the skill. Name anything that failed, and its fix.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `valet login` exits with code 5 | The person chose Deny, or did not approve within 10 minutes. Ask them, then repeat step 2 from item 1. |
| The page says no sign-in waits for the code | The code is wrong, expired, or was used. Check the code from item 1. If it expired, repeat step 2 from item 1. |
| Your command timeout stopped `valet login` in item 3 | Run item 3 again. It resumes the same sign-in. |
| `valet` exits with code 5 on another command | The CLI was disconnected, or was not used for 30 days. Repeat step 2. |
| `valet` exits with code 6 | Valet is not reachable. Check {{VALET_URL}}/api/health in a browser or with `curl`. |
| macOS says the binary is damaged | Run `xattr -d com.apple.quarantine ~/.local/bin/valet`. This happens only after a browser download. |
| `valet` says `unknown command: tools` or `threads` | The CLI is too old. Repeat step 1 to reinstall it. |
| `valet send` or `valet chat` fails with "lost connection" | The CLI is too old. Repeat step 1 to reinstall it. |
| `.mcp.json` has an `Authorization` header with `<MCP_OAUTH_TOKEN>` | An old CLI wrote it. Reinstall the CLI (step 1), delete the `valet` entry from `.mcp.json`, and run step 3 again. |
| An MCP call returns 401 | The sign-in expired, did not finish, or the person disconnected the app. Ask the person to authenticate again (step 3). |
| A tool returns `approval_required` | The organization's policy needs a person to approve that action. Do not retry it. Ask Valet to do it with `start_thread`, or tell the person. |
