/**
 * GET /api/memory/journal-summary — the dashboard memory card's TL;DR.
 *
 * The summary comes from a Haiku call, which takes seconds. The route must
 * answer immediately (`pending: true`) and run the model call in the
 * background; the client polls and picks the summary up from the cache.
 * Blocking the home-page load on a model call is the regression these
 * tests pin against.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

interface JournalSummaryResponse {
  date: string;
  summary: string | null;
  pending?: boolean;
}

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => {
  faux?.unregister();
  faux = undefined;
  vi.unstubAllEnvs();
  await api?.cleanup();
  api = undefined;
});

async function putJournal(api: TestApi, content: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${api.baseUrl}/api/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `journal/${date}.md`, content }),
  });
  expect(res.status).toBe(200);
  return date;
}

async function getJournalSummary(api: TestApi): Promise<JournalSummaryResponse> {
  const res = await fetch(`${api.baseUrl}/api/memory/journal-summary`);
  expect(res.status).toBe(200);
  return (await res.json()) as JournalSummaryResponse;
}

describe("GET /api/memory/journal-summary", () => {
  it("answers pending immediately and serves the summary from cache once generated", async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("Shipped the proxy recorder.")]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    api = await bootTestApi();
    const date = await putJournal(api, "Worked on the proxy recorder all day.");

    // The first request must not wait for the model call.
    const first = await getJournalSummary(api);
    expect(first.date).toBe(date);
    expect(first.summary).toBeNull();
    expect(first.pending).toBe(true);

    // The background call lands in the cache; a later poll serves it.
    await vi.waitFor(async () => {
      const later = await getJournalSummary(api!);
      expect(later.summary).toBe("Shipped the proxy recorder.");
      expect(later.pending).toBeUndefined();
    });
  });

  it("reports no summary and no pending when today's journal is missing", async () => {
    api = await bootTestApi();
    const body = await getJournalSummary(api);
    expect(body.summary).toBeNull();
    expect(body.pending).toBeUndefined();
  });

  it("does not report pending again after generation failed for this content", async () => {
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    faux.setResponses([
      () => {
        throw new Error("model unavailable");
      },
    ]);
    vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
    api = await bootTestApi();
    await putJournal(api, "A journal whose summary generation fails.");

    const first = await getJournalSummary(api);
    expect(first.pending).toBe(true);

    // Once the background call has failed, polling must settle (no pending),
    // or the card would poll and re-call the model forever.
    await vi.waitFor(async () => {
      const later = await getJournalSummary(api!);
      expect(later.summary).toBeNull();
      expect(later.pending).toBeUndefined();
    });
  });
});
