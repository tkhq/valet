# Telegram Channel (Phase 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first v2 channel plugin: the engine `ChannelTransport` contract, a Telegram transport (long-poll + webhook), identity linking from web settings, orchestrator-first DM routing, decision gates as inline keyboards, and attention delivery to Telegram.

**Architecture:** The engine gains an additive `transports` capability on `ValetPlugin` plus the `ChannelTransport` contract (verify/parse/poll ingress, send/gate outbound). A new `ChannelHost` service in `packages/api/src/channels/` owns both ingress modes and outbound event-stream delivery, routing DMs to the sender's user-orchestrator session on thread key `telegram:{chatId}`. `packages/plugin-telegram` implements the transport over the Bot API (code lifted from the legacy transport at commit `02dad643`).

**Tech Stack:** TypeScript (strict, no `any`), Hono 4, Drizzle/Postgres (PGlite dev), vitest, `@valet/engine`, Telegram Bot API.

**Spec:** `docs/specs/2026-07-15-telegram-channel-design.md` — its "Decisions (locked)" section is binding. Non-goals (groups, Slack, per-user bots, streaming mirror) are real; do not scope-creep.

## Global Constraints

- Every shell command runs under Node 22: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`.
- **Engine contract touchpoint:** Task 1 (`transports` on `ValetPlugin`) is a shared-contract change — it REQUIRES adversarial review (opus reviewer), and MUST be byte-identical for plugins that omit `transports` (regression test pinned in Task 1).
- **Pre-1.0 migrations:** schema changes edit `packages/api/migrations/pg/0000_app.sql` in place + matching Drizzle tables in `packages/api/src/schema/index.ts`. NO numbered migrations. After editing: `rm -rf ~/.valet/pg`.
- PGlite: ONE instance per process. API tests must use `freshTestPgDb()` from `packages/api/src/test-helpers/pg-test-db.ts`; never construct a second PGlite.
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md rules). Treat all Bot API payloads as `unknown` and narrow.
- Root `pnpm typecheck` does NOT cover `packages/web` — run `cd packages/web && pnpm typecheck` separately for web tasks.
- No Co-Authored-By trailers in commits.
- Drop-log reasons for this pass (spec decision 4): `unlinked_sender`, `duplicate`, `verify_failed`, `unsupported_kind`.
- Telegram callback_data is limited to **64 bytes** — gate ids (e.g. `gate:{sessionId}:{threadId}:{queueItemId}:{resumeKey}:{ordinal}`) NEVER go into callback_data. Gate callbacks are correlated by `(chatId, messageId)` via a host-side in-memory map (spec decision 7 allows in-memory delivery state).
- Kubernetes context safety: no cluster ops are needed in this plan; if you run any, pin `--context rancher-desktop`.

---

### Task 1: Engine — `ChannelTransport` contract + `transports` on `ValetPlugin`

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts`
- Modify: `packages/engine/src/index.ts` (re-exports)
- Test: `packages/engine/test/valet-plugin.test.ts`

**Interfaces:**
- Consumes: `StoredCredential` from `packages/engine/src/types.ts` (already exists).
- Produces (used by every later task): `ChannelTransport`, `ChannelTransportFactory`, `TransportContext`, `RawChannelUpdate`, `InboundChannelEvent`, `InboundChannelMedia`, `FetchedChannelMedia`, `OutboundChannelMessage`, `OutboundChannelAttachment`, `SendRef`, `GatePromptRef`, `ChannelGatePrompt`, `ChannelGateResolution`, and `ValetPlugin.transports?: ChannelTransportFactory[]`.

- [ ] **Step 1: Write failing tests**

Append to `packages/engine/test/valet-plugin.test.ts` (it already imports `validateValetPlugin` and has a `minimalPlugin()` helper — reuse them):

```ts
describe("validateValetPlugin transports", () => {
  it("accepts a plugin without transports (unchanged behavior)", () => {
    const res = validateValetPlugin(minimalPlugin());
    expect(res.ok).toBe(true);
  });

  it("accepts a valid transports array", () => {
    const res = validateValetPlugin({
      ...minimalPlugin(),
      transports: [{ channelType: "telegram", create: () => ({}) }],
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-array transports", () => {
    const res = validateValetPlugin({ ...minimalPlugin(), transports: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "transports")).toBe(true);
    }
  });

  it("rejects a factory missing channelType or create", () => {
    const res = validateValetPlugin({
      ...minimalPlugin(),
      transports: [{ channelType: "" }, { channelType: "x", create: "not-fn" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "transports[0].channelType")).toBe(true);
      expect(res.issues.some((i) => i.path === "transports[1].create")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test -- valet-plugin`
Expected: FAIL — the valid-transports case may pass vacuously but the rejection cases fail (no `transports` validation exists yet). If TypeScript rejects the object literals first, that is the same signal.

- [ ] **Step 3: Implement the contract**

In `packages/engine/src/valet-plugin.ts`, replace the header comment lines that say `No 'transports' field yet: the v2 ChannelTransport contract lands with the first channel plugin (Telegram, Phase 7) and the field is added then.` with a pointer to the new section, add `import type { StoredCredential } from "./types.js";`, and add:

```ts
// ─── Channel transports (v2 contract, Phase 7) ─────────────────────────────
//
// Verify-before-parse, same philosophy as TriggerDef: the host hands raw
// bytes to `verifyWebhook` (or consumes `poll()`), then feeds each
// RawChannelUpdate through `parseUpdate`. Conversation keys are a
// transport-owned codec (e.g. "telegram:dm:{chatId}") — the host treats
// them as opaque and passes them back verbatim for outbound sends.

/** One raw provider update (e.g. a Telegram Update object). Opaque to the host. */
export type RawChannelUpdate = unknown;

export interface TransportContext {
  /** Resolved org credential for the transport's service (e.g. the bot token). */
  credential: StoredCredential;
  /** Transport-specific config. Factories never read env vars. */
  config: Record<string, string>;
}

export interface ChannelSender {
  externalId: string;
  displayName?: string;
}

export interface InboundChannelMedia {
  kind: "photo" | "document" | "voice" | "audio";
  fileId: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

/** Where a sent message landed; also the correlation handle for gate edits. */
export interface SendRef {
  conversationKey: string;
  messageId: string;
}
export type GatePromptRef = SendRef;

export interface InboundChannelEvent {
  /** Dedup key, e.g. "telegram:{update_id}". */
  dispatchId: string;
  conversationKey: string;
  sender: ChannelSender;
  kind: "message" | "command" | "gate_callback";
  text?: string;
  /** Set when kind === "command" (e.g. /start <code>). */
  command?: { name: string; args?: string };
  media?: InboundChannelMedia[];
  /** Set when kind === "gate_callback". `ref` identifies the gate-prompt message. */
  gateCallback?: { actionId: string; callbackId: string; ref: GatePromptRef };
  raw: RawChannelUpdate;
}

export interface OutboundChannelMessage {
  markdown: string;
}

export type OutboundChannelAttachment =
  | { type: "image"; data: Uint8Array; mimeType: string; name?: string; caption?: string }
  | { type: "file"; data: Uint8Array; mimeType: string; name: string; caption?: string };

export interface ChannelGatePrompt {
  gateId: string;
  title: string;
  body?: string;
  actions: Array<{ id: string; label: string; style?: "primary" | "danger" }>;
}

export interface ChannelGateResolution {
  actionId?: string;
  /** Human-readable outcome line, e.g. "✅ Approved by conner". */
  label: string;
}

export interface FetchedChannelMedia {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}

export interface ChannelTransport {
  readonly channelType: string;
  /**
   * Verify an incoming webhook and extract its raw updates. `null` = reject.
   * secrets carries host-held values (for Telegram: { webhookSecret }).
   */
  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null;
  /** Long-poll ingress; yields until `signal` aborts. Optional per transport. */
  poll?(signal: AbortSignal): AsyncIterable<RawChannelUpdate>;
  /** Normalize one raw update. `null` = not something we handle. */
  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null;
  send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef>;
  sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef>;
  sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef>;
  updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void>;
  /** Download inbound media. `null` = unavailable (oversize, expired, …). */
  fetchMedia?(media: InboundChannelMedia): Promise<FetchedChannelMedia | null>;
  sendTyping?(conversationKey: string): Promise<void>;
  /** Ack an interactive callback (Telegram answerCallbackQuery). */
  answerCallback?(callbackId: string, text?: string): Promise<void>;
  /** Register the webhook endpoint with the provider (webhook mode only). */
  registerWebhook?(url: string, secretToken: string): Promise<void>;
}

export interface ChannelTransportFactory {
  channelType: string;
  create(ctx: TransportContext): ChannelTransport;
}
```

Add the field to `ValetPlugin` (after `credentials?`):

```ts
  transports?: ChannelTransportFactory[];
```

Add the validation branch inside `validateValetPlugin`, alongside the other `checkArray` calls (mirror the triggers branch exactly in style):

```ts
  checkArray(v.transports, "transports", issues, (item, path) => {
    const t = item as Partial<ChannelTransportFactory>;
    if (typeof t.channelType !== "string" || t.channelType === "") {
      issues.push({ path: `${path}.channelType`, message: "must be a non-empty string" });
    }
    if (typeof t.create !== "function") {
      issues.push({ path: `${path}.create`, message: "must be a function" });
    }
  });
```

(Match the actual `PluginValidationIssue` shape used by the existing branches — copy the push style from the triggers branch verbatim.)

- [ ] **Step 4: Re-export from `packages/engine/src/index.ts`**

Add the new type names to the existing `export type { … } from "./valet-plugin.js"` block: `ChannelTransport`, `ChannelTransportFactory`, `TransportContext`, `RawChannelUpdate`, `InboundChannelEvent`, `InboundChannelMedia`, `ChannelSender`, `FetchedChannelMedia`, `OutboundChannelMessage`, `OutboundChannelAttachment`, `SendRef`, `GatePromptRef`, `ChannelGatePrompt`, `ChannelGateResolution`.

- [ ] **Step 5: Run tests + full engine suite (byte-identical pin)**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test`
Expected: all pass, including the pre-existing `valet-plugin.test.ts` cases untouched (that green run + the "accepts a plugin without transports" case IS the absent-field regression pin).

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/valet-plugin.ts packages/engine/src/index.ts packages/engine/test/valet-plugin.test.ts
git commit -m "feat(engine): ChannelTransport contract + transports on ValetPlugin"
```

---

### Task 2: Telegram Bot API client + markdown→HTML formatter

**Files:**
- Create: `packages/plugin-telegram/src/transport/api.ts`
- Create: `packages/plugin-telegram/src/transport/format.ts`
- Create: `packages/plugin-telegram/test/fake-bot-api.ts` (shared fixture, used again in Task 3)
- Test: `packages/plugin-telegram/src/transport/format.test.ts`, `packages/plugin-telegram/src/transport/api.test.ts`
- Create: `packages/plugin-telegram/vitest.config.ts`
- Modify: `packages/plugin-telegram/package.json` (devDeps: `hono`, `@hono/node-server`)

