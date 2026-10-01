import type { ValetPlugin } from "@valet/engine";
import { docsAnalyticsPlugin } from "./actions.js";

const plugin: ValetPlugin = {
  name: "docs-analytics",
  version: "0.0.1",
  description: "Read-only documentation analytics reports",
  actions: [docsAnalyticsPlugin],
  credentials: [
    {
      service: "docs_analytics",
      type: "api_key",
      configKeys: ["accessToken"],
      connectLabel: "Docs Analytics report token",
      requires: { orgCredential: true },
    },
  ],
};

export default plugin;
