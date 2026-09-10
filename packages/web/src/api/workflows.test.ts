// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { downloadWorkflowFile } from "./workflows";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["attachment; filename=\"workflow.yaml\"; filename*=UTF-8''%E6%AF%8F%E6%97%A5.yaml", "每日.yaml"],
  ["attachment; filename=\"workflow.yaml\"; filename*=UTF-8''a%22b.yaml", 'a"b.yaml'],
  ["attachment; filename=\"original.yaml\"", "original.yaml"],
  ["attachment; filename=\"fallback.yaml\"; filename*=UTF-8''%invalid", "fallback.yaml"],
])("downloads the filename advertised by %s", async (disposition, expected) => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("version: 1", {
    headers: { "Content-Disposition": disposition },
  })));
  const createObjectURL = vi.fn(() => "blob:test");
  const revokeObjectURL = vi.fn();
  class DownloadURL extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", DownloadURL);
  let downloaded: string | undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloaded = this.download;
  });

  expect(await downloadWorkflowFile("wf-test")).toBe(expected);
  expect(downloaded).toBe(expected);
  expect(document.querySelector("a")).toBeNull();
  vi.runAllTimers();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
