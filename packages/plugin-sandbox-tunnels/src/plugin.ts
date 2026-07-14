import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

const sandboxTunnelsMd = readFileSync(
  fileURLToPath(new URL("../skills/sandbox-tunnels.md", import.meta.url)),
  "utf8",
);

const plugin: ValetPlugin = {
  name: "sandbox-tunnels",
  version: "0.1.0",
  skills: [loadSkillFromMarkdown(sandboxTunnelsMd, "plugin")],
};

export default plugin;
