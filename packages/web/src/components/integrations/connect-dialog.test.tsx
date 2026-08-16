// @vitest-environment jsdom
/**
 * The pre-connect screen. These assert the promises the screen makes and
 * the ones it refuses to make.
 *
 * The screen exists so a user decides about a credential BEFORE it exists,
 * so the tests care about two things above all: that the disclosure is on
 * screen ahead of any connect call, and that no claim appears which the
 * server's metadata does not support.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginActionSummary, PluginServiceSummary, TeamSummary } from "@valet/api/wire";

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const githubMutateAsync = vi.fn().mockResolvedValue({ url: "https://github.com/login/oauth" });

let teams: TeamSummary[] = [];

vi.mock("~/api/integrations", () => ({
  useConnectCredential: () => ({ mutateAsync: connectMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: githubMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({
    data: {
      id: "u1",
      email: "person@example.com",
      name: "Signed In Person",
      avatarUrl: null,
      role: "member",
      orgId: "o1",
      orgRole: "member",
      defaultModel: null,
    },
  }),
  useTeams: () => ({ data: { teams } }),
}));

import { ConnectDialog, connectPath } from "./connect-dialog";

function action(name: string, requiresApproval = false): PluginActionSummary {
  return {
    id: `svc.${name}`,
    name,
    riskLevel: requiresApproval ? "high" : "low",
    requiresApproval,
  };
}

function team(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "t1",
    orgId: "o1",
    name: "Platform",
    createdAt: 0,
    memberCount: 6,
    callerRole: "member",
    ...overrides,
  };
}

/** Gmail's real shape: 13 tools, 4 of which the approval gate stops. */
function gmail(overrides: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return {
    service: "gmail",
    type: "oauth2",
    configKeys: ["accessToken"],
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    connected: false,
    connect: "oauth",
    actions: [
      action("List Messages"),
      action("Get Message"),
      action("Send Email", true),
      action("Trash Message", true),
    ],
    ...overrides,
  };
}

function show(service: PluginServiceSummary, title = "Gmail") {
  return render(
    <ConnectDialog service={service} title={title} slug={service.service} open onOpenChange={() => {}} />,
  );
}

beforeEach(() => {
  teams = [];
  connectMutateAsync.mockClear();
  githubMutateAsync.mockClear();
});

describe("the decision, stated before the connection", () => {
  it("frames the title as the user's task, not the vendor's", () => {
    show(gmail());
    expect(screen.getByText("Set up your Gmail connection")).toBeTruthy();
    expect(screen.queryByText("Connect Gmail")).toBeNull();
  });

  it("states what will happen, counted from the declared actions", () => {
    show(gmail());
    expect(screen.getByText("Valet gives your assistant 4 Gmail tools.")).toBeTruthy();
    expect(screen.getByText("2 of them stop and ask you before they run.")).toBeTruthy();
  });

  it("renders both cards with copy derived from the service's own metadata", () => {
    show(gmail());

    const capability = screen.getByLabelText("What your assistant can do");
    expect(
      within(capability).getByText("These tools stop and ask you first: Send Email and Trash Message."),
    ).toBeTruthy();
    expect(within(capability).getByText("The other 2 tools run without asking you.")).toBeTruthy();

    const reach = screen.getByLabelText("Who can reach it");
    expect(within(reach).getByText("Valet saves this connection for your account.")).toBeTruthy();
  });

  it("names every tool the approval gate stops, in the preview pane", () => {
    show(gmail());
    // Four tools listed; the two gated ones carry the badge, and the badge
    // text says so rather than relying on the accent colour alone.
    expect(screen.getAllByText("Asks you first")).toHaveLength(2);
    expect(screen.getByText("Send Email")).toBeTruthy();
    expect(screen.getByText("List Messages")).toBeTruthy();
  });

  it("shows the scopes Valet will request when the manifest declares any", () => {
    show(gmail());
    expect(screen.getByText("https://www.googleapis.com/auth/gmail.readonly")).toBeTruthy();
  });

  it("offers one full-width Continue and a link to remove the token later", () => {
    show(gmail());
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText(/Valet encrypts this token before it saves it/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connected accounts" }).getAttribute("href")).toBe(
      "/settings/connected-accounts",
    );
  });
});

