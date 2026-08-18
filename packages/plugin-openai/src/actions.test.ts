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

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

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
    expect(new TextDecoder().decode(files.get("/workspace/fox.png"))).toBe("fake-png-bytes");
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments?.[0];
    if (attachment?.type !== "image") throw new Error("expected an image attachment");
    expect(attachment.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(attachment.data)).toBe("fake-png-bytes");
    const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_API_URL}/v1/images/generations`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "gpt-image-1", prompt: "a red fox", size: "auto", quality: "auto" });
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
    expect(data.path).toMatch(/^\/workspace\/generated-images\/\d+-a-red-fox\.png$/);
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
    const files = new Map<string, Uint8Array>([["/workspace/in.png", new TextEncoder().encode("src")]]);
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
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("prompt")).toBe("make it blue");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });

  it("edit_image names the missing source file in its error", async () => {
    const { ctx } = makeCtx({ credential: { accessToken: "sk-test" } });
    await expect(
      getAction("openai.edit_image").execute({ image_path: "/workspace/nope.png", prompt: "x" }, ctx),
    ).rejects.toThrow("Cannot read the image file at /workspace/nope.png");
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
