import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

export interface FakeSlackApi {
  baseUrl: string;
  /** Every Web API method call received, in order: { method, body, auth } */
  calls: Array<{ method: string; body: Record<string, unknown>; auth?: string }>;
  /** Raw bodies POSTed to the external upload URL: { fileId, bytes } */
  uploads: Array<{ fileId: string; bytes: Uint8Array }>;
  /** Register a downloadable "url_private" file at {baseUrl}/files/{name}. Requires bearer auth. */
  addFile(name: string, bytes: Uint8Array): void;
  /** Workspace members returned by users.list. */
  setMembers(members: Array<Record<string, unknown>>): void;
  /** Channels returned by conversations.list. */
  setChannels(channels: Array<Record<string, unknown>>): void;
  /** files.info registry: fileId → file object. */
  setFileInfo(fileId: string, file: Record<string, unknown>): void;
  /** Make the next call to `method` return `{ ok: false, error }` once. */
  failNext(method: string, error?: string): void;
  /** Streams the fake has seen, keyed by ts. Models Slack's own state machine
   * so a test can prove the transport never appends to a closed stream. */
  streams: Map<string, FakeStream>;
  /** Mark a stream as ended by the reader, the way a Slack stop button does. */
  stopStreamAsUser(ts: string): void;
  close(): Promise<void>;
}

export interface FakeStream {
  channel: string;
  threadTs: string;
  open: boolean;
  /** Every markdown_text appended, in order. */
  appended: string[];
  /** markdown_text passed to chat.stopStream, when it carried one. */
  final?: string;
  /** True once the reader pressed stop; further appends fail `stopped_by_user`. */
  stoppedByUser: boolean;
}

export async function startFakeSlackApi(): Promise<FakeSlackApi> {
  const calls: FakeSlackApi["calls"] = [];
  const uploads: FakeSlackApi["uploads"] = [];
  const files = new Map<string, Uint8Array>();
  const fileInfos = new Map<string, Record<string, unknown>>();
  const pendingFailures = new Map<string, string>();
  const streams = new Map<string, FakeStream>();
  let members: Array<Record<string, unknown>> = [];
  let channels: Array<Record<string, unknown>> = [];
  let nextTs = 1;

  const app = new Hono();

  app.post("/upload/:fileId", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    uploads.push({ fileId: c.req.param("fileId"), bytes });
    return c.text("OK");
  });

  app.get("/files/:name", (c) => {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return c.text("unauthorized", 401);
    const bytes = files.get(c.req.param("name"));
    if (!bytes) return c.text("not found", 404);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Response(buffer);
  });

  app.on(["POST", "GET"], "/:method", async (c) => {
    const method = c.req.param("method");
    const auth = c.req.header("authorization");
    let body: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        body = (await c.req.json()) as Record<string, unknown>;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(await c.req.text()).entries());
      }
    } else {
      body = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    }
    calls.push({ method, body, auth });

    const failure = pendingFailures.get(method);
    if (failure !== undefined) {
      pendingFailures.delete(method);
      return c.json({ ok: false, error: failure });
    }

    switch (method) {
      case "chat.postMessage":
        return c.json({ ok: true, channel: body.channel, ts: `1700000000.${String(nextTs++).padStart(6, "0")}` });
      case "chat.update":
        return c.json({ ok: true, channel: body.channel, ts: body.ts });
      case "conversations.open":
        return c.json({ ok: true, channel: { id: `D-${String(body.users)}` } });
      case "files.getUploadURLExternal": {
        const fileId = `F${String(nextTs++)}`;
        return c.json({
          ok: true,
          upload_url: `http://127.0.0.1:${port}/upload/${fileId}`,
          file_id: fileId,
        });
      }
      case "files.completeUploadExternal":
        return c.json({ ok: true, files: (body.files as unknown[]) ?? [] });
      case "files.info": {
        const file = fileInfos.get(String(body.file));
        if (!file) return c.json({ ok: false, error: "file_not_found" });
        return c.json({ ok: true, file });
      }
      case "chat.startStream": {
        const ts = `1700000000.${String(nextTs++).padStart(6, "0")}`;
        streams.set(ts, {
          channel: String(body.channel),
          threadTs: String(body.thread_ts),
          open: true,
          appended: typeof body.markdown_text === "string" ? [body.markdown_text] : [],
          stoppedByUser: false,
        });
        return c.json({ ok: true, channel: body.channel, ts });
      }
      case "chat.appendStream": {
        const stream = streams.get(String(body.ts));
        if (!stream) return c.json({ ok: false, error: "message_not_found" });
        if (stream.stoppedByUser) return c.json({ ok: false, error: "stopped_by_user" });
        if (!stream.open) return c.json({ ok: false, error: "message_not_in_streaming_state" });
        stream.appended.push(String(body.markdown_text));
        return c.json({ ok: true });
      }
      case "chat.stopStream": {
        const stream = streams.get(String(body.ts));
        if (!stream) return c.json({ ok: false, error: "message_not_found" });
        if (!stream.open) return c.json({ ok: false, error: "message_not_in_streaming_state" });
        stream.open = false;
        if (typeof body.markdown_text === "string") stream.final = body.markdown_text;
        return c.json({ ok: true });
      }
      case "assistant.threads.setStatus":
      case "assistant.threads.setSuggestedPrompts":
      case "assistant.threads.setTitle":
        return c.json({ ok: true });
      case "auth.test":
        return c.json({ ok: true, team_id: "T1", user_id: "UBOT", bot_id: "B1" });
      case "users.list":
        return c.json({ ok: true, members, response_metadata: { next_cursor: "" } });
      case "users.info": {
        const member = members.find((m) => m.id === body.user);
        if (!member) return c.json({ ok: false, error: "user_not_found" });
        return c.json({ ok: true, user: member });
      }
      case "conversations.list":
        return c.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
      case "users.lookupByEmail": {
        const member = members.find((m) => {
          const profile = m.profile as Record<string, unknown> | undefined;
          return profile?.email === body.email;
        });
        // Slack's "no such member" code is users_not_found (plural).
        if (!member) return c.json({ ok: false, error: "users_not_found" });
        return c.json({ ok: true, user: member });
      }
      case "apps.connections.open":
        return c.json({ ok: true, url: "wss://127.0.0.1:1/link" });
      default:
        return c.json({ ok: true });
    }
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    uploads,
    addFile: (name, bytes) => files.set(name, bytes),
    setMembers: (m) => {
      members = m;
    },
    setChannels: (ch) => {
      channels = ch;
    },
    setFileInfo: (fileId, file) => fileInfos.set(fileId, file),
    failNext: (method, error = "simulated_failure") => pendingFailures.set(method, error),
    streams,
    stopStreamAsUser: (ts) => {
      const stream = streams.get(ts);
      if (stream) stream.stoppedByUser = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
