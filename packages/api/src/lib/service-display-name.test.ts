import { describe, expect, it } from "vitest";
import { serviceDisplayName } from "./service-display-name.js";

describe("serviceDisplayName", () => {
  it("spells the product name for ids a capitalization would get wrong", () => {
    expect(serviceDisplayName("github")).toBe("GitHub");
    expect(serviceDisplayName("github_app")).toBe("GitHub App");
    expect(serviceDisplayName("onepassword")).toBe("1Password");
    expect(serviceDisplayName("deepwiki")).toBe("DeepWiki");
  });

  it("labels an id under both spellings the manifests use", () => {
    expect(serviceDisplayName("google-workspace")).toBe("Google Workspace");
    expect(serviceDisplayName("google_workspace")).toBe("Google Workspace");
  });

  it("title-cases every word of a config-declared MCP id, prefix stripped", () => {
    expect(serviceDisplayName("mcp-config:home-assistant")).toBe("Home Assistant");
  });

  it("echoes any other namespaced id, so a refusal names the caller's own string", () => {
    expect(serviceDisplayName("llm:prov_1")).toBe("llm:prov_1");
  });

  it("sentence-cases an unknown id so a dropped-in plugin reads like a name", () => {
    expect(serviceDisplayName("acme-widget_store")).toBe("Acme widget store");
  });
});
