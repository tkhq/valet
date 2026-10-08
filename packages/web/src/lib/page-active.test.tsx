// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePageActive } from "./page-active";

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it("suspends embedded shortcuts when the frame or its deck becomes inert", async () => {
  const overlay = document.createElement("div");
  const frame = document.createElement("iframe");
  overlay.append(frame);
  document.body.append(overlay);
  vi.spyOn(window, "frameElement", "get").mockReturnValue(frame);
  const { result } = renderHook(usePageActive);
  expect(result.current).toBe(true);
  await act(async () => { frame.setAttribute("inert", ""); });
  await waitFor(() => expect(result.current).toBe(false));
  await act(async () => { frame.removeAttribute("inert"); });
  await waitFor(() => expect(result.current).toBe(true));
  await act(async () => { overlay.setAttribute("inert", ""); });
  await waitFor(() => expect(result.current).toBe(false));
  await act(async () => { overlay.removeAttribute("inert"); });
  await waitFor(() => expect(result.current).toBe(true));
});
