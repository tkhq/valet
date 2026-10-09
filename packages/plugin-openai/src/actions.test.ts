import sharp from "sharp";
import { MAX_IMAGE_BYTES } from "./images.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Credential,
  PluginAction,
  PluginActionContext,
  Sandbox,
} from "@valet/engine";
import { OPENAI_API_URL, openaiPlugin } from "./actions.js";

function getAction(id: string): PluginAction {
  const found = openaiPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action ${id} not registered`);
  return found;
}

/** In-memory sandbox: binary reads/writes against a Map, everything else unused. */
function makeSandbox(files: Map<string, Uint8Array>): Sandbox {
  return {
    id: "sbx-test",
    readFile: async (path) => new TextDecoder().decode(expectFile(files, path)),
    readBinary: async (path) => expectFile(files, path),
    writeFile: async (path, content) => {
      files.set(path, new TextEncoder().encode(content));
    },
    writeBinary: async (path, data) => {
      files.set(path, data);
    },
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

function expectFile(files: Map<string, Uint8Array>, path: string): Uint8Array {
  const data = files.get(path);
  if (!data) throw new Error(`no such file: ${path}`);
  return data;
}

function makeCtx(opts: { credential: Credential | null; files?: Map<string, Uint8Array> }): {
  ctx: PluginActionContext;
  files: Map<string, Uint8Array>;
} {
  const files = opts.files ?? new Map<string, Uint8Array>();
  const ctx: PluginActionContext = {
    actionId: "openai.test",
    service: "openai",
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: {
      get: async () => opts.credential,
      request: async () => {
        throw new Error("not supported in tests");
      },
    },
    sandbox: makeSandbox(files),
    requestDecision: async () => {
      throw new Error("not supported in tests");
    },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async () => {
      throw new Error("not supported in tests");
    },
  };
  return { ctx, files };
}

const PNG_BYTES = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
const PNG_B64 = PNG_BYTES.toString("base64");

const fetchMock = vi.fn<typeof fetch>();

describe("openaiPlugin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(): typeof fetchMock {
    return fetchMock;
  }

  it("gates every action behind requiresCredential", () => {
    expect(openaiPlugin.requiresCredential).toBe(true);
    expect(openaiPlugin.actions.map((a) => a.id).sort()).toEqual([
      "openai.edit_image",
      "openai.generate_image",
      "openai.text_to_speech",
      "openai.transcribe_audio",
    ]);
  });

  it("generate_image saves the PNG and returns an image attachment", async () => {
    mockFetch().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64, revised_prompt: "a red fox" }] }), { status: 200 }),
    );
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    const result = await getAction("openai.generate_image").execute(
      { prompt: "a red fox", output_path: "/workspace/fox.png" },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { path: string; revised_prompt?: string };
    expect(data.path).toBe("/workspace/fox.png");
    expect(data.revised_prompt).toBe("a red fox");
    expect(files.get("/workspace/fox.png")).toEqual(new Uint8Array(PNG_BYTES));
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments?.[0];
    if (attachment?.type !== "image") throw new Error("expected an image attachment");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.data).toEqual(new Uint8Array(PNG_BYTES));
    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_API_URL}/v1/images/generations`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gpt-image-2.5-sunburst", output_format: "png", prompt: "a red fox", size: "auto", quality: "auto" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("generate_image defaults the output path under /workspace/generated-images", async () => {
    mockFetch().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }),
    );
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" } });
    const result = await getAction("openai.generate_image").execute({ prompt: "A Red Fox!" }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as { path: string };
    expect(data.path).toMatch(/^\/workspace\/generated-images\/[a-f0-9-]+-a-red-fox\.png$/);
  });

  it("returns the corrective no-key error when no credential resolves", async () => {
    const { ctx } = makeCtx({ credential: null });
    await expect(
      getAction("openai.generate_image").execute({ prompt: "x" }, ctx),
    ).rejects.toThrow("Add an OpenAI provider in Settings or set OPENAI_API_KEY");
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it("surfaces the OpenAI error message on a failed request", async () => {
    mockFetch().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "billing hard limit reached" } }), { status: 400 }),
    );
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" } });
    const result = await getAction("openai.generate_image").execute({ prompt: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("400");
    expect(result.error).toContain("billing hard limit reached");
  });

  it("edit_image sends the source image as multipart and saves the result", async () => {
    mockFetch().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 }),
    );
    const files = new Map<string, Uint8Array>([["/workspace/in.png", new Uint8Array(PNG_BYTES)]]);
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" }, files });
    const result = await getAction("openai.edit_image").execute(
      { image_path: "/workspace/in.png", prompt: "make it blue", output_path: "/workspace/out.png" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(files.has("/workspace/out.png")).toBe(true);
    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_API_URL}/v1/images/edits`);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2.5-sunburst");
    expect(form.get("prompt")).toBe("make it blue");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("edit_image names the missing source file in its error", async () => {
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(
      getAction("openai.edit_image").execute({ image_path: "/workspace/nope.png", prompt: "x" }, ctx),
    ).rejects.toThrow("Cannot read the image file at /workspace/nope.png");
  });

  it.each(["openai.generate_image", "openai.edit_image"])("%s keeps Responses chat and image models separate", async (id) => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "Here is your image" }] },
      { type: "image_generation_call", status: "completed", result: PNG_B64, revised_prompt: "blue fox" },
    ] })));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" }, files: new Map([["/workspace/in.png", new Uint8Array(PNG_BYTES)]]) });
    const result = await getAction(id).execute({ prompt: "a blue fox", model: "gpt-image-2.5-flare", responses_model: "gpt-5.4-mini",
      ...(id === "openai.edit_image" ? { image_path: "/workspace/in.png" } : {}), output_path: "/workspace/out.png" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ path: "/workspace/out.png", model: "gpt-image-2.5-flare", responses_model: "gpt-5.4-mini", revised_prompt: "blue fox" });
    expect(files.get("/workspace/out.png")).toEqual(new Uint8Array(PNG_BYTES));
    expect(result.attachments?.[0]).toMatchObject({ type: "image", data: files.get("/workspace/out.png"), mimeType: "image/png" });
    const [url, init] = mockFetch().mock.calls[0];
    expect(url).toBe(`${OPENAI_API_URL}/v1/responses`);
    if (!init) throw new Error("missing request");
    const body: unknown = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-5.4-mini", store: false, max_tool_calls: 1, tool_choice: { type: "image_generation" },
      tools: [{ type: "image_generation", model: "gpt-image-2.5-flare", action: id === "openai.edit_image" ? "edit" : "generate", output_format: "png", quality: "auto" }] });
    expect(body).toMatchObject({ input: [{ content: expect.arrayContaining([{ type: "input_text", text: "a blue fox" }]) }] });
    if (id === "openai.edit_image") expect(body).toMatchObject({ input: [{ content: expect.arrayContaining([{ type: "input_image", image_url: `data:image/png;base64,${PNG_B64}`, detail: "auto" }]) }] });
    expect(init.signal).toBe(ctx.signal);
  });

  it.each(["openai.generate_image", "openai.edit_image"])("%s accepts an explicit direct image model", async (id) => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })));
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" }, files: new Map([["/workspace/in.png", new Uint8Array(PNG_BYTES)]]) });
    const result = await getAction(id).execute({ prompt: "fox", model: "gpt-image-2.5-flare", quality: "max",
      ...(id === "openai.edit_image" ? { image_path: "/workspace/in.png" } : {}) }, ctx);
    expect(result.success).toBe(true);
    const init = mockFetch().mock.calls[0][1];
    if (init?.body instanceof FormData) {
      expect(init.body.get("model")).toBe("gpt-image-2.5-flare");
      expect(init.body.get("quality")).toBe("max");
    } else expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-image-2.5-flare", quality: "max" });
  });

  it.each(["png", "jpeg", "webp"] as const)("saves %s with equivalent attachment bytes and matching MIME/extension", async (format) => {
    const bytes = await sharp(PNG_BYTES).toFormat(format).toBuffer();
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] })));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    const result = await getAction("openai.generate_image").execute({ prompt: "fox", output_format: format,
      ...(format === "png" ? {} : { output_compression: 50 }) }, ctx);
    expect(result.success).toBe(true);
    const path = [...files.keys()][0];
    expect(path.endsWith(format === "jpeg" ? ".jpg" : `.${format}`)).toBe(true);
    expect(files.get(path)).toEqual(new Uint8Array(bytes));
    expect(result.attachments?.[0]).toMatchObject({ mimeType: `image/${format}`, data: files.get(path) });
  });

  it.each([
    { model: "gpt-5.5" }, { responses_model: "claude-sonnet-5-5" }, { model: "gpt-image-1", quality: "max" },
    { background: "transparent", output_format: "jpeg" }, { output_compression: 50 }, { output_format: "gif" },
    { output_format: "webp", output_compression: 101 }, { size: "unbounded" }, { output_path: "/workspace/fox.jpg" },
    { output_path: "/etc/fox.png" }, { output_path: "../fox.png" }, { output_path: "/workspace/../fox.png" }, { prompt: " " },
  ])("rejects invalid options before a paid request: %j", async (params) => {
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(getAction("openai.generate_image").execute({ prompt: "fox", ...params }, ctx)).rejects.toThrow();
    expect(mockFetch()).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it.each([
    null, {}, { data: [{ b64_json: null }] }, { data: [{ b64_json: "garbage" }] },
    { data: [{ b64_json: "aGVsbG8=" }] }, { data: [{ b64_json: PNG_B64.slice(0, 24) }] },
    { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] },
  ])("rejects missing/malformed Images output without saving: %j", async (body) => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify(body)));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow();
    expect(files.size).toBe(0);
  });

  it.each([
    { status: "failed", output: [] }, { status: "incomplete", output: [] }, { status: "completed", output: [] },
    { status: "completed", output: [{ type: "image_generation_call", status: "failed", result: PNG_B64 }] },
    { status: "completed", output: [{ type: "image_generation_call", status: "completed", result: null }] },
  ])("rejects incomplete or null Responses output: %j", async (body) => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify(body)));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(getAction("openai.generate_image").execute({ prompt: "fox", responses_model: "gpt-5.5" }, ctx)).rejects.toThrow();
    expect(files.size).toBe(0);
  });

  it("rejects a mismatched returned format and malformed JSON", async () => {
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    mockFetch().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox", output_format: "jpeg" }, ctx)).rejects.toThrow("wrong format");
    mockFetch().mockResolvedValueOnce(new Response("not-json"));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("malformed");
    expect(files.size).toBe(0);
  });

  it("bounds response bytes before parsing and decoded bytes before saving", async () => {
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    mockFetch().mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "100000000" } }));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("oversized");
    const b64 = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
    mockFetch().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: b64 }] })));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("20 MB");
    expect(files.size).toBe(0);
  });

  it("never reports success when the sandbox write fails", async () => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })));
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" } });
    ctx.sandbox.writeBinary = async () => { throw new Error("disk full"); };
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("Use a writable file path");
  });

  it("propagates abort before fetching and before writing", async () => {
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    const abort = new AbortController();
    ctx.signal = abort.signal;
    abort.abort();
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch()).not.toHaveBeenCalled();
    const during = new AbortController();
    ctx.signal = during.signal;
    mockFetch().mockImplementation(async () => { during.abort(); return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] })); });
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(files.size).toBe(0);
  });

  it("redacts credentials from provider errors and retains HTTP status for non-JSON errors", async () => {
    const { ctx } = makeCtx({ credential: { accessToken: "fixture-private-key" } });
    mockFetch().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid key fixture-private-key sk-test-secret" } }), { status: 401 }));
    const error = await getAction("openai.generate_image").execute({ prompt: "fox" }, ctx);
    expect(error.success).toBe(false);
    expect(error.error).toContain("401");
    expect(error.error).not.toContain("fixture-private-key");
    expect(error.error).not.toContain("sk-test-secret");
    mockFetch().mockResolvedValueOnce(new Response("Gateway failure", { status: 502 }));
    expect(await getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).toMatchObject({ success: false, error: expect.stringContaining("502") });
  });

  it("rejects conflicting Responses output-format metadata", async () => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output: [{ type: "image_generation_call", status: "completed", result: PNG_B64, output_format: "jpeg" }] })));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(getAction("openai.generate_image").execute({ prompt: "fox", responses_model: "gpt-5.5" }, ctx)).rejects.toThrow("unexpected output format");
    expect(files.size).toBe(0);
  });

  it("rejects invalid or oversized edit inputs before reading or spending credits", async () => {
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" }, files: new Map([["/workspace/in.png", new Uint8Array([1, 2, 3])]]) });
    await expect(getAction("openai.edit_image").execute({ image_path: "/workspace/in.png", prompt: "fox" }, ctx)).rejects.toThrow("malformed");
    const read = vi.spyOn(ctx.sandbox, "readBinary");
    ctx.sandbox.stat = async () => ({ isFile: true, isDirectory: false, size: MAX_IMAGE_BYTES + 1 });
    await expect(getAction("openai.edit_image").execute({ image_path: "/workspace/in.png", prompt: "fox" }, ctx)).rejects.toThrow("20 MB");
    expect(read).not.toHaveBeenCalled();
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it("bounds unknown-length response bodies and rejects oversized decoded dimensions", async () => {
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    mockFetch().mockResolvedValueOnce(new Response(new Uint8Array(30 * 1024 * 1024)));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("oversized");
    const large = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: "red" } }).png().toBuffer();
    mockFetch().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: large.toString("base64") }] })));
    await expect(getAction("openai.generate_image").execute({ prompt: "fox" }, ctx)).rejects.toThrow("too large to decode");
    expect(files.size).toBe(0);
  });

  it("transcribe_audio returns the transcript text", async () => {
    mockFetch().mockResolvedValue(new Response(JSON.stringify({ text: "hello world" }), { status: 200 }));
    const files = new Map<string, Uint8Array>([["/workspace/a.mp3", new TextEncoder().encode("audio")]]);
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" }, files });
    const result = await getAction("openai.transcribe_audio").execute(
      { audio_path: "/workspace/a.mp3", language: "en" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ text: "hello world" });
    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_API_URL}/v1/audio/transcriptions`);
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("en");
  });

  it("text_to_speech writes the audio file and reports the path", async () => {
    mockFetch().mockResolvedValue(new Response(new TextEncoder().encode("mp3-bytes"), { status: 200 }));
    const { ctx, files } = makeCtx({ credential: { accessToken: "sk-test" } });
    const result = await getAction("openai.text_to_speech").execute(
      { text: "Hello there", voice: "nova", output_path: "/workspace/hi.mp3" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ path: "/workspace/hi.mp3", bytes: 9 });
    expect(new TextDecoder().decode(files.get("/workspace/hi.mp3"))).toBe("mp3-bytes");
    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_API_URL}/v1/audio/speech`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", input: "Hello there", voice: "nova", response_format: "mp3" });
  });
});
