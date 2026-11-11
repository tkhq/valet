/**
 * Model image limits (docs/specs/2026-11-11-model-image-limits-design.md):
 * Valet downscales oversized attachments before it stores them, a request
 * never carries an image over a hard provider limit, and an image a provider
 * rejects does not fail every later turn of the thread.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  correctImageBlocks,
  Engine,
  entriesToAgentMessages,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type MessageEntry,
} from "../src/index.js";
import {
  fitImageAttachments,
  IMAGE_REJECTED_KEY,
  imageDimensions,
  isImageRejection,
  MODEL_IMAGE_MAX_EDGE,
  MODEL_IMAGE_MAX_PIXELS,
  REJECTED_IMAGE_TEXT,
} from "../src/image-limits.js";

const OPENAI_PATCH_ERROR =
  "OpenAI API error (400): The image you provided requires 86450 patches after processing, exceeding the limit of 30000";

async function solid(width: number, height: number, format: "png" | "jpeg" | "webp" | "gif" = "png"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).toFormat(format).toBuffer();
}

function dataUrl(bytes: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

type Block = { type: string; data?: string; text?: string; mimeType?: string };

/** Every image block in the messages a provider received. */
function imageBlocks(messages: unknown): Block[] {
  const out: Block[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (rec.type === "image" && typeof rec.data === "string") out.push(rec as Block);
      Object.values(rec).forEach(visit);
    }
  };
  visit(messages);
  return out;
}

function containsText(messages: unknown, needle: string): boolean {
  return JSON.stringify(messages).includes(JSON.stringify(needle).slice(1, -1));
}

function makeEngine() {
  const store = new InMemorySessionStore();
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  return { engine, store };
}

describe("imageDimensions", () => {
  it("reads the size from PNG, JPEG, GIF, and WebP headers", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
      expect(imageDimensions(await solid(321, 123, format)), format).toEqual({ width: 321, height: 123 });
    }
  });

  it("returns undefined for bytes that are not an image", () => {
    expect(imageDimensions(Buffer.from("not an image at all, just text"))).toBeUndefined();
  });
});

describe("isImageRejection", () => {
  it("matches provider image rejections and nothing else", () => {
    expect(isImageRejection(OPENAI_PATCH_ERROR)).toBe(true);
    expect(isImageRejection("messages.0.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels")).toBe(true);
    expect(isImageRejection("Could not process image")).toBe(true);
    expect(isImageRejection("overloaded_error: Overloaded")).toBe(false);
    expect(isImageRejection("prompt is too long: 250000 tokens > 200000 maximum")).toBe(false);
    expect(isImageRejection(undefined)).toBe(false);
  });
});

describe("correctImageBlocks size guard", () => {
  it("replaces a tall image under 5 MB that exceeds the provider patch limit", async () => {
    // 1000 x 40000 px: 40,000 OpenAI patches and a 40000 px side.
    const tall = await solid(1000, 40_000);
    expect(tall.byteLength).toBeLessThan(5 * 1024 * 1024);
    const [message] = correctImageBlocks([{ role: "user", content: [{ type: "image", data: tall.toString("base64"), mimeType: "image/png" }] }]);
    expect(message.content).toEqual([{ type: "text", text: expect.stringContaining("1000x40000 px is larger than model providers accept") }]);
  });

  it("keeps an image that fits the provider limits", async () => {
    const ok = (await solid(3000, 2000)).toString("base64");
    const messages = [{ role: "user", content: [{ type: "image", data: ok, mimeType: "image/png" }] }];
    expect(correctImageBlocks(messages)).toEqual(messages);
  });
});

describe("fitImageAttachments", () => {
  it("downscales a wide image to the model limits and keeps its aspect ratio", async () => {
    const [att] = (await fitImageAttachments([{ type: "image", url: dataUrl(await solid(12_000, 600)), mimeType: "image/png", name: "wide.png" }]))!;
    if (att.type !== "image" || !att.url) throw new Error("expected an image");
    const size = imageDimensions(Buffer.from(att.url.split(",")[1], "base64"));
    expect(size).toEqual({ width: MODEL_IMAGE_MAX_EDGE, height: 100 });
    expect(att).toMatchObject({ mimeType: "image/png", name: "wide.png" });
  });

  it("keeps JPEG as JPEG and bounds the total pixels", async () => {
    const [att] = (await fitImageAttachments([{ type: "image", data: await solid(1990, 1990, "jpeg"), mimeType: "image/jpeg" }]))!;
    if (att.type !== "image" || !att.data) throw new Error("expected image bytes");
    const size = imageDimensions(att.data)!;
    expect(att.mimeType).toBe("image/jpeg");
    expect(size.width * size.height).toBeLessThanOrEqual(MODEL_IMAGE_MAX_PIXELS);
  });

  it("leaves an image that fits, and non-image media, unchanged", async () => {
    const small = { type: "image" as const, url: dataUrl(await solid(800, 600)), mimeType: "image/png" };
    const audio = { type: "image" as const, url: "data:audio/ogg;base64,AQID", mimeType: "audio/ogg" };
    expect(await fitImageAttachments([small, audio])).toEqual([small, audio]);
  });

  it("sends the original when the decoder cannot load", async () => {
    const big = [{ type: "image" as const, url: dataUrl(await solid(5000, 100)), mimeType: "image/png" }];
    expect(await fitImageAttachments(big, () => Promise.reject(new Error("no sharp")))).toBe(big);
  });
});

