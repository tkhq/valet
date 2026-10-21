// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresencePlaceWire } from "@valet/api/wire";
import { api } from "./client";
import { placeSubjectFor, usePlaceSubject } from "./presence";

function place(subject: string, parent: string | null, service: PresencePlaceWire["service"] = "slack"): PresencePlaceWire {
  return { subject, label: subject, service, parent, listenerCount: 0, activeThreadCount: 0, lastActivityAt: null };
}

describe("placeSubjectFor", () => {
  it("adds the org's Slack workspace to a channel-only key", () => {
    expect(placeSubjectFor("slack:C900", [place("slack:T1", null), place("slack:T1/C900", "slack:T1")])).toBe("slack:T1/C900");
  });

  it("keeps the key when the places name no single Slack workspace, so the api resolves it", () => {
    expect(placeSubjectFor("slack:C900", undefined)).toBe("slack:C900");
    expect(placeSubjectFor("slack:C900", [place("github:acme/api", null, "github")])).toBe("slack:C900");
    expect(placeSubjectFor("slack:C900", [place("slack:T1", null), place("slack:T2", null)])).toBe("slack:C900");
  });

  it("keeps a key that is already a place key", () => {
    const places = [place("slack:T1", null)];
    expect(placeSubjectFor("github:acme/api#12", places)).toBe("github:acme/api#12");
    expect(placeSubjectFor("slack:T1/C900", places)).toBe("slack:T1/C900");
    expect(placeSubjectFor("slack:T1", places)).toBe("slack:T1");
  });
});

describe("usePlaceSubject", () => {
  afterEach(() => vi.restoreAllMocks());

  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return createElement(QueryClientProvider, { client }, children);
  }

  it("reads the places only for a channel-only Slack key", async () => {
    const read = vi.spyOn(api, "listPresencePlaces").mockResolvedValue({
      places: [place("slack:T1", null), place("slack:T1/C900", "slack:T1")],
      channelNames: {},
    });
    const placeKey = renderHook(() => usePlaceSubject("github:acme/api#12"), { wrapper });
    expect(placeKey.result.current).toBe("github:acme/api#12");
    expect(read).not.toHaveBeenCalled();

    const channel = renderHook(() => usePlaceSubject("slack:C900"), { wrapper });
    await waitFor(() => expect(channel.result.current).toBe("slack:T1/C900"));
    expect(read).toHaveBeenCalledTimes(1);
  });
});
