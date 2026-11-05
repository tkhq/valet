// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { GetLinearConnectionResponse } from "@valet/api/wire";
let data: GetLinearConnectionResponse;
let error = false;
let saveError: Error | null = null;
const save = vi.fn();
const disconnect = vi.fn();
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("~/api/linear", () => ({
  useLinearConnection: () => ({ data, isPending: false, isError: error, refetch: vi.fn() }),
  useSaveLinearConnection: () => ({ mutate: save, isPending: false, error: saveError }),
  useDisconnectLinear: () => ({ mutate: disconnect, reset: vi.fn(), isPending: false, error: null }),
}));
import { OrganizationLinearPage, linearAppCreationUrl } from "./settings.organization.linear";
const redirectUri = "https://valet.example/api/org/linear/callback";
const webhookUrl = "https://valet.example/webhooks/events/linear";
const webhookResourceTypes = ["Issue", "Comment"];
beforeEach(() => {
  error = false; saveError = null; save.mockClear(); disconnect.mockClear();
  data = { configured: false, connected: false, webhookConfigured: false, ready: false, redirectUri, webhookUrl, webhookResourceTypes };
});

function fill() {
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: " client-id " } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "client-secret" } });
  fireEvent.change(screen.getByLabelText("Webhook signing secret"), { target: { value: "hook-secret" } });
}

it("asks for the three values Linear issues, like the Slack page", () => {
  render(<OrganizationLinearPage />);
  expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
  expect(screen.queryByText(/Linear events/)).toBeNull();
  for (const label of ["Client secret", "Webhook signing secret"]) {
    expect(screen.getByLabelText(label).getAttribute("type")).toBe("password");
  }
  expect(screen.getByText(webhookUrl)).toBeTruthy();
  const submit = screen.getByRole("button", { name: "Connect Linear" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "id" } });
  fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "secret" } });
  expect(submit.hasAttribute("disabled")).toBe(true);
});

it("saves the trimmed values in one step", () => {
  render(<OrganizationLinearPage />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
  expect(save).toHaveBeenCalledWith({ clientId: "client-id", clientSecret: "client-secret", webhookSecret: "hook-secret" });
});

it("shows the server's fix when the check fails", () => {
  saveError = new Error("In Linear, open the app's settings, turn on Client credentials, and save. Then connect again.");
  render(<OrganizationLinearPage />);
  expect(screen.getByText(/turn on Client credentials/)).toBeTruthy();
});

it("prefills the client credentials grant and the app webhook", () => {
  render(<OrganizationLinearPage />);
  const url = new URL(screen.getByRole("link", { name: "Open Linear app creation" }).getAttribute("href")!);
  expect(url.searchParams.getAll("oauth.grant_types")).toEqual(["authorization_code", "client_credentials"]);
  expect(url.searchParams.get("oauth.redirect_uris")).toBe(redirectUri);
  expect(url.searchParams.get("oauth.client_uri")).toBe("https://valet.example");
  expect(url.searchParams.get("distribution")).toBe("private");
  expect(url.searchParams.get("webhook.enabled")).toBe("true");
  expect(url.searchParams.get("webhook.url")).toBe(webhookUrl);
  expect(url.searchParams.getAll("webhook.resourceTypes")).toEqual(webhookResourceTypes);
});

it("warns without a public HTTPS URL and leaves the webhook out of the form", () => {
  data = { ...data, webhookUrl: undefined, redirectUri: "http://localhost:8788/api/org/linear/callback" };
  render(<OrganizationLinearPage />);
  expect(screen.getByText(/no public HTTPS URL/)).toBeTruthy();
  const url = new URL(screen.getByRole("link", { name: "Open Linear app creation" }).getAttribute("href")!);
  expect(url.searchParams.get("webhook.url")).toBeNull();
  expect(url.searchParams.getAll("oauth.grant_types")).toContain("client_credentials");
});

it("shows a ready connection with Disconnect and no approval step", () => {
  data = { ...data, configured: true, connected: true, webhookConfigured: true, ready: true, workspaceName: "Turnkey" };
  render(<OrganizationLinearPage />);
  expect(screen.getByText("Turnkey")).toBeTruthy();
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(screen.queryByLabelText("Client secret")).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(screen.getByText(/deletes the organization’s saved Linear app credentials/)).toBeTruthy();
});

it("names the fix when a connection is not ready", () => {
  data = { ...data, configured: true, connected: true, workspaceName: "Turnkey", reason: "Ask an organization admin to reconnect Linear." };
  render(<OrganizationLinearPage />);
  expect(screen.getByText("Needs reconnect")).toBeTruthy();
  expect(screen.getByText(/reconnect Linear/)).toBeTruthy();
});

it("does not show stale setup after a load failure", () => {
  data = { ...data, connected: true };
  const view = render(<OrganizationLinearPage />);
  error = true; view.rerender(<OrganizationLinearPage />);
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(screen.getByText(/Could not load Linear setup/)).toBeTruthy();
});

it("builds no creation URL without a usable callback", () => {
  expect(linearAppCreationUrl({})).toBeUndefined();
  expect(linearAppCreationUrl({ redirectUri: "javascript:alert(1)" })).toBeUndefined();
});
