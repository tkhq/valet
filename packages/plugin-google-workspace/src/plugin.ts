import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { googleWorkspacePlugin } from "./actions/actions.js";

// Static string literals (not a `${file}` template) so the single-binary
// esbuild bundle's inline-assets plugin can statically resolve and inline
// each skill's bytes at build time — see packages/api/build/inline-assets.mjs.
const driveMd = readFileSync(fileURLToPath(new URL("../skills/google-drive/SKILL.md", import.meta.url)), "utf8");
const docsMd = readFileSync(fileURLToPath(new URL("../skills/google-docs/SKILL.md", import.meta.url)), "utf8");
const sheetsMd = readFileSync(fileURLToPath(new URL("../skills/google-sheets/SKILL.md", import.meta.url)), "utf8");

const plugin: ValetPlugin = {
  name: "google-workspace",
  version: "0.1.0",
  description: "Google Workspace integration — Drive, Docs, and Sheets with unified OAuth and labels-based access guard",
  actions: [googleWorkspacePlugin],
  skills: [
    loadSkillFromMarkdown(driveMd, "plugin", "google-drive"),
    loadSkillFromMarkdown(docsMd, "plugin", "google-docs"),
    loadSkillFromMarkdown(sheetsMd, "plugin", "google-sheets"),
  ],
  credentials: [
    {
      type: "oauth2",
      // Copied verbatim from the legacy provider's oauthScopes (WORKSPACE_SCOPES).
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.labels.readonly",
      ],
      configKeys: ["accessToken", "refreshToken"],
      connectLabel: "Connect Google Workspace",
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
