import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";
import { googleWorkspacePlugin } from "./actions/actions.js";

function readSkill(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../skills/${file}`, import.meta.url)), "utf8");
}

const plugin: ValetPlugin = {
  name: "google-workspace",
  version: "0.1.0",
  description: "Google Workspace integration — Drive, Docs, and Sheets with unified OAuth and labels-based access guard",
  actions: [googleWorkspacePlugin],
  skills: [
    loadSkillFromMarkdown(readSkill("google-drive.md"), "plugin", "google-drive"),
    loadSkillFromMarkdown(readSkill("google-docs.md"), "plugin", "google-docs"),
    loadSkillFromMarkdown(readSkill("google-sheets.md"), "plugin", "google-sheets"),
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
    },
  ],
};

export default plugin;
