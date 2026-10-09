// @vitest-environment jsdom
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "~/api/client";
import { ProductAnnouncement } from "./product-announcement";

const navigate = vi.fn();
let userId = "user-1";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: userId } }) }));
vi.mock("~/api/client", () => ({ api: { productAnnouncements: vi.fn(), acknowledgeProductAnnouncement: vi.fn() } }));
const notice = { id: "notice", title: "Run threads moved", body: "Find your history in Automations.", action: { label: "Open Automations", href: "/workflows" } };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<StrictMode><QueryClientProvider client={client}><ProductAnnouncement /></QueryClientProvider></StrictMode>);
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); userId="user-1";
  vi.mocked(api.productAnnouncements).mockResolvedValue({ announcements: [notice] });
  vi.mocked(api.acknowledgeProductAnnouncement).mockResolvedValue({ acknowledged: true });
});
describe("product announcement", () => {
  it("shows without taking focus and dismisses after saving", async () => {
    mount();
    await screen.findByRole("heading", { name: notice.title });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss product update" }));
    await waitFor(() => expect(screen.queryByLabelText("Product update")).toBeNull());
    expect(api.acknowledgeProductAnnouncement).toHaveBeenCalledWith("notice");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps a failed dismissal available for retry, then follows the CTA", async () => {
    vi.mocked(api.acknowledgeProductAnnouncement).mockRejectedValueOnce(new Error("offline"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Automations" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Automations" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/workflows" }));
    expect(screen.queryByLabelText("Product update")).toBeNull();
  });
  it("does not navigate when an acknowledgement finishes after unmount", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(api.acknowledgeProductAnnouncement).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ acknowledged: true });
    }));
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Automations" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.unmount();
    finish?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(navigate).not.toHaveBeenCalled();
  });
  it("renders nothing for an ineligible or acknowledged user", async () => {
    vi.mocked(api.productAnnouncements).mockResolvedValue({ announcements: [] });
    mount();
    await waitFor(() => expect(api.productAnnouncements).toHaveBeenCalled());
    expect(screen.queryByLabelText("Product update")).toBeNull();
  });
});
