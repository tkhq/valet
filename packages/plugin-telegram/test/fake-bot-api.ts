import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";

export interface FakeBotApi {
  baseUrl: string;
  /** Every method call received, in order: { method, body } */
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  /** Queue of update batches returned by successive getUpdates calls. */
  pushUpdates(updates: unknown[]): void;
  /** File registry for getFile/download. */
  addFile(fileId: string, filePath: string, bytes: Uint8Array): void;
  close(): Promise<void>;
}

export async function startFakeBotApi(): Promise<FakeBotApi> {
  const calls: FakeBotApi["calls"] = [];
  const updateBatches: unknown[][] = [];
  const files = new Map<string, { filePath: string; bytes: Uint8Array }>();
  let nextMessageId = 1000;

  const app = new Hono();
  // Hono's router does not reliably resolve a second `:param` segment when the first
  // segment mixes a literal prefix ("bot") with an embedded param — it silently drops
  // the trailing param. Capture the whole first segment instead and split the method
  // off manually.
  app.post("/:botToken/:method", async (c) => {
    const method = c.req.param("method");
    const contentType = c.req.header("content-type") ?? "";
    const body: Record<string, unknown> = contentType.includes("application/json")
      ? ((await c.req.json()) as Record<string, unknown>)
      : Object.fromEntries((await c.req.formData()).entries());
    calls.push({ method, body });
    if (method === "getMe") {
      return c.json({ ok: true, result: { id: 42, is_bot: true, username: "valet_test_bot" } });
    }
    if (method === "getUpdates") {
      const batch = updateBatches.shift() ?? [];
      return c.json({ ok: true, result: batch });
    }
    if (method === "getFile") {
      const f = files.get(String(body.file_id));
      if (!f) return c.json({ ok: false, error_code: 400, description: "file not found" }, 400);
      return c.json({ ok: true, result: { file_id: body.file_id, file_path: f.filePath } });
    }
    if (method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") {
      return c.json({ ok: true, result: { message_id: nextMessageId++ } });
    }
    // editMessageText, editMessageReplyMarkup, answerCallbackQuery,
    // sendChatAction, setWebhook: generic ok
    return c.json({ ok: true, result: true });
  });
  app.get("/file/bot:token/*", (c) => {
    const filePath = c.req.path.replace(/^\/file\/bot[^/]+\//, "");
    for (const f of files.values()) {
      if (f.filePath === filePath) {
        const buffer = new ArrayBuffer(f.bytes.byteLength);
        new Uint8Array(buffer).set(f.bytes);
        return new Response(buffer);
      }
    }
    return c.text("not found", 404);
  });

  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    pushUpdates: (u) => updateBatches.push(u),
    addFile: (fileId, filePath, bytes) => files.set(fileId, { filePath, bytes }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
