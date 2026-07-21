# Slack App Setup Guide

This guide walks through creating a Slack app and connecting it to Valet.

## Overview

Valet has **two** Slack integrations that share a single Slack app:

- **Slack (bot)** — org-level. One admin installs the app for the entire workspace with a bot token; individual users then link their Slack accounts via a DM verification code. The agent acts as the workspace bot. Steps 1–6 below cover this.
- **Slack (personal)** — per-user. Each user connects their own Slack account through OAuth, and the agent can act *as that user* (search, read, post under their identity). This reuses the same Slack app but needs extra one-time configuration — see [Personal (per-user) Slack setup](#personal-per-user-slack-setup).

You do not need a second Slack app for the personal integration. Add the user-token configuration to the same app you create in Step 1.

## Step 1: Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From a manifest**.
3. Select your workspace.
4. Paste the manifest from `packages/plugin-slack/slack-app-manifest.json`, replacing `YOUR_WORKER_URL` with your deployed worker URL (e.g. `https://valet.conner-7e8.workers.dev`):

```json
{
  "display_information": {
    "name": "Valet",
    "description": "AI coworker — send prompts, get results",
    "background_color": "#1a1a2e"
  },
  "features": {
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Valet",
      "always_online": true
    },
    "assistant_view": {
      "assistant_description": "Your on-demand coding assistant for your entire Slack workspace. Ask questions, automate tasks, and get coding help right in Slack.",
      "suggested_prompts": [
        {
          "title": "How are you doing?",
          "message": "Howdy doodee?! How you doing?",
        },
        {
          "title": "Give me ideas",
          "message": "Can you please describe what kinds of work you can and can't do, and give me ideas for things that you can help out with?",
        }
      ]
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "chat:write.customize",
        "chat:write.public",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "reactions:write",
        "usergroups:read",
        "usergroups:write",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://WORKER_URL/channels/slack/events",
      "bot_events": [
        "app_mention",
        "assistant_thread_started",
        "assistant_thread_context_changed",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://WORKER_URL/channels/slack/interactive"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

5. Click **Create**.

## Step 2: Install the App to Your Workspace

1. In the app settings sidebar, go to **Install App**.
2. Click **Install to Workspace**.
3. Review the permissions and click **Allow**.

## Step 3: Get the Bot Token and Signing Secret

### Bot Token

1. After installing, go to **Install App** in the sidebar.
2. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

### Signing Secret

1. Go to **Basic Information** in the sidebar.
2. Under **App Credentials**, find and copy the **Signing Secret**.

## Step 4: Configure Valet

Everything is configured through the admin UI — no environment variables needed.

1. Log in to Valet as an admin.
2. Go to **Settings > Organization**.
3. Find the **Slack** section.
4. Click **Install Slack App**.
5. Paste the **Bot User OAuth Token** (`xoxb-...`).
6. Paste the **Signing Secret** (from Basic Information > App Credentials).
7. Click **Install**.

Both values are encrypted at rest using AES-256-GCM (same as org LLM API keys).

## Step 5: Verify Events URL

After setting the signing secret and deploying:

1. Go back to your Slack app settings at [api.slack.com/apps](https://api.slack.com/apps).
2. Go to **Event Subscriptions**.
3. The Request URL should show as **Verified**. If not, click **Retry** — Slack sends a `url_verification` challenge that Valet handles automatically.

## Step 6: Link User Accounts

Each Valet user links their own Slack identity:

1. Go to **Integrations** in the Valet sidebar.
2. The **Slack** card appears (only visible if an admin has installed the app).
3. Click **Link Account**.
4. Search for your Slack username in the typeahead.
5. Select yourself — the bot will DM you a 6-character verification code.
6. Enter the code in Valet.

Once linked, messages you send in Slack channels where the bot is present will route to your orchestrator.

## Required Bot Scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | React to @Valet mentions in channels |
| `assistant:write` | Agents & AI Apps surface (thread status, suggested prompts) |
| `channels:history` | Read messages in public channels the bot is in |
| `channels:read` | Look up channel info for display labels |
| `chat:write` | Send messages and replies |
| `chat:write.customize` | Send messages with custom username/avatar (persona identity) |
| `chat:write.public` | Post in channels the bot hasn't joined |
| `files:read` | Access file attachments shared in messages |
| `files:write` | Upload files to Slack conversations |
| `groups:history` | Read messages in private channels the bot is invited to |
| `groups:read` | Look up private channel info |
| `im:history` | Read direct messages to the bot |
| `im:read` | List DM conversations (for verification flow) |
| `im:write` | Open DMs with users (for verification code delivery) |
| `reactions:write` | Add emoji reactions to messages |
| `usergroups:read` | View Slack user groups and their members |
| `usergroups:write` | Update Slack user group metadata and members |
| `users:read` | List workspace members (for the link typeahead) |
| `users:read.email` | Look up users by email for identity linking |

## Personal (per-user) Slack setup

The **Slack (personal)** integration lets each user connect their own Slack account so the agent can act *as them* (search, read, post under their identity), independent of the org bot. It uses the **same Slack app** created in Step 1, plus the one-time configuration below. This is separate from the bot flow — a user can connect their personal account whether or not they've completed the bot link in Step 6.

### Step A: Add User Token Scopes

1. Open your Slack app at [api.slack.com/apps](https://api.slack.com/apps).
2. Go to **OAuth & Permissions**.
3. Under **Scopes → User Token Scopes** (not Bot Token Scopes), add every scope in [Required User Token Scopes](#required-user-token-scopes) below.

Valet requests the full bundle on every connect and **refuses to store a partial credential**: if a workspace admin has restricted any requested scope, the connect flow fails with a `missing_scopes` error naming the gap instead of silently linking a degraded token.

### Step B: Register the OAuth redirect URL

1. Still under **OAuth & Permissions**, find **Redirect URLs**.
2. Add exactly: `${API_PUBLIC_URL}/auth/slack-user/callback`
   (e.g. `https://valet.conner-7e8.workers.dev/auth/slack-user/callback`). Use your deployed worker origin.
3. Click **Save URLs**.

Unlike the bot integration, the personal callback is served by the worker, not the client — the redirect URL must point at the worker origin.

### Step C: Set the OAuth client secrets

The personal flow uses Slack's OAuth client credentials (the bot flow does not). Find them under **Basic Information → App Credentials**, then set them as worker secrets:

```bash
wrangler secret put SLACK_CLIENT_ID --name <worker-name>
wrangler secret put SLACK_CLIENT_SECRET --name <worker-name>
```

`SLACK_CLIENT_ID` unset is the most common cause of an "Invalid client_id" error at the Slack consent screen.

### Step D: Reinstall the app

Adding User Token Scopes changes the app's grant, so reinstall once for the new scopes to take effect: **OAuth & Permissions → Reinstall to Workspace** (or **Install App → Reinstall**). Bot-token behavior is unchanged, but the bot token *value* is regenerated on reinstall — if bot actions stop working afterward, update the org bot token (Step 4) with the new `xoxb-` value.

### Step E: Connect (per user)

Each user connects their own account:

1. Go to **Integrations** in the Valet sidebar.
2. The **Slack (personal)** card appears once `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` are configured.
3. Click **Connect** and approve the Slack consent screen.

On approval, Valet stores the user's encrypted personal token and the `slack_user.*` tools become available to their orchestrator. Whenever the scope set changes (e.g. after adding scopes in Step A), each user must **reconnect** to grant them.

### Required User Token Scopes

These 33 scopes are requested as **User Token Scopes** for the personal integration. They mirror the `SLACK_USER_SCOPES` bundle in `packages/plugin-slack-user/src/actions/provider.ts` and the `oauth_config.scopes.user` array in the app manifest.

| Scope | Purpose |
|-------|---------|
| `search:read` | Search messages across the user's visible surface |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Read message history in public/private channels, DMs, group DMs |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | List and look up those conversations |
| `users:read` | List workspace members |
| `users.profile:read` | Read the user's profile |
| `team:read` | Read workspace metadata (team id/name captured at connect) |
| `chat:write` | Post messages and DMs as the user |
| `im:write`, `mpim:write` | Open a DM / group DM channel before posting (required by `send_dm`) |
| `users.profile:write` | Set the user's status/profile |
| `reactions:write`, `reactions:read` | Add and read reactions |
| `dnd:write`, `dnd:read` | Set and read Do-Not-Disturb |
| `files:read`, `files:write` | Read and upload files |
| `pins:read`, `pins:write` | Read and add pins |
| `bookmarks:read`, `bookmarks:write` | Read and add channel bookmarks |
| `stars:read`, `stars:write` | Read and add saved items |
| `reminders:read`, `reminders:write` | Read and create reminders |
| `usergroups:read`, `usergroups:write` | Read and update user groups |
| `emoji:read` | Read custom emoji |

## Troubleshooting

**Events URL won't verify**: Make sure `SLACK_SIGNING_SECRET` is set in the worker environment and the worker is deployed. The events endpoint is at `/channels/slack/events`.

**Personal connect shows "Invalid client_id"**: `SLACK_CLIENT_ID` is unset or wrong on the worker. Set it (Step C) with the value from Basic Information → App Credentials.

**Personal connect shows "redirect_uri did not match"**: The redirect URL in Step B isn't registered on the app, or doesn't exactly match the worker origin. Add `${API_PUBLIC_URL}/auth/slack-user/callback` and Save URLs.

**Personal connect redirects with `reason=missing_scopes`**: Slack didn't grant every requested scope (usually a workspace admin restriction). Add the named scopes under User Token Scopes (Step A) and reconnect.

**`slack_user.*` action fails with `missing_scope`**: The connected token predates a scope addition. Add the scope under User Token Scopes and have the user reconnect. For `send_dm` specifically, ensure `im:write`/`mpim:write` are granted.

**Personal tools don't appear in `list_tools`**: The user hasn't connected, or connected before the integration was registered — have them click **Connect** on the Slack (personal) card. Note the service slug is `slack-user`; a base filter of `slack` also surfaces it.

**Bot token rejected**: Ensure you're using the **Bot User OAuth Token** (starts with `xoxb-`), not a user token or app-level token.

**User messages not routing**: The user must have completed the identity link flow. Check that their Slack user ID appears in the `user_identity_links` table with `provider = 'slack'`.

**Bot not receiving messages in a channel**: The bot must be invited to the channel first. In Slack, type `/invite @Valet` in the channel.