describe("thread image limits", () => {
  let faux: ReturnType<typeof registerFauxProvider>;
  beforeEach(() => { faux = registerFauxProvider({ provider: "image-limits" }); });
  afterEach(() => { faux.unregister(); });

  async function newThread() {
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel() });
    return { store, session, thread: await session.ensureDefaultThread() };
  }

  it("stores and sends a downscaled copy of a tall pasted image", async () => {
    const received: unknown[] = [];
    faux.setResponses([(context) => { received.push(structuredClone(context.messages)); return fauxAssistantMessage("seen"); }]);
    const { store, session, thread } = await newThread();
    const tall = await solid(800, 30_000);
    expect(tall.byteLength).toBeLessThan(5 * 1024 * 1024);
    const r = await thread.submitPrompt({ text: "What is this?", attachments: [{ type: "image", url: dataUrl(tall), mimeType: "image/png", name: "tall.png" }] }, {});
    await thread.awaitResult(r.queueItemId);

    const [sent] = imageBlocks(received[0]);
    expect(imageDimensions(Buffer.from(sent.data!, "base64"))).toEqual({ width: 53, height: MODEL_IMAGE_MAX_EDGE });
    const user = (await store.getEntries(session.id, thread.id)).find((e): e is MessageEntry => e.type === "message" && e.role === "user");
    const stored = user?.attachments?.[0];
    expect(stored?.type === "image" && stored.url).toBe(`data:image/png;base64,${sent.data}`);
  });

  it("continues without images after a provider rejects one, and later turns do not resend it", async () => {
    const received: unknown[] = [];
    const capture = (reply: string) => (context: { messages: unknown }) => { received.push(structuredClone(context.messages)); return fauxAssistantMessage(reply); };
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: OPENAI_PATCH_ERROR }),
      capture("I cannot see the image"),
      capture("second turn"),
    ]);
    const { store, session, thread } = await newThread();
    const r1 = await thread.submitPrompt({ text: "Look", attachments: [{ type: "image", url: dataUrl(await solid(64, 64)), mimeType: "image/png" }] }, {});
    await thread.awaitResult(r1.queueItemId);
    const r2 = await thread.submitPrompt("And now?", {});
    await thread.awaitResult(r2.queueItemId);

    expect(received).toHaveLength(2);
    for (const messages of received) {
      expect(imageBlocks(messages)).toEqual([]);
      expect(containsText(messages, REJECTED_IMAGE_TEXT)).toBe(true);
    }
    const entries = await store.getEntries(session.id, thread.id);
    const user = entries.find((e): e is MessageEntry => e.type === "message" && e.role === "user");
    expect(user?.metadata?.[IMAGE_REJECTED_KEY]).toBe(true);
    // The user's message keeps its image for display.
    expect(user?.attachments).toHaveLength(1);
  });

  it("drops images up to a rejected turn on reload, and keeps later ones", async () => {
    const png = dataUrl(await solid(64, 64));
    const base = { sessionId: "s", threadId: "t", type: "message" as const, createdAt: 1 };
    const entries: MessageEntry[] = [
      { ...base, id: "u1", parentId: null, role: "user", content: "first", attachments: [{ type: "image", url: png, mimeType: "image/png" }], metadata: { [IMAGE_REJECTED_KEY]: true } },
      { ...base, id: "a1", parentId: "u1", role: "assistant", content: "no image" },
      { ...base, id: "u2", parentId: "a1", role: "user", content: "second", attachments: [{ type: "image", url: png, mimeType: "image/png" }] },
    ];
    const messages = entriesToAgentMessages(entries, faux.getModel());
    expect(imageBlocks(messages.slice(0, 2))).toEqual([]);
    expect(containsText(messages[0], REJECTED_IMAGE_TEXT)).toBe(true);
    expect(imageBlocks(messages[2])).toHaveLength(1);
  });
});
