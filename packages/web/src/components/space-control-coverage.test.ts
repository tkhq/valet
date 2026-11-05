import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The app-wide sidebar switches space. Every page that reads the active
// space names it in its breadcrumb ("Space / Page", `WorkspaceClause`), and
// the sidebar is on every page except Settings, which pins its scope.
const srcRoot = join(__dirname, "..");
const read = (file: string) => readFileSync(join(srcRoot, file), "utf8");

const HEADER_PAGES = [
  "routes/artifacts.tsx",
  "routes/presence.tsx",
  "routes/workflows.tsx",
  "routes/memory.tsx",
  "routes/skills.index.tsx",
  "routes/usage.tsx",
  "routes/integrations.tsx",
  "components/integrations/team-integrations.tsx",
  "routes/security.index.tsx",
];

describe("space control coverage", () => {
  it.each(HEADER_PAGES)("%s names its space in the breadcrumb", (file) => {
    expect(read(file)).toContain("<WorkspaceClause />");
  });

  it("shows the app-wide sidebar, with Spaces, on every page except Settings", () => {
    expect(read("components/session/thread-tree.tsx")).toContain("<SpacesNav />");
    expect(read("routes/__root.tsx")).toContain('if (pathname === "/settings" || pathname.startsWith("/settings/")) return null;');
  });

  it("names the space on Presence detail pages and in the workflow editor", () => {
    expect(read("routes/presence.tsx")).toContain('<WorkspaceClause size="crumb" />');
    expect(read("routes/workflows.$workflowId.tsx")).toContain('<WorkspaceClause size="crumb" />');
  });

  it("keeps page links and space controls out of the top bar", () => {
    const nav = read("components/layout/top-nav.tsx");
    expect(nav).not.toContain("WorkspaceSwitcher");
    expect(nav).not.toContain('aria-label="Primary"');
  });
});
