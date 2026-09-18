// @vitest-environment jsdom
/**
 * The 1Password setup dialog and token row, shared by You · Connected
 * accounts and Organization · 1Password. One dialog means the setup steps
 * read the same wherever a person starts, so they are asserted once, here.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutate = vi.fn();

vi.mock("~/api/integrations", () => ({
  useConnectCredential: () => ({
    mutate: vi.fn(),
    mutateAsync: connectMutateAsync,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
  useDisconnectCredential: () => ({
    mutate: disconnectMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

import { OnePasswordTokenRow, OnePasswordTokenStatus } from "./onepassword-setup";

function personalRow(connected = false) {
  return render(
    <OnePasswordTokenRow
      scope="personal"
      connected={connected}
      label="Personal token"
      hint="Your own 1Password service account token."
      removeNote="This token is yours alone."
    />,
  );
}

describe("OnePasswordTokenRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMutateAsync.mockResolvedValue({ ok: true });
  });

  it("offers Connect 1Password when nothing is connected", () => {
    personalRow();
    expect(screen.getByRole("button", { name: "Connect 1Password" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
  });

  // R5: the setup steps and the links into 1Password. Anchor text and href
  // are asserted together so a copy edit cannot silently orphan a link.
  it("the dialog carries the setup steps and the 1Password links", async () => {
    const user = userEvent.setup();
    personalRow();
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    const dialog = within(screen.getByRole("dialog"));
    for (const [name, href] of [
      ["Create a vault", "https://support.1password.com/create-share-vaults-teams/"],
      ["Create a service account", "https://www.1password.dev/service-accounts/get-started/"],
      ["secret reference", "https://www.1password.dev/cli/secret-reference-syntax/"],
      [
        "secrets guide",
        "https://github.com/tkhq/valet/blob/dev-v2/docs/onepassword-secrets.md",
      ],
    ] as const) {
      expect(dialog.getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
    expect(dialog.getByText(/op:\/\/Vault\/Item\/field/)).toBeTruthy();
  });

  // A member who follows step 2 can be refused by 1Password: creating a
  // service account needs an account permission, and 1Password answers
  // "contact your administrator" without it. Valet cannot see that
  // permission, so the steps have to name the condition and the way out
  // rather than leave the reader stuck on 1Password's screen.
  it("the dialog says what to do when 1Password refuses to create a service account", async () => {
    const user = userEvent.setup();
    personalRow();
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/contact your administrator/i)).toBeTruthy();
    // Both ways out, so the reader can ask for whichever their admin prefers.
    expect(dialog.getByText(/create and manage service accounts/i)).toBeTruthy();
    expect(dialog.getByText(/scoped to that vault alone/i)).toBeTruthy();
  });

  it("carries the same refusal guidance on the organization dialog", async () => {
    const user = userEvent.setup();
    render(
      <OnePasswordTokenRow
        scope="org"
        connected={false}
        label="Organization token"
        hint="A 1Password service account token shared across the organization."
        removeNote="This token is shared across the organization."
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    // An organization admin in Valet is not necessarily an administrator in
    // 1Password, so this reader can be refused the same way.
    expect(within(screen.getByRole("dialog")).getByText(/contact your administrator/i)).toBeTruthy();
  });

  it("a personal token saves with no scope field", async () => {
    const user = userEvent.setup();
    personalRow();
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    await user.type(screen.getByLabelText("1Password personal token"), "ops_me");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "onepassword",
      body: { type: "service_account", apiKey: "ops_me" },
    });
  });

  it("Connect stays disabled until a token is typed", async () => {
    const user = userEvent.setup();
    personalRow();
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    const dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // A token typed and then abandoned must not be offered back on the next
  // open, where the heading may name the other scope.
  it("drops a typed token when the dialog closes", async () => {
    const user = userEvent.setup();
    personalRow();
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    await user.type(screen.getByLabelText("1Password personal token"), "ops_typed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Connect 1Password" }));
    expect((screen.getByLabelText("1Password personal token") as HTMLInputElement).value).toBe("");
  });

  it("a connected token offers Replace and Remove instead", () => {
    personalRow(true);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect 1Password" })).toBeNull();
  });
});

describe("OnePasswordTokenStatus", () => {
  it("shows the state and who may change it, with no controls", () => {
    render(
      <OnePasswordTokenStatus
        connected={false}
        label="Organization token"
        hint="Shared across the organization."
        note="Only an organization admin can connect or remove this token."
      />,
    );
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(
      screen.getByText("Only an organization admin can connect or remove this token."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
