import type { ValetPlugin } from "@valet/engine";
import { docsAnalyticsPlugin } from "./actions.js";

const plugin: ValetPlugin = {
  name: "docs-analytics",
  version: "0.0.1",
  description: "Read-only documentation analytics reports",
  // No `credentials` entry: the report token is the deployment-level
  // `DOCS_ANALYTICS_TOKEN` (see actions.ts), not something a user, team, or
  // org admin connects. The plugin therefore never appears on the
  // Integrations page and needs no setup inside the product.
  actions: [docsAnalyticsPlugin],
};

export default plugin;
