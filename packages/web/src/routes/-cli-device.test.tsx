// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeviceInfo } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: undefined }) }));
vi.mock("~/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));

const cliDevice = vi.fn<(code: string) => Promise<CliDeviceInfo>>();
const decideCliDevice = vi.fn<(code: string, accept: boolean) => Promise<{ ok: true }>>();
vi.mock("~/api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  api: {
    cliDevice: (code: string) => cliDevice(code),
    decideCliDevice: (code: string, accept: boolean) => decideCliDevice(code, accept),
  },
}));

const { CliDevicePage } = await import("./cli.device");

const INFO: CliDeviceInfo = { account: "me@valet.test", device: "laptop", user_code: "BCDF-GHJK", access: ["Act as you in Valet"] };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CliDevicePage />
    </QueryClientProvider>,
  );
}

function enter(code: string) {
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

afterEach(() => vi.clearAllMocks());

describe("CLI device sign-in page", () => {
  it("asks for the code, then names the computer, the account, and the code, and records Allow", async () => {
    cliDevice.mockResolvedValue(INFO);
    decideCliDevice.mockResolvedValue({ ok: true });
    renderPage();
    expect(cliDevice).not.toHaveBeenCalled();
    enter("bcdf-ghjk");
    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(screen.getAllByText(/me@valet\.test/).length).toBeGreaterThan(0);
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
    expect(cliDevice).toHaveBeenCalledWith("bcdf-ghjk");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(decideCliDevice).toHaveBeenCalledWith("BCDF-GHJK", true));
    expect(await screen.findByText(/close this tab/)).toBeTruthy();
  });

  it("says when no sign-in waits for the code, and lets the person try again", async () => {
    cliDevice.mockRejectedValue(new Error("404"));
    renderPage();
    enter("BBBB-BBBB");
    expect(await screen.findByText(/No sign-in is waiting for this code/)).toBeTruthy();
    expect(screen.getByLabelText("Code")).toBeTruthy();
  });
});
