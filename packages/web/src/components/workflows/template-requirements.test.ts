/**
 * The words a blocked template gets, and who they address.
 *
 * A requirement carries no principal of its own: the server stamps
 * `connected` against whatever the listing asked about, and the listing
 * asks about the workspace the nav switcher names. So the copy has to take
 * the same scope, or a team's missing credential is reported as the
 * reader's own and sends them to connect a service they may already have.
 */
import { describe, expect, it } from "vitest";
import {
  isInstallable,
  missingNote,
  missingServices,
  requirementScope,
  connectLabel,
  unconfiguredNote,
  unconfiguredServices,
} from "./template-requirements";

describe("requirementScope", () => {
  it("reads a team id as a team gap and its absence as the reader's own", () => {
    expect(requirementScope(undefined)).toBe("personal");
    expect(requirementScope("team_1")).toBe("team");
  });
});

describe("missingServices and isInstallable", () => {
  it("names the services the reader can act on, and leaves out the ones only an admin can", () => {
    const requires = [
      { service: "github", connected: true },
      { service: "linear", connected: false },
      { service: "slack", connected: false, unconfigured: true } as const,
    ];
    expect(missingServices(requires)).toEqual(["Linear"]);
    expect(unconfiguredServices(requires)).toEqual(["Slack"]);
    expect(isInstallable(requires)).toBe(false);
  });

  it("is installable once every requirement is connected", () => {
    expect(isInstallable([{ service: "github", connected: true }])).toBe(true);
  });
});

describe("missingNote", () => {
  it("sends a personal gap to the reader's own connections", () => {
    expect(missingNote(["Linear"], "personal")).toBe(
      "Linear is not connected on your account. Connect it on the Integrations page, then install this template.",
    );
  });

  it("sends a team gap to the team's connections, not the reader's", () => {
    expect(missingNote(["Linear"], "team")).toBe(
      "Linear is not connected for this team. Connect Linear on the Integrations page and share it with the team, then install this template.",
    );
  });

  it("keeps both scopes readable with more than one service", () => {
    expect(missingNote(["Linear", "Slack"], "personal")).toBe(
      "Linear, Slack are not connected on your account. Connect them on the Integrations page, then install this template.",
    );
    expect(missingNote(["Linear", "Slack"], "team")).toBe(
      "Linear, Slack are not connected for this team. Connect them on the Integrations page and share them with the team, then install this template.",
    );
  });
});

describe("connectLabel", () => {
  it("names the one service to connect, and the page when there are several", () => {
    expect(connectLabel(["Linear"], "personal")).toBe("Connect Linear");
    expect(connectLabel(["Linear", "Slack"], "personal")).toBe("Connect integrations");
  });

  it("names the sharing control a team gap is fixed with", () => {
    expect(connectLabel(["Linear"], "team")).toBe("Share Linear with the team");
    expect(connectLabel(["Linear", "Slack"], "team")).toBe("Share integrations with the team");
  });
});

describe("unconfiguredNote", () => {
  it("is the same for both workspaces, because only an admin can act either way", () => {
    expect(unconfiguredNote(["Slack"])).toBe(
      "Slack is not configured for this organization. An admin can set this up in Settings → Organization.",
    );
  });
});
