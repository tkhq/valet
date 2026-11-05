// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CredentialSummary } from "@valet/api/wire";
let credentials: CredentialSummary[] = [];
let channelReady = false;
let saveError: Error | null = null;
const save = vi.fn();
const disconnect = vi.fn();
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: { credentials }, isPending: false, isError: false, refetch: vi.fn() }),
  useConnectCredential: () => ({ mutate: save, isPending: false, error: saveError }),
  useDisconnectCredential: () => ({ mutate: disconnect, reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: { links: [{ provider: "telegram", linked: false, channelReady, codeDelivery: false, memberSearch: false }] } }),
}));
import { OrganizationTelegramPage } from "./settings.organization.telegram";

const bot: CredentialSummary = { service: "telegram", type: "bot_token", connectedAt: "2026-11-05T00:00:00Z", login: "@valet_bot" };

beforeEach(() => {
  credentials = []; channelReady = false; saveError = null; save.mockClear(); disconnect.mockClear();
});

it("asks for the BotFather token and saves it as the org bot token", () => {
  render(<OrganizationTelegramPage />);
  expect(screen.getByRole("heading", { name: "Telegram" })).toBeTruthy();
  const field = screen.getByLabelText("2. Bot token");
  expect(field.getAttribute("type")).toBe("password");
  const submit = screen.getByRole("button", { name: "Connect Telegram" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: " 123:abc " } });
  fireEvent.click(submit);
  expect(save).toHaveBeenCalledWith({ service: "telegram", body: { type: "bot_token", accessToken: "123:abc", scope: "org" } });
});

it("shows the server's fix when Telegram rejects the token", () => {
  saveError = new Error("Telegram rejected the bot token. Copy the token from @BotFather again, then try again.");
  render(<OrganizationTelegramPage />);
  expect(screen.getByText(/Copy the token from @BotFather again/)).toBeTruthy();
});

it("names the bot and says it starts on the next restart until the channel runs", () => {
  credentials = [bot];
  render(<OrganizationTelegramPage />);
  expect(screen.getByText("@valet_bot")).toBeTruthy();
  expect(screen.getByText("Starts on restart")).toBeTruthy();
  expect(screen.getByText(/starts the next time the Valet server restarts/)).toBeTruthy();
});

it("shows Running once the channel runs, and disconnects the org token", () => {
  credentials = [bot];
  channelReady = true;
  render(<OrganizationTelegramPage />);
  expect(screen.getByText("Running")).toBeTruthy();
  expect(screen.queryByText(/starts the next time/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
  expect(disconnect).toHaveBeenCalledWith({ service: "telegram", scope: "org" }, expect.anything());
});
