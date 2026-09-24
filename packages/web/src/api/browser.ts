import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BrowserAnnotation,
  BrowserAnnotationMark,
  BrowserAnnotationsResponse,
  SessionBrowserResponse,
} from "@valet/api/wire";
import type {
  BrowserArtifact,
  BrowserIdentity,
  BrowserRequest,
  BrowserResponse,
  BrowserSettings,
} from "@valet/shared";
import { ApiError } from "./client";

export const qkBrowser = {
  session: (sessionId: string) => ["sessions", sessionId, "browser"] as const,
  annotations: (sessionId: string, artifactId: string) =>
    [
      "sessions",
      sessionId,
      "browser",
      "evidence",
      artifactId,
      "annotations",
    ] as const,
};
const endpoint = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/browser`;
type CommandBody<C extends BrowserRequest["command"]> = Omit<
  Extract<BrowserRequest, { command: C }>,
  keyof BrowserIdentity | "command"
>;

async function request<T>(
  sessionId: string,
  path = "",
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${endpoint(sessionId)}${path}`, {
    method,
    credentials: "same-origin",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "The browser request failed. Refresh browser status and try again.";
    throw new ApiError(response.status, message, result);
  }
  // The API wire contract owns this response shape, as in the shared REST client.
  return result as T;
}

async function command(
  sessionId: string,
  path: string,
  body: unknown,
): Promise<BrowserResponse> {
  const response = await request<BrowserResponse>(sessionId, path, body);
  if (!response.ok)
    throw new Error(
      `${response.error?.message ?? "The browser request failed."} ${response.error?.correctiveAction ?? "Refresh browser status before retrying."}`,
    );
  return response;
}

export const browserApi = {
  status: (sessionId: string, signal?: AbortSignal) =>
    request<SessionBrowserResponse>(sessionId, "", undefined, "GET", signal),
  start: (sessionId: string) =>
    request<SessionBrowserResponse>(sessionId, "/start", {}),
  settings: (
    sessionId: string,
    body: Partial<Pick<BrowserSettings, "enabled" | "audience" | "grants">>,
  ) => request<SessionBrowserResponse>(sessionId, "/settings", body, "PATCH"),
  control: (sessionId: string, body: CommandBody<"control">) =>
    command(sessionId, "/control", body),
  tab: (sessionId: string, body: CommandBody<"tab">) =>
    command(sessionId, "/tab", body),
  input: (sessionId: string, body: CommandBody<"input">) =>
    command(sessionId, "/input", body),
  ticket: (sessionId: string, signal?: AbortSignal) =>
    request<{ ticket: string; expiresAt: number }>(
      sessionId,
      "/ticket",
      { scope: "view" },
      "POST",
      signal,
    ),
  capture: (sessionId: string, body: { runtimeId: string; tabId: string }) =>
    request<BrowserArtifact>(sessionId, "/evidence", body),
  evidence: (sessionId: string, artifactId: string) =>
    `${endpoint(sessionId)}/evidence/${encodeURIComponent(artifactId)}`,
  download: (sessionId: string, artifactId: string) =>
    `${endpoint(sessionId)}/downloads/${encodeURIComponent(artifactId)}`,
  annotations: (sessionId: string, artifactId: string) =>
    request<BrowserAnnotationsResponse>(
      sessionId,
      `/evidence/${encodeURIComponent(artifactId)}/annotations`,
    ),
  saveAnnotation: (
    sessionId: string,
    artifactId: string,
    body: { documentId: string; marks: BrowserAnnotationMark[] },
  ) =>
    request<BrowserAnnotation>(
      sessionId,
      `/evidence/${encodeURIComponent(artifactId)}/annotations`,
      body,
    ),
  annotationExport: (
    sessionId: string,
    artifactId: string,
    annotationId: string,
  ) =>
    `${endpoint(sessionId)}/evidence/${encodeURIComponent(artifactId)}/annotations/${encodeURIComponent(annotationId)}/export`,
};

export function useBrowserAnnotations(sessionId: string, artifactId: string) {
  return useQuery({
    queryKey: qkBrowser.annotations(sessionId, artifactId),
    queryFn: () => browserApi.annotations(sessionId, artifactId),
    staleTime: 0,
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
  });
}

export function useSaveBrowserAnnotation(
  sessionId: string,
  artifactId: string,
) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      documentId: string;
      marks: BrowserAnnotationMark[];
    }) => browserApi.saveAnnotation(sessionId, artifactId, body),
    onSuccess: () =>
      cache.invalidateQueries({
        queryKey: qkBrowser.annotations(sessionId, artifactId),
      }),
  });
}