**Interfaces:**
- Produces: `class TelegramApi` with constructor `(token: string, baseUrl = "https://api.telegram.org")` and methods `getMe()`, `getUpdates(opts)`, `sendMessage(opts)`, `sendPhoto(opts)`, `sendDocument(opts)`, `editMessageText(opts)`, `editMessageReplyMarkup(opts)`, `answerCallbackQuery(opts)`, `sendChatAction(chatId, action)`, `setWebhook(opts)`, `getFile(fileId)`, `downloadFile(filePath)`; and `markdownToTelegramHtml(text: string): string`.
- Consumes: nothing from other tasks.

The legacy implementation to lift from: `git show 02dad643:packages/plugin-telegram/src/channels/transport.ts` and `git show 02dad643:packages/plugin-telegram/src/channels/format.ts`. Lift the markdown→HTML logic verbatim (fenced/inline code behind `\x00` sentinels, escape `& < >`, bold-before-italic, links); restructure the HTTP calls into the typed client below.

- [ ] **Step 1: vitest config + devDeps**

`packages/plugin-telegram/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts"] },
});
```

Add to `packages/plugin-telegram/package.json` devDependencies: `"hono": "^4.6.0"`, `"@hono/node-server": "^1.13.0"` (match the versions pinned in `packages/api/package.json` — read them and copy exactly). Run `pnpm install`.

- [ ] **Step 2: Write failing formatter tests**

`packages/plugin-telegram/src/transport/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
  it("renders bold and italic", () => {
    expect(markdownToTelegramHtml("**bold** and *ital*")).toBe("<b>bold</b> and <i>ital</i>");
  });
  it("renders links", () => {
    expect(markdownToTelegramHtml("[x](https://e.co)")).toBe('<a href="https://e.co">x</a>');
  });
  it("protects fenced code blocks from formatting", () => {
    expect(markdownToTelegramHtml("```\n**not bold** <tag>\n```")).toBe(
      "<pre>**not bold** &lt;tag&gt;</pre>",
    );
  });
  it("protects inline code", () => {
    expect(markdownToTelegramHtml("run `a && b` now")).toBe("run <code>a &amp;&amp; b</code> now");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test -- format`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `format.ts`**