describe("the identity chip", () => {
  it("shows the signed-in Valet account, named as such", () => {
    show(gmail());
    expect(screen.getByText("Connecting as your Valet account")).toBeTruthy();
    expect(screen.getByText("Signed In Person")).toBeTruthy();
    expect(screen.getByText("person@example.com")).toBeTruthy();
  });

  it("says the third-party account is chosen on the next screen, rather than inventing one", () => {
    show(gmail());
    expect(screen.getByText("You choose which Gmail account to use on the next screen.")).toBeTruthy();
  });

  it("says instead that the pasted token picks the account, on a manual service", () => {
    show(gmail({ service: "typefully", type: "api_key", connect: "manual" }), "Typefully");
    expect(screen.getByText("The token you paste decides which Typefully account Valet uses.")).toBeTruthy();
  });

  it("names the currently connected account when reconnecting", () => {
    show(gmail({ connected: true, health: { login: "someone@example.com" } }));
    expect(screen.getByText("Connected now as someone@example.com.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });
});

describe("a team workspace", () => {
  it("names the team, its size, and what every member can do with the assistant", () => {
    teams = [team({ name: "Platform", memberCount: 6 })];
    show(gmail());

    const reach = within(screen.getByLabelText("Who can reach it"));
    expect(reach.getByText("You are in Platform (6 people).")).toBeTruthy();
    expect(
      reach.getByText("A team assistant runs on the connection of the member who starts it."),
    ).toBeTruthy();
    expect(
      reach.getByText("Every member can then send that assistant instructions and read its replies."),
    ).toBeTruthy();
  });

  it("says something different from the personal case", () => {
    show(gmail());
    expect(screen.getByText("Only sessions that you start can use it.")).toBeTruthy();

    teams = [team()];
    show(gmail());
    expect(screen.getAllByText(/You are in Platform/).length).toBeGreaterThan(0);
  });

  it("ignores a team the caller only administers but does not belong to", () => {
    // Org admins see every team in the org with callerRole null. Those are
    // not memberships, so they create none of the exposure this card names.
    teams = [team({ name: "Finance", callerRole: null })];
    show(gmail());
    expect(screen.getByText("Valet saves this connection for your account.")).toBeTruthy();
    expect(screen.queryByText(/You are in Finance/)).toBeNull();
  });

  it("adds GitHub's org-wide reach, which no other service has", () => {
    show(gmail({ service: "github", connect: "manual" }), "GitHub");
    expect(screen.getByText(/App installation or a shared token/)).toBeTruthy();
  });
});

describe("the choice reaches the connect call", () => {
  it("routes each service to its own connect path", () => {
    expect(connectPath(gmail({ service: "github", connect: "manual" }))).toBe("github");
    expect(connectPath(gmail())).toBe("oauth");
    expect(connectPath(gmail({ service: "typefully", connect: "manual" }))).toBe("manual");
  });

  it("starts the GitHub App flow only after the disclosure, never before", () => {
    show(gmail({ service: "github", connect: "manual" }), "GitHub");
    // Rendering the screen must not itself start a connection.
    expect(githubMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(githubMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("carries the manual path to the token form and saves under the right service", async () => {
    show(gmail({ service: "typefully", type: "api_key", connect: "manual" }), "Typefully");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Paste your Typefully token")).toBeTruthy();
    expect(connectMutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "tf-key-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalledTimes(1));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "typefully",
      body: { type: "api_key", apiKey: "tf-key-123" },
    });
  });

  it("keeps manual token entry available on an OAuth service, behind the disclosure", () => {
    show(gmail());
    fireEvent.click(screen.getByRole("button", { name: "Enter a token instead" }));
    expect(screen.getByLabelText("Access token")).toBeTruthy();
  });
});

describe("a service whose metadata supports no claim", () => {
  /** The google-calendar shape: no action reads the key this credential writes. */
  const calendar = (): PluginServiceSummary =>
    gmail({ service: "google-calendar", actions: [], scopes: undefined });

  it("says so instead of naming tools", () => {
    show(calendar(), "Google Calendar");
    expect(screen.getByText("Valet cannot confirm which tools this connection unlocks.")).toBeTruthy();
    expect(screen.queryAllByText("Asks you first")).toHaveLength(0);
  });

  it("names the corrective action", () => {
    show(calendar(), "Google Calendar");
    expect(
      screen.getByText("Do not connect Google Calendar here until a maintainer corrects that name."),
    ).toBeTruthy();
  });

  it("refuses to start the connection", () => {
    show(calendar(), "Google Calendar");
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(connectMutateAsync).not.toHaveBeenCalled();
    expect(githubMutateAsync).not.toHaveBeenCalled();
    // No token escape hatch either — it would connect the same broken key.
    expect(screen.queryByRole("button", { name: "Enter a token instead" })).toBeNull();
  });

  it("tells a dynamic service's reader the list arrives after connecting, and still connects", () => {
    show(gmail({ service: "linear", dynamic: true, actions: [], scopes: undefined }), "Linear");
    expect(screen.getByText("Valet reads the Linear tool list after you connect.")).toBeTruthy();
    expect(screen.queryAllByText("Asks you first")).toHaveLength(0);
    // Unknown-but-resolvable is not the same as broken: Continue still works.
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });
});
