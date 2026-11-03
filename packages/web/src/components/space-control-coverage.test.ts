import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The top bar has no space switcher. Every page that reads the active space
// must therefore show it and offer a switch: the thread pages through the
// Spaces sidebar, every other scoped page through the space control beside
// its title (`WorkspaceClause`).
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
  "routes/overview.tsx",
  "components/dashboard/team-dashboard.tsx",
];

describe("space control coverage", () => {
  it.each(HEADER_PAGES)("%s names and switches its space beside the title", (file) => {
    expect(read(file)).toContain("<WorkspaceClause />");
  });

  it("puts the Spaces list in the thread sidebar on / and /chat", () => {
    expect(read("components/session/thread-tree.tsx")).toContain("<SpacesNav bare={mobile}>");
    expect(read("routes/__root.tsx")).toContain('pathname === "/" || pathname === "/chat"');
  });

  it("gives Presence detail pages the control above their breadcrumb", () => {
    expect(read("routes/presence.tsx")).toMatch(/!onOverview && <div[^>]*><WorkspaceClause \/><\/div>/);
  });

  it("keeps the space switcher out of the top bar", () => {
    expect(read("components/layout/top-nav.tsx")).not.toContain("WorkspaceSwitcher");
  });
});
