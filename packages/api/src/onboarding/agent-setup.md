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

## Step 1. Install the CLI

1. Run `valet --version`.
2. If the command is not found, install the CLI:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tkhq/valet/dev-v2/scripts/install.sh | bash
   ```

3. The installer puts `valet` in `~/.local/bin`. If `valet` is still not found, add `~/.local/bin` to `PATH` for this shell: `export PATH="$HOME/.local/bin:$PATH"`.
4. Run `valet --help`. The command list must include `tools`. If it does not, the CLI is older than this instance. Run the install command in item 2 again. It replaces the old binary.

## Step 2. Log in

You run the login. The person approves it in their browser.

1. Tell the person: "I am logging the Valet CLI in to {{VALET_URL}}. Your browser will open. Check that it names this computer, then choose Allow."
2. Run this command. It waits up to 5 minutes for the approval, so allow a long timeout:

   ```sh
   valet login {{VALET_URL}} --name valet
   ```

3. If the browser does not open, the command prints a URL. Give that URL to the person.
4. If Valet asks the person to sign in first, they sign in, and the approval page then opens.

The CLI receives its key directly from Valet. You never see it.

When the command prints `logged in`, run `valet status`. The output must show `ok: true` for {{VALET_URL}}. If `valet status` shows another instance, run `valet instance use valet`.

## Step 3. Connect MCP

MCP gives you the Valet tools directly. The CLI also works without MCP.

**Claude Code.** Run this from the project's root directory:

```sh
valet mcp setup claude-code
```

This adds a `valet` server to `.mcp.json` in the current directory. The entry holds only the URL, no secret. To make Valet available in every project instead, run:

```sh
claude mcp add --transport http valet {{VALET_URL}}/mcp --scope user
```

The first time Claude Code connects, it opens a browser to sign in to Valet. Ask the person to complete the sign-in. If the browser does not open, ask the person to run `/mcp` in Claude Code and choose Authenticate for `valet`.

**Other agents.** Run `valet mcp setup --print`. It prints a standard MCP server entry for {{VALET_URL}}/mcp. Add that entry where your agent reads MCP servers. The server signs in with OAuth. If your agent cannot run OAuth, tell the person, and continue with the CLI only.

## Step 4. Install the Valet skill

The skill tells you when and how to use Valet. Claude Code asks the person to approve a write under `~/.claude`. For Claude Code:

```sh
mkdir -p ~/.claude/skills/valet
curl -fsSL {{VALET_URL}}/agent-skill.md -o ~/.claude/skills/valet/SKILL.md
```

For another agent, save the same file where that agent reads skills or standing instructions.

## Step 5. Check the setup

1. Run `valet threads list`. It must exit with code 0.
2. Run `valet tools search github`. It must exit with code 0 and list tools. A listed tool does not prove that its service is connected. Report a service as connected only after a `valet tools call` to it succeeds.
3. If MCP is connected, call the `whoami` tool, then `list_workspaces`.
4. Tell the person what works: the CLI login, MCP, and the skill. Name anything that failed, and its fix.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `valet login` exits with code 5 | The person chose Deny, or did not approve within 5 minutes. Ask them, then repeat step 2. |
| `valet` exits with code 5 on another command | The CLI key was revoked. Repeat step 2. |
| `valet login` waits, but the browser shows "This site can't be reached" for `127.0.0.1` | The browser runs on another computer than the CLI. Ask the person to run `valet login {{VALET_URL}} --name valet --api-key -` in their own terminal on this computer, with a key from {{VALET_URL}}/settings/api-keys. |
| `valet` exits with code 6 | Valet is not reachable. Check {{VALET_URL}}/api/health in a browser or with `curl`. |
| macOS says the binary is damaged | Run `xattr -d com.apple.quarantine ~/.local/bin/valet`. This happens only after a browser download. |
| `valet` says `unknown command: tools` or `threads` | The CLI is too old. Repeat step 1 to reinstall it. |
| `valet send` or `valet chat` fails with "lost connection" | The CLI is too old. Repeat step 1 to reinstall it. |
| `.mcp.json` has an `Authorization` header with `<MCP_OAUTH_TOKEN>` | An old CLI wrote it. Reinstall the CLI (step 1), delete the `valet` entry, and run step 3 again. |
| An MCP call returns 401 | The sign-in expired or did not finish. Ask the person to authenticate again (step 3). |
| A tool returns `approval_required` | The organization's policy needs a person to approve that action. Do not retry it. Ask Valet to do it with `start_thread`, or tell the person. |
