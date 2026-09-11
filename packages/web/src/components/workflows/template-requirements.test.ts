/**
 * The words a blocked template gets, and who they address. The scope
 * argument is the active `teamId`: a team's missing credential reported as
 * the reader's own sends them to connect a service they may already have.
 */
import { describe, expect, it } from "vitest";
import {
  isInstallable,
  requirementLabel,
  missingNote,
  missingServices,
  needsOrganizationGithubSetup,
  connectLabel,
  unconfiguredNote,
  unconfiguredServices,
} from "./template-requirements";

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
    expect(missingNote(["Linear"], undefined)).toBe(
      "Linear is not connected on your account. Connect it on the Integrations page, then install this template.",
    );
  });

  it("sends a team gap to the team's connections, not the reader's", () => {
    expect(missingNote(["Linear"], "team_1")).toBe(
      "Linear is not connected for this team. Set up access on the Integrations page, then install this template.",
    );
  });

  it("keeps both scopes readable with more than one service", () => {
    expect(missingNote(["Linear", "Slack"], undefined)).toBe(
      "Linear, Slack are not connected on your account. Connect them on the Integrations page, then install this template.",
    );
    expect(missingNote(["Linear", "Slack"], "team_1")).toBe(
      "Linear, Slack are not connected for this team. Set up access on the Integrations page, then install this template.",
    );
  });
});

describe("connectLabel", () => {
  it("names the one service to connect, and the page when there are several", () => {
    expect(connectLabel(["Linear"], undefined)).toBe("Connect Linear");
    expect(connectLabel(["Linear", "Slack"], undefined)).toBe("Connect integrations");
  });

  it("names the sharing control a team gap is fixed with", () => {
    expect(connectLabel(["Linear"], "team_1")).toBe("Set up Linear access");
    expect(connectLabel(["Linear", "Slack"], "team_1")).toBe("Set up integrations access");
  });
});

describe("unconfiguredNote", () => {
  it("is the same for both workspaces, because only an admin can act either way", () => {
    expect(unconfiguredNote(["Slack"])).toBe(
      "Slack is not configured for this organization. An admin can set this up in Settings → Organization.",
    );
  });
});

it("distinguishes organization App access from a team connection and leaves repository access unverified", () => {
  const requirement = { service: "github", connected: false, organizationProvided: true, repositoryCheckOnInstall: true } as const;
  expect(requirementLabel(requirement)).toBe("Organization GitHub App · repository access checked on install");
  expect(missingServices([requirement])).toEqual([]);
  expect(isInstallable([requirement])).toBe(false);
  expect(requirementLabel({ service: "github", connected: true })).toBe("GitHub");
});

it("routes missing organization GitHub access separately from team credential gaps", () => {
  const github = { service: "github", connected: false, organizationProvided: true } as const;
  expect(needsOrganizationGithubSetup([github])).toBe(true);
  expect(needsOrganizationGithubSetup([{ ...github, connected: true }])).toBe(false);
  expect(needsOrganizationGithubSetup([{ service: "github", connected: false }])).toBe(false);
  expect(missingServices([github, { service: "linear", connected: false }])).toEqual(["Linear"]);
});