Lift from `git show 02dad643:packages/plugin-telegram/src/channels/format.ts` and adjust until the tests above pass exactly (the legacy version's behavior is the target; the tests encode it). Export `markdownToTelegramHtml(text: string): string`.

- [ ] **Step 5: Run formatter tests**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test -- format`
Expected: PASS.

- [ ] **Step 6: Write the fake Bot API fixture**

`packages/plugin-telegram/test/fake-bot-api.ts` — a Hono app that mimics `api.telegram.org` closely enough for the client + transport tests:

```ts
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
  app.post("/bot:token/:method", async (c) => {
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
      if (f.filePath === filePath) return c.body(f.bytes as unknown as ArrayBuffer);
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
```

(If the `c.body(...)` bytes overload fights the types, respond with `new Response(f.bytes)` instead — no casts.)

- [ ] **Step 7: Write failing client tests**

`packages/plugin-telegram/src/transport/api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeBotApi, type FakeBotApi } from "../../test/fake-bot-api.js";
import { TelegramApi } from "./api.js";

describe("TelegramApi", () => {
  let fake: FakeBotApi;
  let api: TelegramApi;
  beforeEach(async () => {
    fake = await startFakeBotApi();
    api = new TelegramApi("TESTTOKEN", fake.baseUrl);
  });
  afterEach(async () => {
    await fake.close();
  });

  it("getMe returns the bot user", async () => {
    const me = await api.getMe();
    expect(me.username).toBe("valet_test_bot");
  });

  it("sendMessage posts HTML text and returns message id", async () => {
    const res = await api.sendMessage({ chatId: 7, html: "<b>hi</b>" });
    expect(res.messageId).toBeGreaterThan(0);
    const call = fake.calls.find((c) => c.method === "sendMessage");
    expect(call?.body.parse_mode).toBe("HTML");
    expect(call?.body.chat_id).toBe(7);
  });

  it("getUpdates passes offset and timeout", async () => {
    fake.pushUpdates([{ update_id: 1 }]);
    const updates = await api.getUpdates({ offset: 5, timeoutSeconds: 1 });
    expect(updates).toHaveLength(1);
    const call = fake.calls.find((c) => c.method === "getUpdates");
    expect(call?.body.offset).toBe(5);
  });

  it("getFile + downloadFile round-trips bytes", async () => {
    fake.addFile("f1", "photos/p.jpg", new Uint8Array([1, 2, 3]));
    const file = await api.getFile("f1");
    const bytes = await api.downloadFile(file.filePath);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("throws a descriptive error on ok:false", async () => {
    await expect(api.getFile("missing")).rejects.toThrow(/file not found/);
  });
});
```

- [ ] **Step 8: Run to verify failure, then implement `api.ts`**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test -- api`
Expected: FAIL — module not found.

`packages/plugin-telegram/src/transport/api.ts`:

```ts
/** Thin typed client over the Telegram Bot API. All payloads narrowed from unknown. */

export interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TgFile { fileId: string; filePath: string; fileSize?: number }

export class TelegramApiError extends Error {
  constructor(method: string, description: string, readonly errorCode?: number) {
    super(`telegram ${method} failed: ${description}`);
  }
}

interface TgResponse { ok: boolean; result?: unknown; description?: string; error_code?: number }

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as TgResponse;
    if (!parsed.ok) throw new TelegramApiError(method, parsed.description ?? `http ${res.status}`, parsed.error_code);
    return parsed.result;
  }

  private async callMultipart(method: string, form: FormData): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: "POST", body: form });
    const parsed = (await res.json()) as TgResponse;
    if (!parsed.ok) throw new TelegramApiError(method, parsed.description ?? `http ${res.status}`, parsed.error_code);
    return parsed.result;
  }

  async getMe(): Promise<TgUser> {
    return (await this.call("getMe", {})) as TgUser;
  }

  async getUpdates(opts: { offset?: number; timeoutSeconds?: number }): Promise<unknown[]> {
    const result = await this.call("getUpdates", {
      offset: opts.offset,
      timeout: opts.timeoutSeconds ?? 30,
      allowed_updates: ["message", "callback_query"],
    });
    return Array.isArray(result) ? result : [];
  }

  async sendMessage(opts: {
    chatId: number | string;
    html: string;
    replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }): Promise<{ messageId: number }> {
    const result = (await this.call("sendMessage", {
      chat_id: opts.chatId,
      text: opts.html,
      parse_mode: "HTML",
      reply_markup: opts.replyMarkup,
    })) as { message_id: number };
    return { messageId: result.message_id };
  }

  async sendPhoto(opts: { chatId: number | string; data: Uint8Array; mimeType: string; caption?: string; name?: string }): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set("chat_id", String(opts.chatId));
    if (opts.caption !== undefined) form.set("caption", opts.caption);
    form.set("photo", new Blob([opts.data], { type: opts.mimeType }), opts.name ?? "photo");
    const result = (await this.callMultipart("sendPhoto", form)) as { message_id: number };
    return { messageId: result.message_id };
  }

  async sendDocument(opts: { chatId: number | string; data: Uint8Array; mimeType: string; caption?: string; name: string }): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set("chat_id", String(opts.chatId));
    if (opts.caption !== undefined) form.set("caption", opts.caption);
    form.set("document", new Blob([opts.data], { type: opts.mimeType }), opts.name);
    const result = (await this.callMultipart("sendDocument", form)) as { message_id: number };
    return { messageId: result.message_id };
  }

  async editMessageText(opts: { chatId: number | string; messageId: number; html: string }): Promise<void> {
    await this.call("editMessageText", {
      chat_id: opts.chatId, message_id: opts.messageId, text: opts.html, parse_mode: "HTML",
    });
  }

  async editMessageReplyMarkup(opts: { chatId: number | string; messageId: number }): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: opts.chatId, message_id: opts.messageId, reply_markup: { inline_keyboard: [] },
    });
  }

  async answerCallbackQuery(opts: { callbackQueryId: string; text?: string }): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: opts.callbackQueryId, text: opts.text });
  }

  async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
  }

  async setWebhook(opts: { url: string; secretToken: string }): Promise<void> {
    await this.call("setWebhook", {
      url: opts.url, secret_token: opts.secretToken, allowed_updates: ["message", "callback_query"],
    });
  }

  async getFile(fileId: string): Promise<TgFile> {
    const result = (await this.call("getFile", { file_id: fileId })) as {
      file_id: string; file_path: string; file_size?: number;
    };
    return { fileId: result.file_id, filePath: result.file_path, fileSize: result.file_size };
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new TelegramApiError("downloadFile", `http ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
```

- [ ] **Step 9: Run all plugin tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test && pnpm --filter @valet/plugin-telegram typecheck`
Expected: PASS / clean.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-telegram pnpm-lock.yaml
git commit -m "feat(plugin-telegram): Bot API client + markdown formatter with fake-server tests"
```

---

### Task 3: `TelegramTransport` implementing `ChannelTransport`

**Files:**
- Create: `packages/plugin-telegram/src/transport/transport.ts`
- Test: `packages/plugin-telegram/src/transport/transport.test.ts`

**Interfaces:**
- Consumes: `TelegramApi`, `markdownToTelegramHtml` (Task 2); `ChannelTransport` et al. from `@valet/engine` (Task 1).
- Produces: `class TelegramTransport implements ChannelTransport` with constructor `(api: TelegramApi)`; `telegramTransportFactory: ChannelTransportFactory` (channelType `"telegram"`, `create(ctx)` builds `TelegramApi` from `ctx.credential.accessToken ?? ctx.credential.apiKey` and optional `ctx.config.apiBaseUrl` for tests); helpers `conversationKeyForChat(chatId: number | string): string` (`telegram:dm:{chatId}`) and `chatIdFromConversationKey(key: string): string` (throws on non-`telegram:dm:` keys).
- Conventions later tasks rely on: `dispatchId = "telegram:{update_id}"`; callback_data format `g|{actionId}` (≤64 bytes — actionIds are short: `approve`, `deny`, option ids); `parseUpdate` maps `/start abc` to `kind: "command", command: { name: "start", args: "abc" }`; media limit 20 MB (`20 * 1024 * 1024`) enforced in `fetchMedia` (returns `null` when `fileSize` exceeds it).

- [ ] **Step 1: Write failing tests**

`packages/plugin-telegram/src/transport/transport.test.ts` (uses the fake Bot API fixture):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeBotApi, type FakeBotApi } from "../../test/fake-bot-api.js";
import { TelegramApi } from "./api.js";
import { chatIdFromConversationKey, conversationKeyForChat, TelegramTransport } from "./transport.js";

function msgUpdate(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 111,
    message: {
      message_id: 5,
      chat: { id: 99, type: "private" },
      from: { id: 77, first_name: "Ada", username: "ada" },
      text: "hello",
      ...overrides,
    },
  };
}

describe("TelegramTransport", () => {
  let fake: FakeBotApi;
  let transport: TelegramTransport;
  beforeEach(async () => {
    fake = await startFakeBotApi();
    transport = new TelegramTransport(new TelegramApi("T", fake.baseUrl));
  });
  afterEach(async () => {
    await fake.close();
  });

  it("conversationKey codec round-trips", () => {
    expect(conversationKeyForChat(99)).toBe("telegram:dm:99");
    expect(chatIdFromConversationKey("telegram:dm:99")).toBe("99");
    expect(() => chatIdFromConversationKey("slack:dm:1")).toThrow();
  });

  it("parses a text message", () => {
    const ev = transport.parseUpdate(msgUpdate());
    expect(ev).toMatchObject({
      dispatchId: "telegram:111",
      conversationKey: "telegram:dm:99",
      kind: "message",
      text: "hello",
      sender: { externalId: "77", displayName: "Ada" },
    });
  });

  it("parses /start with args as a command", () => {
    const ev = transport.parseUpdate(msgUpdate({ text: "/start abc123" }));
    expect(ev?.kind).toBe("command");
    expect(ev?.command).toEqual({ name: "start", args: "abc123" });
  });

  it("parses a photo with caption as message + media", () => {
    const ev = transport.parseUpdate(
      msgUpdate({
        text: undefined,
        caption: "look",
        photo: [
          { file_id: "small", width: 10, height: 10, file_size: 100 },
          { file_id: "big", width: 100, height: 100, file_size: 5000 },
        ],
      }),
    );
    expect(ev?.kind).toBe("message");
    expect(ev?.text).toBe("look");
    expect(ev?.media).toEqual([{ kind: "photo", fileId: "big", fileSize: 5000 }]);
  });

  it("parses a callback_query as gate_callback", () => {
    const ev = transport.parseUpdate({
      update_id: 222,
      callback_query: {
        id: "cb1",
        from: { id: 77, first_name: "Ada" },
        message: { message_id: 41, chat: { id: 99, type: "private" } },
        data: "g|approve",
      },
    });
    expect(ev?.kind).toBe("gate_callback");
    expect(ev?.gateCallback).toEqual({
      actionId: "approve",
      callbackId: "cb1",
      ref: { conversationKey: "telegram:dm:99", messageId: "41" },
    });
  });

  it("returns null for unsupported updates", () => {
    expect(transport.parseUpdate({ update_id: 3, edited_message: {} })).toBeNull();
  });

  it("verifyWebhook checks the secret token header", () => {
    const body = new TextEncoder().encode(JSON.stringify(msgUpdate()));
    const good = transport.verifyWebhook(
      { headers: { "x-telegram-bot-api-secret-token": "s3cret" }, rawBody: body },
      { webhookSecret: "s3cret" },
    );
    expect(good).toHaveLength(1);
    const bad = transport.verifyWebhook(
      { headers: { "x-telegram-bot-api-secret-token": "wrong" }, rawBody: body },
      { webhookSecret: "s3cret" },
    );
    expect(bad).toBeNull();
  });

  it("send converts markdown to HTML", async () => {
    const ref = await transport.send("telegram:dm:99", { markdown: "**hi**" });
    expect(ref.conversationKey).toBe("telegram:dm:99");
    const call = fake.calls.find((c) => c.method === "sendMessage");
    expect(call?.body.text).toBe("<b>hi</b>");
  });

  it("sendGatePrompt builds an inline keyboard and updateGatePrompt edits it", async () => {
    const ref = await transport.sendGatePrompt("telegram:dm:99", {
      gateId: "gate:long:id",
      title: "Deploy?",
      body: "to prod",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    });
    const sent = fake.calls.find((c) => c.method === "sendMessage");
    const markup = sent?.body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard[0]).toEqual([
      { text: "✅ Approve", callback_data: "g|approve" },
      { text: "❌ Deny", callback_data: "g|deny" },
    ]);
    for (const btn of markup.inline_keyboard[0]) {
      expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(64);
    }
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved by conner" });
    expect(fake.calls.some((c) => c.method === "editMessageText")).toBe(true);
  });

  it("fetchMedia downloads within the 20MB cap and refuses beyond it", async () => {
    fake.addFile("f1", "photos/p.jpg", new Uint8Array([9, 9]));
    const ok = await transport.fetchMedia({ kind: "photo", fileId: "f1", fileSize: 2 });
    expect(ok?.mimeType).toBe("image/jpeg");
    const refused = await transport.fetchMedia({
      kind: "document", fileId: "f1", fileSize: 21 * 1024 * 1024, fileName: "big.bin",
    });
    expect(refused).toBeNull();
  });

  it("poll yields updates and advances offset, stopping on abort", async () => {
    fake.pushUpdates([{ update_id: 1 }, { update_id: 2 }]);
    fake.pushUpdates([{ update_id: 3 }]);
    const ctrl = new AbortController();
    const seen: number[] = [];
    for await (const raw of transport.poll(ctrl.signal)) {
      seen.push((raw as { update_id: number }).update_id);
      if (seen.length === 3) ctrl.abort();
    }
    expect(seen).toEqual([1, 2, 3]);
    const calls = fake.calls.filter((c) => c.method === "getUpdates");
    expect(calls[1]?.body.offset).toBe(3); // last update_id + 1
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test -- transport`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `transport.ts`**

```ts
import type {
  ChannelGatePrompt,
  ChannelGateResolution,
  ChannelTransport,
  ChannelTransportFactory,
  FetchedChannelMedia,
  GatePromptRef,
  InboundChannelEvent,
  InboundChannelMedia,
  OutboundChannelAttachment,
  OutboundChannelMessage,
  RawChannelUpdate,
  SendRef,
  TransportContext,
} from "@valet/engine";
import { TelegramApi } from "./api.js";
import { markdownToTelegramHtml } from "./format.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
const COMMAND_RE = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

export function conversationKeyForChat(chatId: number | string): string {
  return `telegram:dm:${chatId}`;
}

export function chatIdFromConversationKey(key: string): string {
  const prefix = "telegram:dm:";
  if (!key.startsWith(prefix)) throw new Error(`not a telegram dm conversation key: ${key}`);
  return key.slice(prefix.length);
}

interface TgChat { id: number; type: string }
interface TgFrom { id: number; first_name?: string; last_name?: string; username?: string }
interface TgPhotoSize { file_id: string; file_size?: number }
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgFrom;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgFrom; message?: TgMessage; data?: string };
}

function displayName(from: TgFrom): string | undefined {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return name !== "" ? name : from.username;
}

function mediaOf(m: TgMessage): InboundChannelMedia[] | undefined {
  const media: InboundChannelMedia[] = [];
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1];
    media.push({ kind: "photo", fileId: largest.file_id, fileSize: largest.file_size });
  }
  if (m.document) {
    media.push({
      kind: "document", fileId: m.document.file_id, mimeType: m.document.mime_type,
      fileName: m.document.file_name, fileSize: m.document.file_size,
    });
  }
  if (m.voice) {
    media.push({ kind: "voice", fileId: m.voice.file_id, mimeType: m.voice.mime_type, fileSize: m.voice.file_size });
  }
  if (m.audio) {
    media.push({
      kind: "audio", fileId: m.audio.file_id, mimeType: m.audio.mime_type,
      fileName: m.audio.file_name, fileSize: m.audio.file_size,
    });
  }
  return media.length > 0 ? media : undefined;
}

const ACTION_EMOJI: Record<string, string> = { approve: "✅ ", deny: "❌ " };

export class TelegramTransport implements ChannelTransport {
  readonly channelType = "telegram";

  constructor(private readonly api: TelegramApi) {}

  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null {
    const token = req.headers["x-telegram-bot-api-secret-token"];
    if (!secrets.webhookSecret || token !== secrets.webhookSecret) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(req.rawBody));
      return [parsed];
    } catch {
      return null;
    }
  }

  async *poll(signal: AbortSignal): AsyncIterable<RawChannelUpdate> {
    let offset: number | undefined;
    let backoffMs = 1000;
    while (!signal.aborted) {
      let updates: unknown[];
      try {
        updates = await this.api.getUpdates({ offset, timeoutSeconds: 30 });
        backoffMs = 1000;
      } catch {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
      for (const raw of updates) {
        const u = raw as TgUpdate;
        if (typeof u.update_id === "number") offset = u.update_id + 1;
        yield raw;
        if (signal.aborted) return;
      }
    }
  }

  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    const u = update as TgUpdate;
    if (typeof u.update_id !== "number") return null;
    const dispatchId = `telegram:${u.update_id}`;

    if (u.callback_query) {
      const cb = u.callback_query;
      const msg = cb.message;
      if (!msg || typeof cb.data !== "string") return null;
      const [tag, actionId] = cb.data.split("|");
      if (tag !== "g" || !actionId) return null;
      return {
        dispatchId,
        conversationKey: conversationKeyForChat(msg.chat.id),
        sender: { externalId: String(cb.from.id), displayName: displayName(cb.from) },
        kind: "gate_callback",
        gateCallback: {
          actionId,
          callbackId: cb.id,
          ref: { conversationKey: conversationKeyForChat(msg.chat.id), messageId: String(msg.message_id) },
        },
        raw: update,
      };
    }

    const m = u.message;
    if (!m || !m.from || m.chat.type !== "private") return null;
    const base = {
      dispatchId,
      conversationKey: conversationKeyForChat(m.chat.id),
      sender: { externalId: String(m.from.id), displayName: displayName(m.from) },
      raw: update,
    };
    const text = m.text ?? m.caption;
    const media = mediaOf(m);
    if (m.text !== undefined) {
      const cmd = COMMAND_RE.exec(m.text);
      if (cmd) {
        return { ...base, kind: "command", text: m.text, command: { name: cmd[1], args: cmd[2]?.trim() || undefined } };
      }
    }
    if (text === undefined && media === undefined) return null;
    return { ...base, kind: "message", text, media };
  }

  async send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    const res = await this.api.sendMessage({ chatId, html: markdownToTelegramHtml(message.markdown) });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    const res =
      attachment.type === "image"
        ? await this.api.sendPhoto({ chatId, data: attachment.data, mimeType: attachment.mimeType, caption: attachment.caption, name: attachment.name })
        : await this.api.sendDocument({ chatId, data: attachment.data, mimeType: attachment.mimeType, caption: attachment.caption, name: attachment.name });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    const html = markdownToTelegramHtml(gate.body ? `**${gate.title}**\n\n${gate.body}` : `**${gate.title}**`);
    const buttons = gate.actions.map((a) => ({
      text: `${ACTION_EMOJI[a.id] ?? ""}${a.label}`,
      callback_data: `g|${a.id}`,
    }));
    const res = await this.api.sendMessage({ chatId, html, replyMarkup: { inline_keyboard: [buttons] } });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void> {
    const chatId = chatIdFromConversationKey(ref.conversationKey);
    await this.api.editMessageText({
      chatId, messageId: Number(ref.messageId), html: markdownToTelegramHtml(resolution.label),
    });
  }

  async fetchMedia(media: InboundChannelMedia): Promise<FetchedChannelMedia | null> {
    if (media.fileSize !== undefined && media.fileSize > MAX_FILE_BYTES) return null;
    let file;
    try {
      file = await this.api.getFile(media.fileId);
    } catch {
      return null;
    }
    if (file.fileSize !== undefined && file.fileSize > MAX_FILE_BYTES) return null;
    const data = await this.api.downloadFile(file.filePath);
    const ext = file.filePath.split(".").pop()?.toLowerCase();
    const mimeType =
      media.mimeType ??
      (media.kind === "photo"
        ? ext === "png" ? "image/png" : "image/jpeg"
        : media.kind === "voice" ? "audio/ogg" : "application/octet-stream");
    return { data, mimeType, name: media.fileName };
  }

  async sendTyping(conversationKey: string): Promise<void> {
    await this.api.sendChatAction(chatIdFromConversationKey(conversationKey), "typing");
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.api.answerCallbackQuery({ callbackQueryId: callbackId, text });
  }

  async registerWebhook(url: string, secretToken: string): Promise<void> {
    await this.api.setWebhook({ url, secretToken });
  }

  /** Exposed for the host's deep-link + boot check. Not part of ChannelTransport. */
  getMe(): ReturnType<TelegramApi["getMe"]> {
    return this.api.getMe();
  }
}

export const telegramTransportFactory: ChannelTransportFactory = {
  channelType: "telegram",
  create(ctx: TransportContext): ChannelTransport {
    const token = ctx.credential.accessToken ?? ctx.credential.apiKey;
    if (!token) throw new Error("telegram transport requires a bot token credential");
    return new TelegramTransport(new TelegramApi(token, ctx.config.apiBaseUrl));
  },
};
```

Note `TelegramApi` constructor default handles `ctx.config.apiBaseUrl === undefined` — pass `ctx.config.apiBaseUrl ?? undefined` if the index-signature type is `string | undefined` already; do NOT cast.

- [ ] **Step 4: Run tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test && pnpm --filter @valet/plugin-telegram typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-telegram
git commit -m "feat(plugin-telegram): TelegramTransport over the v2 ChannelTransport contract"
```

---

### Task 4: Plugin manifest activation + registry

**Files:**
- Modify: `packages/plugin-telegram/src/plugin.ts`
- Modify: `packages/plugin-telegram/plugin.yaml` (remove `enabled: false` + its comment block)
- Modify: `packages/api/package.json` (add `"@valet/plugin-telegram": "workspace:*"` to dependencies)
- Regenerate: `packages/api/src/plugins/registry.gen.ts` (via script — do not hand-edit)
- Test: `packages/plugin-telegram/src/plugin.test.ts`

**Interfaces:**
- Consumes: `telegramTransportFactory` (Task 3), `validateValetPlugin` (Task 1).
- Produces: `@valet/plugin-telegram/plugin` default export with `transports: [telegramTransportFactory]` and `credentials: [{ type: "bot_token", configKeys: ["accessToken"], connectLabel: "Connect Telegram bot" }]` — the api bundles it via `registry.gen.ts`.

- [ ] **Step 1: Write failing test**

`packages/plugin-telegram/src/plugin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateValetPlugin } from "@valet/engine";
import plugin from "./plugin.js";

describe("telegram plugin manifest", () => {
  it("passes structural validation", () => {
    const res = validateValetPlugin(plugin);
    expect(res).toEqual({ ok: true, plugin });
  });
  it("declares the telegram transport and bot_token credential", () => {
    expect(plugin.transports?.[0]?.channelType).toBe("telegram");
    expect(plugin.credentials?.[0]).toMatchObject({ type: "bot_token", configKeys: ["accessToken"] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test -- plugin`
Expected: FAIL — manifest has no transports/credentials.

- [ ] **Step 3: Implement the manifest**

`packages/plugin-telegram/src/plugin.ts`:

```ts
import type { ValetPlugin } from "@valet/engine";
import { telegramTransportFactory } from "./transport/transport.js";

const plugin: ValetPlugin = {
  name: "telegram",
  version: "0.1.0",
  description: "Telegram bot channel: orchestrator DMs, gates as inline keyboards, media",
  transports: [telegramTransportFactory],
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Telegram bot",
    },
  ],
};

export default plugin;
```

In `plugin.yaml`, delete the `enabled: false` line AND the explanatory comment block above it (the one starting "Manifest exists so Phase 7…").

- [ ] **Step 4: Wire into the api bundle**

Add to `packages/api/package.json` dependencies (alphabetical position): `"@valet/plugin-telegram": "workspace:*"`. Then:

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm install && pnpm --filter @valet/plugin-telegram build && pnpm tsx scripts/generate-v2-registry.ts
```

Expected: `registry.gen.ts` now imports `@valet/plugin-telegram/plugin` (17 plugins). The script requires `dist/plugin.js` metadata to exist — hence the build first.

- [ ] **Step 5: Run tests + full typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/plugin-telegram test && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-telegram packages/api/package.json packages/api/src/plugins/registry.gen.ts pnpm-lock.yaml
git commit -m "feat(plugin-telegram): activate v2 manifest with transport + bot_token credential"
```

---

### Task 5: Schema + identity-link code service

**Files:**
- Modify: `packages/api/src/schema/index.ts` (new `identityLinkCodes` table; `notifyAttention` column on `userIdentityLinks`)
- Modify: `packages/api/migrations/pg/0000_app.sql` (same, edited in place — pre-1.0 rule)
- Create: `packages/api/src/channels/identity-links.ts`
- Test: `packages/api/src/channels/identity-links.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6, 9, 10):
  - `mintLinkCode(db: AppDb, userId: string, provider: string, now?: number): Promise<string>` — returns the raw single-use code (22-char base64url), stores only its sha256 hex hash, 10-minute expiry, and deletes any previous unconsumed codes for `(userId, provider)`.
  - `consumeLinkCode(db: AppDb, provider: string, code: string, now?: number): Promise<{ userId: string } | null>` — verifies hash + expiry, deletes the row (single use), `null` on miss/expired.
  - `linkIdentity(db: AppDb, args: { provider: string; externalId: string; userId: string }): Promise<void>` — replaces any existing row for `(provider, externalId)` OR `(provider, userId)`, inserts with `notifyAttention: true`.
  - `unlinkIdentity(db: AppDb, provider: string, userId: string): Promise<void>`
  - `identityForExternal(db: AppDb, provider: string, externalId: string): Promise<{ userId: string; notifyAttention: boolean } | null>`
  - `identityForUser(db: AppDb, provider: string, userId: string): Promise<{ externalId: string; notifyAttention: boolean; createdAt: number } | null>`
  - `setNotifyAttention(db: AppDb, provider: string, userId: string, enabled: boolean): Promise<void>`

- [ ] **Step 1: Edit the schema (Drizzle)**

In `packages/api/src/schema/index.ts`, add `notifyAttention` to `userIdentityLinks` after `createdAt`:

```ts
    notifyAttention: boolean("notify_attention").notNull().default(true),
```

(`boolean` is already imported from `drizzle-orm/pg-core` elsewhere in the file — check the import list at the top and extend it if not.)

Below `userIdentityLinks`, add:

```ts
// Single-use, short-lived codes for linking an external chat identity to a
// Valet user (deep-link /start flow). Only the sha256 hash is stored.
export const identityLinkCodes = pgTable(
  "identity_link_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("identity_link_codes_provider").on(t.provider, t.codeHash)],
);
```

Add the row type next to the other `$inferSelect` exports:

```ts
export type IdentityLinkCodeRow = typeof identityLinkCodes.$inferSelect;
```

- [ ] **Step 2: Edit `0000_app.sql` in place**

In `packages/api/migrations/pg/0000_app.sql`, extend the `user_identity_links` CREATE TABLE with a trailing column:

```sql
	"notify_attention" boolean DEFAULT true NOT NULL
```

and add after that table's index:

```sql
CREATE TABLE "identity_link_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
CREATE INDEX "identity_link_codes_provider" ON "identity_link_codes" ("provider","code_hash");
```

Then reset local dev data: `rm -rf ~/.valet/pg` (tests use `freshTestPgDb()` which re-applies migrations per file — no action needed there).

- [ ] **Step 3: Write failing service tests**

`packages/api/src/channels/identity-links.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import {
  consumeLinkCode, identityForExternal, identityForUser, linkIdentity,
  mintLinkCode, setNotifyAttention, unlinkIdentity,
} from "./identity-links.js";

describe("identity link codes", () => {
  let db: TestPgDb;
  beforeEach(async () => {
    db = await freshTestPgDb();
  });

  it("mints a code and consumes it exactly once", async () => {
    const code = await mintLinkCode(db.appDb, "u1", "telegram");
    expect(code.length).toBeGreaterThanOrEqual(20);
    expect(await consumeLinkCode(db.appDb, "telegram", code)).toEqual({ userId: "u1" });
    expect(await consumeLinkCode(db.appDb, "telegram", code)).toBeNull();
  });

  it("rejects expired codes", async () => {
    const t0 = 1_000_000;
    const code = await mintLinkCode(db.appDb, "u1", "telegram", t0);
    expect(await consumeLinkCode(db.appDb, "telegram", code, t0 + 11 * 60_000)).toBeNull();
  });

  it("rejects unknown codes", async () => {
    expect(await consumeLinkCode(db.appDb, "telegram", "nope")).toBeNull();
  });

  it("re-minting invalidates the previous code", async () => {
    const first = await mintLinkCode(db.appDb, "u1", "telegram");
    const second = await mintLinkCode(db.appDb, "u1", "telegram");
    expect(await consumeLinkCode(db.appDb, "telegram", first)).toBeNull();
    expect(await consumeLinkCode(db.appDb, "telegram", second)).toEqual({ userId: "u1" });
  });
});

describe("identity links", () => {
  let db: TestPgDb;
  beforeEach(async () => {
    db = await freshTestPgDb();
  });

  it("links, reads both directions, unlinks", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toEqual({
      userId: "u1", notifyAttention: true,
    });
    expect(await identityForUser(db.appDb, "telegram", "u1")).toMatchObject({ externalId: "77" });
    await unlinkIdentity(db.appDb, "telegram", "u1");
    expect(await identityForExternal(db.appDb, "telegram", "77")).toBeNull();
  });

  it("re-linking the same telegram account to a new user replaces the row", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u2" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toEqual({
      userId: "u2", notifyAttention: true,
    });
    expect(await identityForUser(db.appDb, "telegram", "u1")).toBeNull();
  });

  it("re-linking the same user to a new telegram account replaces the row", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "88", userId: "u1" });
    expect(await identityForExternal(db.appDb, "telegram", "77")).toBeNull();
    expect(await identityForUser(db.appDb, "telegram", "u1")).toMatchObject({ externalId: "88" });
  });

  it("notification preference toggles", async () => {
    await linkIdentity(db.appDb, { provider: "telegram", externalId: "77", userId: "u1" });
    await setNotifyAttention(db.appDb, "telegram", "u1", false);
    expect((await identityForExternal(db.appDb, "telegram", "77"))?.notifyAttention).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- identity-links`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `identity-links.ts`**

`packages/api/src/channels/identity-links.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { identityLinkCodes, userIdentityLinks } from "../schema/index.js";

const CODE_TTL_MS = 10 * 60_000;

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function uid(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

export async function mintLinkCode(
  db: AppDb, userId: string, provider: string, now = Date.now(),
): Promise<string> {
  const code = randomBytes(16).toString("base64url");
  await db.delete(identityLinkCodes).where(
    and(eq(identityLinkCodes.userId, userId), eq(identityLinkCodes.provider, provider)),
  );
  await db.insert(identityLinkCodes).values({
    id: uid("ilc"), userId, provider,
    codeHash: hashCode(code), expiresAt: now + CODE_TTL_MS, createdAt: now,
  });
  return code;
}

export async function consumeLinkCode(
  db: AppDb, provider: string, code: string, now = Date.now(),
): Promise<{ userId: string } | null> {
  const rows = await db
    .delete(identityLinkCodes)
    .where(and(eq(identityLinkCodes.provider, provider), eq(identityLinkCodes.codeHash, hashCode(code))))
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt < now) return null;
  return { userId: row.userId };
}

/** Opportunistic GC — callers may invoke on mint; not required for correctness. */
export async function pruneExpiredLinkCodes(db: AppDb, now = Date.now()): Promise<void> {
  await db.delete(identityLinkCodes).where(lt(identityLinkCodes.expiresAt, now));
}

export async function linkIdentity(
  db: AppDb, args: { provider: string; externalId: string; userId: string }, now = Date.now(),
): Promise<void> {
  await db.delete(userIdentityLinks).where(
    and(
      eq(userIdentityLinks.provider, args.provider),
      or(eq(userIdentityLinks.externalId, args.externalId), eq(userIdentityLinks.userId, args.userId)),
    ),
  );
  await db.insert(userIdentityLinks).values({
    id: uid("uil"), provider: args.provider, externalId: args.externalId,
    userId: args.userId, createdAt: now, notifyAttention: true,
  });
}

export async function unlinkIdentity(db: AppDb, provider: string, userId: string): Promise<void> {
  await db.delete(userIdentityLinks).where(
    and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)),
  );
}

export async function identityForExternal(
  db: AppDb, provider: string, externalId: string,
): Promise<{ userId: string; notifyAttention: boolean } | null> {
  const rows = await db.select().from(userIdentityLinks).where(
    and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.externalId, externalId)),
  );
  const row = rows[0];
  return row ? { userId: row.userId, notifyAttention: row.notifyAttention } : null;
}

export async function identityForUser(
  db: AppDb, provider: string, userId: string,
): Promise<{ externalId: string; notifyAttention: boolean; createdAt: number } | null> {
  const rows = await db.select().from(userIdentityLinks).where(
    and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)),
  );
  const row = rows[0];
  return row ? { externalId: row.externalId, notifyAttention: row.notifyAttention, createdAt: row.createdAt } : null;
}

export async function setNotifyAttention(
  db: AppDb, provider: string, userId: string, enabled: boolean,
): Promise<void> {
  await db.update(userIdentityLinks).set({ notifyAttention: enabled }).where(
    and(eq(userIdentityLinks.provider, provider), eq(userIdentityLinks.userId, userId)),
  );
}
```

Note: `consumeLinkCode` uses `DELETE … RETURNING` so single-use is atomic — two concurrent consumers cannot both succeed.

- [ ] **Step 6: Run tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- identity-links && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql packages/api/src/channels
git commit -m "feat(api): identity link codes + notify preference on identity links"
```

---

### Task 6: `ChannelHost` — inbound routing (`handleUpdate`)

**Files:**
- Create: `packages/api/src/channels/host.ts`
- Create: `packages/api/src/orchestrator/ensure.ts` (extract get-or-create-orchestrator-session helper)
- Modify: `packages/api/src/routes/orchestrator.ts` (use the extracted helper — behavior unchanged)
- Test: `packages/api/src/channels/host.test.ts`

**Interfaces:**
- Consumes: contract types from Task 1; `mintLinkCode`/`consumeLinkCode`/`linkIdentity`/`identityForExternal` (Task 5); `writeDropLog(db, { orgId, reason, conversationKey?, detail })` from `packages/api/src/orchestrator/signals.ts`; `EngineHost.orchestratorSessionFor(principal, { actorUserId, orgId })`; `orchestratorSessionId` from `@valet/engine`; `session.thread(key)`; `thread.submitPrompt(content, opts)`; `engineSession.resolveDecision(gateId, resolution)`.
- Produces (consumed by Tasks 7–10):
  - `class ChannelHost` constructed with `ChannelHostDeps`:
    ```ts
    export interface ChannelHostDeps {
      db: AppDb;
      engineHost: EngineHost;
      engineStore: SessionStore;
      eventStream: EventStream;
      engineCredentials: CredentialStore;
      plugins: ValetPlugin[];
      /** Public base URL for webhook mode; undefined → long-poll. */
      publicUrl?: string;
      /** Resolves the single org id (single-org assumption, same as auth middleware). */
      resolveOrgId: () => Promise<string>;
      now?: () => number;
    }
    ```
  - `handleUpdate(channelType: string, event: InboundChannelEvent): Promise<void>` (exposed for tests and the poll/webhook paths).
  - `handleWebhook(channelType: string, req: { headers: Record<string, string>; rawBody: Uint8Array }): Promise<"ok" | "rejected" | "unknown_channel">`.
  - `start(): Promise<void>` / `stop(): Promise<void>` (Task 8 wires these; in this task implement transport construction inside `start` but the poll loop lands in Task 8 — `start` here: resolve org id, resolve credential per factory, `create` transport, `getMe`-probe when the transport is Telegram's, cache `botUsername`).
  - `transportFor(channelType: string): ChannelTransport | null`, `botUsername(channelType: string): string | null`, `isRunning(channelType: string): boolean`.
  - `recordGatePrompt(gateId: string, ref: GatePromptRef, sessionId: string): void` + `gateForRef(ref: GatePromptRef): { gateId: string; sessionId: string } | null` (in-memory maps — Task 7 records, this task's callback path reads).
- Orchestrator helper produced here: `packages/api/src/orchestrator/ensure.ts` exporting
  ```ts
  export async function ensureOrchestratorSession(
    deps: { db: AppDb; engineHost: EngineHost },
    principal: Principal,
    meta: { actorUserId: string; orgId: string },
  ): Promise<{ sessionId: string; session: Session }>
  ```
  Lift the body from `POST /api/orchestrator` in `packages/api/src/routes/orchestrator.ts`: call `engineHost.orchestratorSessionFor(principal, meta)` then upsert the `agentSessions` app row exactly as the route does today (`title: "Assistant"`, `.onConflictDoNothing()`), and refactor the route to call this helper. No behavior change — the route's existing tests must stay green.

**Routing rules implemented by `handleUpdate` (spec decisions 4–6, 10):**
1. In-memory LRU dedup (Set of `dispatchId`, cap 2048, FIFO eviction) — duplicate → drop-log `duplicate` and return. (Message prompts additionally get durable dedup for free via `submitPrompt`'s `dispatchId`.)
2. `kind === "command"` with `command.name === "start"` and args: `consumeLinkCode(db, channelType, args)` → hit: `linkIdentity`, reply "✅ Linked! You're chatting with your Valet assistant." → miss: reply "That link code is invalid or expired — get a fresh one from Settings → Connected accounts."
3. Any other event: resolve sender via `identityForExternal(db, channelType, sender.externalId)`. Unlinked → drop-log `unlinked_sender` + at most one reply per conversation per hour (in-memory `Map<conversationKey, number>`): "Link your Valet account to chat here: open Settings → Connected accounts in the web app."
4. Linked + `kind === "message"`: `ensureOrchestratorSession` for `{ type: "user", id: userId }`; thread `session.thread("telegram:" + chatIdFromKey(event.conversationKey))` — the host derives chatId by taking the substring after the LAST `:` of the conversationKey (host-side convention; keeps the host codec-agnostic enough for this pass). Download media via `transport.fetchMedia` → `PromptAttachment[]` (photo→`image`, voice/audio→`audio`, document→`file`); a `null` fetch appends `\n\n[attachment skipped: too large or unavailable]` to the text. Then:
   ```ts
   await thread.submitPrompt(
     { text: text === "" ? "(media message)" : text, attachments },
     {
       dispatchId: event.dispatchId,
       author: { id: userId, name: event.sender.displayName, externalId: event.sender.externalId },
     },
   );
   ```
   After admission, best-effort `transport.sendTyping?.(event.conversationKey)` (swallow errors).
5. Linked + `kind === "gate_callback"`: look up `gateForRef(event.gateCallback.ref)`; unknown → `transport.answerCallback?.(callbackId, "This approval has expired — resolve it on the web.")` + drop-log `unsupported_kind` (detail `unknown_gate_ref`). Known → verify the gate's session belongs to this user (the map stores `sessionId`; require `sessionId === orchestratorSessionId({ type: "user", id: userId })` OR the `agentSessions` row's `userId` equals the linked user — implement the latter, it covers both), then `engineSession.resolveDecision(gateId, { actionId, resolvedBy: userId, resolvedAt: now(), source: { channelType, channelId: event.conversationKey, messageId: event.gateCallback.ref.messageId } })`, then `answerCallback(callbackId)`. (The message edit happens via the `decision_gate_resolved` event in Task 7 — do NOT edit here; that keeps web-resolved and telegram-resolved gates on one path.)
6. Any other kind/command → drop-log `unsupported_kind`.
7. Every `handleUpdate` body is wrapped in try/catch — a routing failure logs `console.error("[channels] update failed", err)` and never throws into the poll loop / webhook handler.

- [ ] **Step 1: Extract `ensureOrchestratorSession` + keep orchestrator route green**

Create `packages/api/src/orchestrator/ensure.ts` per the interface above (lift the exact upsert from `routes/orchestrator.ts` `POST /`), refactor the route to call it.
Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- orchestrator`
Expected: PASS (pre-existing route tests unchanged).
Commit: `git add packages/api/src/orchestrator packages/api/src/routes/orchestrator.ts && git commit -m "refactor(api): extract ensureOrchestratorSession helper"`

- [ ] **Step 2: Write failing host tests**

`packages/api/src/channels/host.test.ts`. Build a fake transport + a real engine over the API test harness pieces. Follow the provider-construction pattern used by `packages/api/src/integration/_setup.ts` (`freshTestPgDb`, `PgSessionStore`, `PgEventStream`, `PgCredentialStore`, `VirtualSandboxProvider`, `EngineHost`) but in-process — no HTTP server needed. Read `_setup.ts` first and mirror how it constructs `EngineHost` (model comes from `registerFauxProvider` + `fauxAssistantMessage`, same as `packages/engine/test/happy-path.test.ts`).

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelTransport, GatePromptRef, InboundChannelEvent, OutboundChannelMessage,
} from "@valet/engine";
import { eq } from "drizzle-orm";
import { eventDropLog, userIdentityLinks } from "../schema/index.js";
import { linkIdentity, mintLinkCode } from "./identity-links.js";
import { ChannelHost } from "./host.js";
// + the harness imports mirroring _setup.ts (freshTestPgDb, EngineHost, stores, faux provider)

class FakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  sent: Array<{ conversationKey: string; message: OutboundChannelMessage }> = [];
  answered: Array<{ callbackId: string; text?: string }> = [];
  verifyWebhook(): null { return null; }
  parseUpdate(): null { return null; }
  async send(conversationKey: string, message: OutboundChannelMessage) {
    this.sent.push({ conversationKey, message });
    return { conversationKey, messageId: String(this.sent.length) };
  }
  async sendMedia(conversationKey: string) { return { conversationKey, messageId: "m" }; }
  async sendGatePrompt(conversationKey: string) { return { conversationKey, messageId: "g" }; }
  async updateGatePrompt() {}
  async answerCallback(callbackId: string, text?: string) { this.answered.push({ callbackId, text }); }
}

function inbound(overrides: Partial<InboundChannelEvent> = {}): InboundChannelEvent {
  return {
    dispatchId: `fake:${Math.floor(Math.random() * 1e9)}`,
    conversationKey: "fake:dm:99",
    sender: { externalId: "77", displayName: "Ada" },
    kind: "message",
    text: "hello",
    raw: {},
    ...overrides,
  };
}

describe("ChannelHost.handleUpdate", () => {
  // beforeEach: fresh db + engine harness; host = new ChannelHost({...deps, plugins: []});
  // host.registerTransportForTest("fake", fakeTransport)  ← add this test-only setter,
  // or construct via a plugin manifest with a factory returning fakeTransport — prefer
  // the factory route: plugins: [{ name: "fake", version: "0", transports: [{ channelType: "fake", create: () => fakeTransport }] }]
  // + a saved org bot_token credential so start() activates it.

  it("unlinked sender: drop log row + one rate-limited reply", async () => {
    await host.handleUpdate("fake", inbound());
    await host.handleUpdate("fake", inbound({ text: "again" }));
    const drops = await db.appDb.select().from(eventDropLog);
    expect(drops.filter((d) => d.reason === "unlinked_sender")).toHaveLength(2);
    expect(fakeTransport.sent).toHaveLength(1); // second reply suppressed within the hour
  });

  it("/start with a valid code links the account and confirms", async () => {
    const code = await mintLinkCode(db.appDb, "local-user", "fake");
    await host.handleUpdate("fake", inbound({ kind: "command", command: { name: "start", args: code } }));
    const links = await db.appDb.select().from(userIdentityLinks)
      .where(eq(userIdentityLinks.provider, "fake"));
    expect(links[0]).toMatchObject({ externalId: "77", userId: "local-user" });
    expect(fakeTransport.sent[0]?.message.markdown).toContain("Linked");
  });

  it("/start with a bad code replies invalid and does not link", async () => {
    await host.handleUpdate("fake", inbound({ kind: "command", command: { name: "start", args: "bad" } }));
    expect(fakeTransport.sent[0]?.message.markdown).toMatch(/invalid or expired/i);
  });

  it("linked message is admitted on the orchestrator thread telegram-style key with dispatch dedup", async () => {
    await linkIdentity(db.appDb, { provider: "fake", externalId: "77", userId: "local-user" });
    const ev = inbound({ dispatchId: "fake:1" });
    await host.handleUpdate("fake", ev);
    await host.handleUpdate("fake", { ...ev }); // duplicate update_id
    // assert: exactly ONE user entry admitted on the orchestrator session thread "fake:99"
    // via engineStore.getEntries(orchestratorSessionId({type:"user",id:"local-user"}), threadId)
    // and a drop-log row with reason "duplicate" for the second.
  });

  it("gate_callback with unknown ref answers 'expired' and drop-logs", async () => {
    await linkIdentity(db.appDb, { provider: "fake", externalId: "77", userId: "local-user" });
    await host.handleUpdate("fake", inbound({
      kind: "gate_callback",
      gateCallback: { actionId: "approve", callbackId: "cb9", ref: { conversationKey: "fake:dm:99", messageId: "41" } },
    }));
    expect(fakeTransport.answered[0]).toMatchObject({ callbackId: "cb9" });
    const drops = await db.appDb.select().from(eventDropLog);
    expect(drops.some((d) => d.reason === "unsupported_kind" && d.detail.includes("unknown_gate_ref"))).toBe(true);
  });
});
```

Fill in the harness `beforeEach` by mirroring `_setup.ts` exactly (this is deliberate reading work for the implementer — the file is the source of truth for constructor args). The faux model means the orchestrator session's turn resolves without a real API key; the assertions above only need the ADMITTED user entry, so if driving a full turn proves heavy, assert on `engineStore.getEntries` or the queue instead — the required outcome is stated in each test.

- [ ] **Step 3: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- channels/host`
Expected: FAIL — `./host.js` not found.

- [ ] **Step 4: Implement `host.ts` (inbound half)**

Implement `ChannelHost` per the Interfaces block and routing rules 1–7 above. Structure:

```ts
export class ChannelHost {
  private transports = new Map<string, ChannelTransport>();
  private botUsernames = new Map<string, string>();
  private seenDispatchIds = new Set<string>();      // LRU cap 2048
  private seenOrder: string[] = [];
  private unlinkedReplyAt = new Map<string, number>(); // conversationKey → ts
  private gateRefs = new Map<string, { gateId: string; sessionId: string }>(); // `${convKey}#${messageId}`
  private gatePrompts = new Map<string, GatePromptRef>(); // gateId → ref (Task 7 uses for edits)
  private orgId: string | null = null;
  constructor(private readonly deps: ChannelHostDeps) {}
  // start(): resolve orgId via deps.resolveOrgId(); for each plugin transport factory:
  //   credential = await deps.engineCredentials.get({ type: "org", id: orgId }, factory.channelType)
  //   no credential → console.log(`[channels] ${factory.channelType}: no bot token, transport not started`)
  //   else transport = factory.create({ credential, config: {} }); this.transports.set(...)
  //   telegram-shaped getMe probe: if transport has a getMe method (feature-detect via
  //   typeof (t as { getMe?: unknown }).getMe === "function" — narrow, don't cast broadly),
  //   call it and cache username in botUsernames.
  // stop(): no-op here (Task 8 adds poll abort + subscription teardown).
}
```

The user-ownership check for gate callbacks (rule 5): query `agentSessions` (`packages/api/src/schema/index.ts`) for `id = mapped.sessionId AND userId = linked.userId`; no row → treat as unknown ref.

- [ ] **Step 5: Run tests until green**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- channels && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/channels packages/api/src/orchestrator packages/api/src/routes/orchestrator.ts
git commit -m "feat(api): ChannelHost inbound routing — linking, dedup, orchestrator prompts, gate callbacks"
```

---

### Task 7: `ChannelHost` — outbound delivery (messages, gates, edits)

**Files:**
- Modify: `packages/api/src/channels/host.ts`
- Test: `packages/api/src/channels/host-outbound.test.ts`

**Interfaces:**
- Consumes: `EventStream.subscribe(filter, cb)`; `SessionStore.getThread(sessionId, threadId)` (→ `ThreadData.key`), `SessionStore.getEntries(sessionId, threadId)`; `MessageEntry` (`role`, `id`, `content`, `parts`, `stopReason`); `DecisionGate` (`id`, `sessionId`, `threadId`, `title`, `body`, `actions`); events `message_end` / `decision_gate` / `decision_gate_resolved`.
- Produces: `startOutbound(): void` + `stopOutbound(): void` (called from `start`/`stop`); channel-thread predicate `channelThreadFor(key: string): { channelType: string; conversationKey: string } | null` — key `telegram:{chatId}` → `{ channelType: "telegram", conversationKey: "telegram:dm:{chatId}" }`; generically: `key.split(":")` where the FIRST segment names a running transport → conversationKey `${channelType}:dm:${rest}`. Keys like `web:default` return null.

**Delivery rules (spec decisions 7–8):**
1. Subscribe once (no sessionId filter) to `eventTypes: ["message_end", "decision_gate", "decision_gate_resolved"]`. Live subscription only — no replay, which satisfies "high-water mark initializes to now" on restart.
2. `message_end` with `reason === "end_turn"`: resolve `getThread(sessionId, threadId)`; key must map to a running transport via `channelThreadFor`. Then `getEntries(sessionId, threadId)`, find the entry with `entry.id === messageId` and `role === "assistant"`; skip if already in the in-process delivered set (`${sessionId}:${messageId}`). Deliver: text = `entry.content`; `transport.send(conversationKey, { markdown: text })` when non-empty; then for each `parts` element of `type === "attachment"` whose `attachment.type` is `"image"` or `"file"`, `transport.sendMedia(conversationKey, { type, data, mimeType, name })` (the `ToolAttachment` `"text"` variant is skipped).
3. `decision_gate`: same thread-key check on `gate.threadId`; `transport.sendGatePrompt(conversationKey, { gateId: gate.id, title: gate.title, body: gate.body, actions: gate.actions })` → store `gatePrompts.set(gate.id, ref)` AND `gateRefs.set(`${ref.conversationKey}#${ref.messageId}`, { gateId: gate.id, sessionId })` (this is what Task 6's callback path reads).
4. `decision_gate_resolved`: if `gatePrompts.has(gateId)` → `updateGatePrompt(ref, { actionId: resolution.actionId, label })` where label = `"✅ ${actionLabel}"` for actionId `approve`/primary, `"❌ ${actionLabel}"` for `deny`/danger, else `"☑️ ${actionLabel ?? resolution.value ?? "Resolved"}"`; actionLabel looked up from a `gateActions` map stored at prompt time (`Map<gateId, DecisionAction[]>`). Then delete all three map entries for that gate. Web-resolved gates hit this same path — that's the fan-out the spec requires.
5. Every callback body try/caught; errors logged, never thrown into the stream.

- [ ] **Step 1: Write failing tests**

`packages/api/src/channels/host-outbound.test.ts` — reuse the Task 6 harness + FakeTransport (extend FakeTransport with `gatePrompts: []`, `gateEdits: []`, `media: []` recorders). Scenarios:

```ts
it("delivers a completed assistant message on a channel-keyed thread", async () => {
  // link user; admit a prompt via host.handleUpdate; drive the faux turn to completion
  // (fauxAssistantMessage("orchestrator says hi")); then:
  await vi.waitFor(() => expect(fakeTransport.sent.some((s) => s.message.markdown.includes("orchestrator says hi"))).toBe(true));
});

it("ignores message_end on non-channel threads", async () => {
  // drive a turn on a session whose thread key is web:default → no sends
});

it("does not deliver the same messageId twice", async () => {
  // publish the same message_end BusEvent twice via eventStream.publishEphemeral / append
  // → exactly one send
});

it("gate on a channel thread → sendGatePrompt; resolution → edit", async () => {
  // publish a decision_gate BusEvent whose gate.threadId belongs to a telegram-keyed thread
  // → fakeTransport.gatePrompts has one entry, host.gateForRef(ref) resolves
  // then publish decision_gate_resolved { gateId, resolution: { actionId: "approve", ... } }
  // → fakeTransport.gateEdits[0].resolution.label contains "✅"
});

it("gate_callback round trip resolves the real gate", async () => {
  // full loop: decision_gate event → prompt ref recorded → host.handleUpdate(gate_callback
  // with that ref) → engine gate actually resolved (engineSession.pendingDecisionGates()
  // no longer lists it) → decision_gate_resolved event → message edited
});
```

Write them as real assertions (the comments above describe setup, not placeholders — each test must drive the harness and assert on the fake transport's recorders / `engineStore`). For gate scenarios, the simplest real-gate source is the engine's decision-gate tool path used in `packages/engine/test` — read `packages/engine/test/happy-path.test.ts` and any `decision-gate` engine test for how a faux tool call opens a gate; alternatively append synthetic `BusEvent`s through `eventStream.append` with a gate persisted via the store, which the host treats identically.

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- host-outbound`
Expected: FAIL.

- [ ] **Step 3: Implement outbound delivery in `host.ts`** per the delivery rules.

- [ ] **Step 4: Run tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- channels && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/channels
git commit -m "feat(api): ChannelHost outbound delivery — messages, gate prompts, resolution edits"
```

---

### Task 8: Ingress modes + boot wiring (poll loop, webhook route, providers)

**Files:**
- Modify: `packages/api/src/channels/host.ts` (poll loop, webhook secret, mode selection)
- Create: `packages/api/src/routes/channels.ts`
- Modify: `packages/api/src/providers/types.ts` (+`channelHost: ChannelHost`)
- Modify: `packages/api/src/providers/node.ts` (construct it)
- Modify: `packages/api/src/app.ts` (mount webhook route BEFORE the auth gate)
- Modify: `packages/api/src/main.ts` (start after `restoreUnsettledSessions`, stop in `shutdown`)
- Modify: `packages/api/src/integration/_setup.ts` (construct an inert `ChannelHost` for tests)
- Test: `packages/api/src/channels/host-ingress.test.ts`, plus a route test in `packages/api/src/routes/channels.test.ts` if route files have sibling tests — mirror how existing route tests are placed (check for `packages/api/src/routes/*.test.ts`; if none exist, put route coverage inside `host-ingress.test.ts` using a `createApp` boot).

**Interfaces:**
- Consumes: everything prior.
- Produces:
  - `ChannelHost.start()` now also: chooses mode per transport — webhook when `deps.publicUrl` is set, else long-poll when `transport.poll` exists. Webhook mode: `webhookSecret = randomBytes(24).toString("hex")` (per boot, kept in memory), `await transport.registerWebhook?.(`${publicUrl}/api/channels/${channelType}/webhook`, secret)`. Long-poll mode: spawn `this.runPollLoop(channelType, transport)` (unawaited) with a per-host `AbortController`.
  - `ChannelHost.stop()`: abort the controller, `stopOutbound()`.
  - `publicUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined` — exported pure function: returns `env.VALET_PUBLIC_URL` if set; else `env.BETTER_AUTH_URL` if it parses as a URL with protocol `https:` and hostname not `localhost`/`127.0.0.1`/ending `.localdev`; else `undefined`.
  - Route: `channelsRouter` with `POST /:channelType/webhook` → `providers.channelHost.handleWebhook(...)`; `"ok"` → `c.json({ ok: true })`, `"rejected"` → 403, `"unknown_channel"` → 404. `handleWebhook` verifies via `transport.verifyWebhook(req, { webhookSecret })`, `null` → drop-log `verify_failed` + `"rejected"`; else parse each raw update and `void this.handleUpdate(...)` (fire-and-forget so Telegram gets a fast 200), return `"ok"`.

- [ ] **Step 1: Write failing tests**

`packages/api/src/channels/host-ingress.test.ts`:

```ts
describe("publicUrlFromEnv", () => {
  it("prefers VALET_PUBLIC_URL", () => {
    expect(publicUrlFromEnv({ VALET_PUBLIC_URL: "https://valet.example.com" })).toBe("https://valet.example.com");
  });
  it("falls back to a public BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "https://valet.example.com" })).toBe("https://valet.example.com");
  });
  it("rejects localhost/http BETTER_AUTH_URL", () => {
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "http://localhost:8788" })).toBeUndefined();
    expect(publicUrlFromEnv({ BETTER_AUTH_URL: "https://valet.localdev" })).toBeUndefined();
  });
  it("no vars → undefined (long-poll default)", () => {
    expect(publicUrlFromEnv({})).toBeUndefined();
  });
});

describe("long-poll mode", () => {
  it("start() consumes poll() updates through handleUpdate and stop() halts the loop", async () => {
    // FakeTransport gains: poll = async function* that yields one parsed-able raw update
    // then blocks on a never-resolving promise racing the signal. Assert the update was
    // routed (drop log unlinked_sender row exists), then await host.stop() — resolves.
  });
  it("poller resumes after restart without duplicate admission", async () => {
    // link user; raw update with dispatchId fake:42 → admit; stop host; new ChannelHost
    // over the same stores; same update again → engine dedup: still one queue item.
  });
});

describe("webhook mode", () => {
  it("verify-fail → 403 + verify_failed drop log; verify-pass → 200 + routed", async () => {
    // boot createApp with providers including a host whose publicUrl is set;
    // POST /api/channels/fake/webhook with wrong/right secret header.
  });
  it("unknown channel type → 404", async () => {});
});
```

(Again: the comments describe setup; write the real bodies. For the webhook cases boot the app exactly like `_setup.ts` does — after Step 3 wires `channelHost` into `Providers`, `_setup.ts`'s boot gives you this for free.)

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- host-ingress`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `host.ts`: `publicUrlFromEnv`, `runPollLoop` (for-await over `transport.poll(signal)`; each raw → `parseUpdate` → non-null → `await this.handleUpdate(...)`; loop exits on abort; outer try/catch with 5s sleep + retry so a transport crash never kills the host), webhook secret + `registerWebhook` call, `handleWebhook`.
- `packages/api/src/routes/channels.ts`:

```ts
import { Hono } from "hono";
import type { AppEnv } from "../env.js";

/** PUBLIC ingress — mounted before the auth gate; verification is transport-level. */
export const channelsRouter = new Hono<AppEnv>();

channelsRouter.post("/:channelType/webhook", async (c) => {
  const channelType = c.req.param("channelType");
  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const result = await c.var.providers.channelHost.handleWebhook(channelType, { headers, rawBody });
  if (result === "unknown_channel") return c.json({ error: "unknown channel" }, 404);
  if (result === "rejected") return c.json({ error: "verification failed" }, 403);
  return c.json({ ok: true });
});
```

- `app.ts`: mount `app.route("/api/channels", channelsRouter)` immediately AFTER `providersMiddleware` registration and BEFORE `app.use("/api/*", buildAuthMiddleware(...))` (order in the file is what makes it public — add a comment saying exactly that).
- `providers/types.ts`: add `channelHost: ChannelHost;` with import.
- `providers/node.ts`: construct after `engineHost`:
  ```ts
  const channelHost = new ChannelHost({
    db, engineHost, engineStore, eventStream, engineCredentials,
    plugins, publicUrl: publicUrlFromEnv(process.env),
    resolveOrgId: () => /* the same single-org resolver auth middleware uses — reuse/ export it from its current home rather than duplicating */,
  });
  ```
  If the resolver (`ensureOrg`) is private to `middleware/auth.ts`, move it to `packages/api/src/lib/org.ts` and import from both places (structural fix, no lazy imports).
- `main.ts`: after `providers.childWatcher.rearm()`, add `await providers.channelHost.start();` with a log line; in `shutdown()`, `await providers.channelHost.stop()` before `engineHost.evictAll()`.
- `_setup.ts`: build the host with the test providers and `publicUrl: undefined`, include it in the providers object, and call `start()` only if a test opts in (default: constructed but NOT started — zero transports anyway since tests pass `plugins: []` by default).

- [ ] **Step 4: Run the full api suite**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test && pnpm typecheck`
Expected: PASS except the 2 known `messages.abort.test.ts` failures. No new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): channel ingress — long-poll loop, public webhook route, boot wiring"
```

---

### Task 9: Identity-link REST routes + org-scoped credential paste

**Files:**
- Create: `packages/api/src/routes/identity-links.ts`
- Modify: `packages/api/src/app.ts` (mount at `/api/me/identity-links` BEFORE `/api/me` so the longer prefix wins — verify Hono mount order semantics with a test)
- Modify: `packages/api/src/routes/credentials.ts` (org scope for admins)
- Modify: `packages/api/src/wire/types.ts` (wire types)
- Test: `packages/api/src/routes/identity-links.test.ts` (or colocated per existing route-test convention), extend the existing credentials route test file.

**Interfaces:**
- Consumes: Task 5 service functions; `ChannelHost.botUsername("telegram")` / `isRunning("telegram")`.
- Produces (consumed by the web UI, Task 11) — add to `packages/api/src/wire/types.ts`:
  ```ts
  export interface IdentityLinkStatus {
    provider: string;
    linked: boolean;
    externalId?: string;
    notifyAttention?: boolean;
    createdAt?: number;
    /** Transport availability — false when no bot token is configured. */
    channelReady: boolean;
  }
  export interface StartIdentityLinkResponse { deepLink: string; expiresInSeconds: number }
  ```
- Routes (all authed via the normal gate; user from `requireUser`):
  - `GET /api/me/identity-links` → `{ links: IdentityLinkStatus[] }` (just telegram this pass: one element built from `identityForUser` + `channelHost.isRunning("telegram")`).
  - `POST /api/me/identity-links/telegram/start` → 409 `{ error: "telegram bot not configured" }` when `!channelHost.isRunning("telegram")` or no bot username; else `mintLinkCode` → `{ deepLink: "https://t.me/{botUsername}?start={code}", expiresInSeconds: 600 }`.
  - `PATCH /api/me/identity-links/telegram` body `{ notifyAttention: boolean }` → `setNotifyAttention`; 404 if not linked.
  - `DELETE /api/me/identity-links/telegram` → `unlinkIdentity`, always 200 `{ ok: true }`.
- Credentials org scope (spec decision 11 — an org admin pastes the BotFather token): in `packages/api/src/routes/credentials.ts`, accept optional body field `scope?: "user" | "org"` on `PUT /:service` and query param `?scope=org` on `DELETE /:service` and `GET /`. `scope: "org"` requires `user.role === "admin"` (else 403 `{ error: "org admin required" }` — match the copy used in `routes/org.ts`) and maps owner to `{ type: "org", id: user.orgId }`. `GET /?scope=org` lists org credentials (admin only). Default scope stays `"user"` — existing behavior byte-identical.

- [ ] **Step 1: Write failing route tests** — boot via the `_setup.ts` harness (`bootTestApi`), use its seeded users (`local-user`, `test-admin`, `test-member`) and the `x-valet-test-user-id` impersonation header. Cases:

```
GET /api/me/identity-links            → linked:false, channelReady:false (no transport in test boot)
POST /api/me/identity-links/telegram/start → 409 when transport not running
  (then, with a fake telegram transport registered in the harness host + started:)
POST .../start → 200, deepLink matches /^https:\/\/t\.me\/valet_test_bot\?start=[A-Za-z0-9_-]{20,}$/
  and consuming that code via consumeLinkCode links the caller
PATCH .../telegram {notifyAttention:false} → 200 after linkIdentity; 404 before any link
DELETE .../telegram → 200 and GET shows linked:false
PUT /api/credentials/telegram {type:"bot_token", accessToken:"123:abc", scope:"org"}
  as test-admin → 200 and engineCredentials.get({type:"org",id:orgId},"telegram") returns it
  as test-member → 403 "org admin required"
GET /api/credentials?scope=org as admin → includes telegram; as member → 403
DELETE /api/credentials/telegram?scope=org as admin → 200, credential gone
PUT without scope → still lands user-owned (regression pin)
```

- [ ] **Step 2: Run to verify failure**, implement the router + credentials change + wire types, mount in `app.ts`.

- [ ] **Step 3: Run** `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- "identity-links|credentials" && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): identity-link routes + org-scoped credential paste for channel bots"
```

---

### Task 10: Attention-router Telegram delivery adapter

**Files:**
- Modify: `packages/api/src/orchestrator/attention.ts`
- Modify: `packages/api/src/orchestrator/attention-wiring.ts`
- Modify: `packages/api/src/channels/host.ts` (implement the deliverer)
- Modify: `packages/api/src/main.ts` (pass the deliverer into `wireAttentionRouter`)
- Test: extend `packages/api/src/orchestrator/attention.test.ts` (find the existing test file for attention; if none, create `attention.test.ts` beside the module) + a host-side test in `packages/api/src/channels/host-outbound.test.ts`.

**Interfaces:**
- Produces in `attention.ts`:
  ```ts
  export interface AttentionChannelDeliverer {
    /** Best-effort, per-recipient. Must never throw. */
    deliver(userId: string, event: AttentionEvent): Promise<void>;
  }
  ```
  `AttentionDeps` gains `channels?: AttentionChannelDeliverer[]`; `routeAttention` — after each recipient's web-notification insert (regardless of the web on/off pref, which governs web only) — calls `for (const ch of deps.channels ?? []) void ch.deliver(userId, event)`.
- Produces in `host.ts`: `attentionDeliverer(): AttentionChannelDeliverer` — `deliver(userId, event)`: for each running transport channelType, `identityForUser(db, channelType, userId)`; skip when unlinked or `notifyAttention === false`; else `transport.send(`${channelType}:dm:${link.externalId}`, { markdown })` where markdown is `**${event.title}**` + (`\n\n${event.body}` when present) + (`\n\n[Open in Valet](${absolute href})` when `event.href` present and `deps.publicUrl` set — otherwise omit the link line). Errors swallowed with a `console.error`.
- `attention-wiring.ts`: `AttentionWiringDeps` gains `channels?: AttentionChannelDeliverer[]`, passed through to `routeAttention`. `main.ts`: `wireAttentionRouter({ db, engineStore, eventStream, channels: [providers.channelHost.attentionDeliverer()] })`.

- [ ] **Step 1: Write failing tests**
  - attention side: `routeAttention` with a stub deliverer → called once per recipient with the event; a throwing deliverer does not break notification inserts.
  - host side: linked user with `notifyAttention: true` → one `transport.send` with title in markdown; `notifyAttention: false` → no send; unlinked → no send.
- [ ] **Step 2: Verify failure, implement, re-run**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test -- "attention|channels" && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): attention router delivers to linked Telegram accounts"
```

---

### Task 11: Web UI — Settings → Connected accounts

**Files:**
- Create: `packages/web/src/routes/settings.connected-accounts.tsx`
- Modify: `packages/web/src/api/queries.ts` (hooks) — follow the exact patterns of `useNotificationPreferences` / `useSetNotificationPreference` in that file.
- Modify: the settings nav — `packages/web/src/routes/settings.tsx` (add the section link where `notifications` is listed; mirror it exactly).
- Test: `packages/web/src/routes/-settings.connected-accounts.test.tsx` (mirror `-settings.sections.test.tsx` / `-settings.test.tsx` mocking style — read one first).

**Interfaces:**
- Consumes wire types from Task 9 (`IdentityLinkStatus`, `StartIdentityLinkResponse` via `@valet/api/wire`) and endpoints `GET/POST/PATCH/DELETE /api/me/identity-links[...]`.
- Produces: `/settings/connected-accounts` page.

**Page behavior:**
- Loads `GET /api/me/identity-links`.
- `channelReady === false` → info row: "Telegram isn't configured for this organization yet. An admin can add a bot token under Integrations." (no buttons).
- Not linked (+ready) → "Connect Telegram" button → `POST .../telegram/start` → render the returned `deepLink` as an anchor ("Open Telegram and press Start") + the raw link for copy/paste + "expires in 10 minutes".
- Linked → show `externalId`, linked-since date, a `Switch` for `notifyAttention` (PATCH on toggle, exactly like the notifications page's switch wiring), and a "Disconnect" button (DELETE, then refetch).

- [ ] **Step 1: Write the failing component test** (mirror an existing `-settings.*.test.tsx`: same render helper, same query mocking; cover: unconfigured copy, connect→deep-link render, linked state with toggle + disconnect).
- [ ] **Step 2: Verify failure** — `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && cd packages/web && pnpm test -- connected-accounts` → FAIL.
- [ ] **Step 3: Implement page + hooks + nav entry** using `Section`, `FieldRow`, `Switch`, `Spinner` from the existing settings primitives (import paths identical to `settings.notifications.tsx`).
- [ ] **Step 4: Run** `cd packages/web && pnpm test && pnpm typecheck` — Expected: PASS / clean (root typecheck does NOT cover web; run here).
- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): connected accounts settings — telegram link, notify toggle, disconnect"
```

---

### Task 12: Live e2e (token-gated), spec sync + docs

**Files:**
- Create: `packages/api/src/integration/telegram.e2e.test.ts`
- Modify: `docs/specs/2026-07-15-telegram-channel-design.md` (Status: Draft → Implemented; note any deviations)
- Modify: `docs/specs/integrations.md` (Telegram section: v2 transport supersedes the legacy worker path) and `docs/specs/orchestrator.md` IF its channel-routing section describes this pipeline (check its boundary notes first — update the correct spec only)
- Modify: `CLAUDE.md` ONLY if a durable gotcha emerged during implementation (e.g. a new env var like `VALET_PUBLIC_URL` belongs in the dev-commands notes)

- [ ] **Step 1: Write the token-gated live e2e** — mirror the `describeIfKey` gating pattern from `packages/api/src/integration/orchestrator-restart.test.ts`, gated on BOTH `TELEGRAM_TEST_BOT_TOKEN` and `TELEGRAM_TEST_CHAT_ID` env vars (skip otherwise):
  - Boot the api harness with the real telegram plugin + an org credential holding the token; host in long-poll mode.
  - Send a message via the raw Bot API (`sendMessage` to the test chat as the bot is not possible for inbound — instead this test validates OUTBOUND + linking plumbing): mint a link code for `local-user`, `linkIdentity` directly, then `host.attentionDeliverer().deliver("local-user", { kind: "notification", owner: { type: "user", id: "local-user" }, title: "valet e2e ping", … })` and assert the Bot API accepted the send (no throw). Full inbound requires a human DM — that's the dogfood, not this test.
- [ ] **Step 2: Run everything**

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/plugin-telegram test && pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test
```

Expected: all green except the 2 known `messages.abort` failures.

- [ ] **Step 3: Update the specs** (status flip + any deviations recorded in a "Deviations" subsection), commit:

```bash
git add docs packages/api/src/integration
git commit -m "docs(specs): telegram channel implemented; token-gated live e2e"
```

- [ ] **Step 4: Manual dogfood (exit criteria — human-in-the-loop, record results in the PR/ledger):**
Against a real BotFather bot on `make dev-local` (long-poll, no tunnel): ① paste token as org admin in Integrations (scope org) → restart api → transport starts; ② link via Settings → Connected accounts deep link; ③ DM the bot → orchestrator reply in the same chat; ④ send a photo with caption → orchestrator references it; ⑤ trigger a decision gate from a Telegram-initiated task → inline buttons → resolve → message edits; ⑥ web-started session ends in an attention ping → arrives in Telegram; ⑦ second unlinked account DMs → link-your-account reply + drop-log row; ⑧ restart the api → no duplicate deliveries, poller resumes.

---

## Self-review notes (already applied)

- **Spec coverage:** decisions 1–12 map to tasks: 1→T6 (orchestrator-first, thread key `telegram:{chatId}`), 2→T1/T3, 3→T8, 4→T6 (dedup+drop log), 5→T5/T9 (linking), 6→T6 (routing), 7→T7 (outbound), 8→T6+T7 (gates), 9→T10 (attention), 10→T3/T6/T7 (media; NOTE: engine `PromptContent` already supports attachments — the spec's "if prompt admission lacks attachment parts" contingency is NOT needed; no extra engine change), 11→T4/T9 (credential), 12→T4 (activation). Exit criteria → T12.
- **Deviation from spec, deliberate:** spec decision 8 implies callback_data could carry `{gateId, optionId}` — Telegram's 64-byte callback_data limit makes that impossible for engine gate ids; correlation is by `(chatId, messageId)` ref + host map instead (in-memory state is sanctioned by decision 7). Record this in the spec's Deviations subsection in Task 12.
- **Type consistency:** contract names (`InboundChannelEvent`, `GatePromptRef`, `conversationKey` codec `telegram:dm:{chatId}`, thread key `telegram:{chatId}`, dispatchId `telegram:{update_id}`, callback_data `g|{actionId}`) are used identically across Tasks 1, 3, 6, 7, 8.
- **Known softness (intentional, flagged for implementers):** Task 6/7 test harness setup mirrors `_setup.ts` rather than being reproduced inline — that file is the living source of truth for provider construction and drifts; read it first. Task 9 mount-order for `/api/me/identity-links` vs `/api/me` must be verified by the route test.
