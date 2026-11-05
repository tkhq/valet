// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { qk } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";
import { useInvalidateSessionOnModelSwitch } from "./use-invalidate-session-on-model-switch";

it("refreshes model settings without invalidating transcript or decision caches", () => {
  useStreamStore.setState({ bySession: {} });
  const client = new QueryClient();
  const sid = "team-runtime";
  const selectedKey = [...qk.threads(sid), "selected", "thread"];
  const keys = [selectedKey, qk.session(sid), qk.threads(sid), qk.messages(sid, "thread"), qk.decisions(sid)];
  for (const key of keys) client.setQueryData(key, {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(() => useInvalidateSessionOnModelSwitch(sid), { wrapper });
  act(() => useStreamStore.getState().ingest(sid, {
    seq: 1, ts: 1, type: "model_switched", fromModel: "s", toModel: "l", reason: "set_via_api", scope: "thread", threadId: "thread",
  }));
  expect(client.getQueryState(selectedKey)?.isInvalidated).toBe(true);
  expect(client.getQueryState(qk.session(sid))?.isInvalidated).toBe(true);
  expect(client.getQueryState(qk.threads(sid))?.isInvalidated).toBe(true);
  expect(client.getQueryState(qk.messages(sid, "thread"))?.isInvalidated).toBe(false);
  expect(client.getQueryState(qk.decisions(sid))?.isInvalidated).toBe(false);
});