export function useBrowserStatus(sessionId: string) {
  return useQuery({
    queryKey: qkBrowser.session(sessionId),
    queryFn: ({ signal }) => browserApi.status(sessionId, signal),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useBrowserActions(sessionId: string) {
  const cache = useQueryClient();
  const refresh = () =>
    cache.invalidateQueries({ queryKey: qkBrowser.session(sessionId) });
  const acceptStatus = (response: SessionBrowserResponse) => {
    cache.setQueryData(qkBrowser.session(sessionId), response);
  };
  const acceptCommand = (response: BrowserResponse) => {
    if (response.status)
      cache.setQueryData<SessionBrowserResponse>(
        qkBrowser.session(sessionId),
        (previous) =>
          previous
            ? { ...previous, status: response.status ?? previous.status }
            : previous,
      );
    void refresh();
  };
  const start = useMutation({
    mutationFn: () => browserApi.start(sessionId),
    onSuccess: acceptStatus,
  });
  const settings = useMutation({
    mutationFn: (body: Parameters<typeof browserApi.settings>[1]) =>
      browserApi.settings(sessionId, body),
    onSuccess: acceptStatus,
  });
  const control = useMutation({
    mutationFn: (body: CommandBody<"control">) =>
      browserApi.control(sessionId, body),
    onSuccess: acceptCommand,
    onError: refresh,
  });
  const tab = useMutation({
    mutationFn: (body: CommandBody<"tab">) => browserApi.tab(sessionId, body),
    onSuccess: acceptCommand,
    onError: refresh,
  });
  const input = useMutation({
    scope: { id: `browser-input:${sessionId}` },
    mutationFn: (body: CommandBody<"input">) =>
      browserApi.input(sessionId, body),
    onError: refresh,
  });
  // A page input can wait for its dialog. Responses must bypass that queue.
  const dialog = useMutation({
    mutationFn: (body: CommandBody<"input">) =>
      browserApi.input(sessionId, body),
    onError: refresh,
  });
  const capture = useMutation({
    mutationFn: (body: Parameters<typeof browserApi.capture>[1]) =>
      browserApi.capture(sessionId, body),
  });
  return { start, settings, control, tab, input, dialog, capture };
}

export interface BrowserFrameData {
  blob: Blob;
  runtimeId: string;
  documentId: string;
  viewport: { width: number; height: number };
}
export interface BrowserFrame extends Omit<BrowserFrameData, "blob"> {
  url: string;
  tabId: string;
}

function nextFrameTick(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 250);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function fetchBrowserFrame(
  sessionId: string,
  runtimeId: string,
  tabId: string,
  ticket: string,
  signal: AbortSignal,
): Promise<BrowserFrameData> {
  const query = new URLSearchParams({ runtimeId, tabId });
  const load = () =>
    fetch(`${endpoint(sessionId)}/frame?${query}`, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-browser-ticket": ticket },
    });
  let response = await load();
  // Canceling HTTP cannot cancel Chromium's active screenshot. A tab switch
  // or navigation can briefly conflict with that capture. Retry at most three times.
  for (let attempt = 0; response.status === 409 && attempt < 3; attempt++) {
    await response.body?.cancel();
    await nextFrameTick(signal);
    signal.throwIfAborted();
    response = await load();
  }
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Browser viewing permission expired. Retry to request access."
        : "The browser frame is unavailable. Refresh browser status and retry.",
    );
  const documentId = response.headers.get("x-browser-document-id");
  if (response.headers.get("x-browser-runtime-id") !== runtimeId || !documentId)
    throw new Error(
      "The browser frame identity changed. Refresh browser status and retry.",
    );
  const width = Number(response.headers.get("x-browser-viewport-width"));
  const height = Number(response.headers.get("x-browser-viewport-height"));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 16384 ||
    height > 16384
  )
    throw new Error(
      "The browser viewport is invalid. Restart the browser view.",
    );
  const limit = 5 * 1024 * 1024;
  if (
    Number(response.headers.get("content-length")) > limit ||
    response.headers.get("content-type")?.split(";")[0] !== "image/jpeg"
  )
    throw new Error(
      "The browser frame format or size is invalid. Restart the browser view.",
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("The browser frame is empty. Retry the browser view.");
  const chunks: BlobPart[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(
          "The browser frame exceeds the size limit. Restart the browser view.",
        );
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type: "image/jpeg" });
  return { blob, runtimeId, documentId, viewport: { width, height } };
}

/** One request at a time. The delay starts after completion, so the rate never exceeds four frames per second. */
export async function pollBrowserFrames<T>(
  load: (signal: AbortSignal) => Promise<T>,
  publish: (frame: T) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const frame = await load(signal);
    if (signal.aborted) return;
    publish(frame);
    await nextFrameTick(signal);
  }
}

export function useBrowserFrame(
  sessionId: string,
  runtimeId: string | undefined,
  tabId: string | undefined,
  enabled: boolean,
  documentId?: string,
) {
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    setFrame(null);
    setError(null);
    if (!enabled || !visible || !runtimeId || !tabId) return;
    const abort = new AbortController();
    const urls = new Set<string>();
    let ticket: { ticket: string; expiresAt: number } | undefined;
    void pollBrowserFrames(
      async (signal) => {
        if (!ticket || ticket.expiresAt - Date.now() < 15_000)
          ticket = await browserApi.ticket(sessionId, signal);
        return fetchBrowserFrame(
          sessionId,
          runtimeId,
          tabId,
          ticket.ticket,
          signal,
        );
      },
      (data) => {
        const url = URL.createObjectURL(data.blob);
        urls.add(url);
        // Retain the previous frame while the browser decodes its replacement.
        if (urls.size > 2) {
          const oldest = urls.values().next().value;
          if (oldest) {
            URL.revokeObjectURL(oldest);
            urls.delete(oldest);
          }
        }
        setFrame({
          url,
          runtimeId,
          tabId,
          documentId: data.documentId,
          viewport: data.viewport,
        });
      },
      abort.signal,
    ).catch((failure: unknown) => {
      if (!abort.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "The browser view stopped. Retry to reconnect.",
        );
    });
    return () => {
      abort.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [sessionId, runtimeId, tabId, documentId, enabled, visible, revision]);
  return {
    frame:
      enabled &&
      visible &&
      frame &&
      frame.runtimeId === runtimeId &&
      frame.tabId === tabId
        ? frame
        : null,
    error,
    visible,
    retry: () => setRevision((value) => value + 1),
  };
}
