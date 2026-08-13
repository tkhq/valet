import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { googleCalendarPlugin } from "./actions/actions.js";

const skillMd = readFileSync(
  fileURLToPath(new URL("../skills/google-calendar/SKILL.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "google-calendar",
  version: "0.1.0",
  description: "Google Calendar integration for events and scheduling",
  actions: [googleCalendarPlugin],
  skills: [loadSkillFromMarkdown(skillMd, "plugin", "google-calendar")],
  credentials: [
    {
      type: "oauth2",
      // Copied verbatim from the legacy provider's oauthScopes.
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      configKeys: ["accessToken", "refreshToken"],
      connectLabel: "Connect Google Calendar",
      oauth: {
        mode: 'authorization_code',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      },
    },
  ],
};

export default plugin;
