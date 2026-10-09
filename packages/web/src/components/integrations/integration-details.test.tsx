// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationDetails } from "./integration-details";

describe("IntegrationDetails", () => {
  it("links installed skills without claiming connection or granted permissions", () => {
    render(<IntegrationDetails plugin={{ name: "google-workspace", version: "1", actionCount: 1,
      services: [{ service: "google_workspace", type: "oauth2", configKeys: [], connected: false,
        connect: "oauth", scopes: ["drive.readonly"], actions: [{ id: "drive.read", name: "Read file", riskLevel: "low", requiresApproval: false }] }],
      skills: [{ name: "google-drive", description: "Find files." }],
    }} />);
    expect(screen.getByRole("link", { name: /Google drive/i, hidden: true }).getAttribute("href")).toBe("/skills/google-drive");
    expect(screen.getByText("Read file")).toBeTruthy();
    expect(screen.getByText(/do not confirm the current account/)).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("handles dynamic capabilities and old servers without inventing tools or skills", () => {
    render(<IntegrationDetails plugin={{ name: "dynamic", version: "1", actionCount: 0,
      services: [], actionServices: [{ service: "dynamic", actions: [], dynamic: true }],
    }} />);
    expect(screen.getByText("Tools are discovered when connected.")).toBeTruthy();
    expect(screen.getByText(/Skill details are unavailable/)).toBeTruthy();
  });
});
