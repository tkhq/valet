// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installFrameBridge } from "./frame-bridge";
vi.mock("~/lib/card-context", () => ({ cardId: () => "one" }));
afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, "", "/"); sessionStorage.clear(); });
it("does not turn a saved workspace into a URL pin on non-chat pages", () => {
  history.replaceState(null, "", "/events");
  sessionStorage.setItem("valet:card:one:valet:workspace", "team-recruiting");
  document.title = "Recruiting · Valet";
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const unsubscribe = vi.fn();
  const cleanup = installFrameBridge(() => unsubscribe);
  expect(post).toHaveBeenCalledWith({ type: "valet:page", url: "/events", title: "Events · Recruiting · Valet" }, location.origin);
  cleanup();
  expect(unsubscribe).toHaveBeenCalled();
});
