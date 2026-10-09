import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type sharpType from "sharp";
import { Type, type Static } from "typebox";
import { readResponseBytes, type PluginActionContext, type PluginActionResult } from "@valet/engine";

declare global {
  var __VALET_SHARP__: typeof sharpType | undefined;
}

// Verified against the OpenAI image guide and model pages on 2026-10-09.
const IMAGE_MODELS = [
  "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini",
] as const;
const RESPONSES_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"] as const;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
const MAX_IMAGE_PIXELS = 4096 * 4096;
const FORMATS = { png: { mime: "image/png", ext: "png" }, jpeg: { mime: "image/jpeg", ext: "jpg" }, webp: { mime: "image/webp", ext: "webp" } };

export const imageParameters = {
  prompt: Type.String({ minLength: 1, description: "What to draw or change. Be specific about style, subject, and composition." }),
  model: Type.Optional(Type.Union(IMAGE_MODELS.map((model) => Type.Literal(model)), {
    description: "Image model, separate from the chat model. Default gpt-image-2.5-sunburst for precision; choose gpt-image-2.5-flare for speed.",
  })),
  responses_model: Type.Optional(Type.Union(RESPONSES_MODELS.map((model) => Type.Literal(model)), {
    description: "Optional mainline OpenAI chat model for the Responses image_generation tool. Does not change the session chat model. Omit to use the Images API.",
  })),
  size: Type.Optional(Type.Union([Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536"), Type.Literal("auto")], { description: 'Output size. Default "auto".' })),
  quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"), Type.Literal("auto")], { description: 'Quality. Default "auto". xhigh and max require a GPT Image 2.5 model.' })),
  output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { description: 'File format. Default "png".' })),
  background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
  output_compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Compression, 0-100. Only valid for JPEG or WebP." })),
  output_path: Type.Optional(Type.String({ description: "File path inside /workspace. Extension must match output_format. Default /workspace/generated-images/<unique-id>-<slug>.<ext>." })),
};
const imageSchema = Type.Object(imageParameters);
type ImageArgs = Static<typeof imageSchema> & { image_path?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxPath(path: string): string {
  const normalized = posix.resolve("/workspace", path);
  if (!path || /[\x00-\x1f\x7f]/.test(path) || !normalized.startsWith("/workspace/")) {
    throw new Error("Invalid image path. Use a file inside /workspace.");
  }
  return normalized;
}

function validateArgs(args: ImageArgs) {
  const model = args.model ?? "gpt-image-2.5-sunburst";
  const format = args.output_format ?? "png";
  if (!IMAGE_MODELS.includes(model) || (args.responses_model && !RESPONSES_MODELS.includes(args.responses_model))) {
    throw new Error("Unsupported image or Responses model. Choose a model listed in the tool parameters.");
  }
  if (!Object.hasOwn(FORMATS, format) || !["low", "medium", "high", "xhigh", "max", "auto"].includes(args.quality ?? "auto") ||
    !["1024x1024", "1536x1024", "1024x1536", "auto"].includes(args.size ?? "auto") ||
    !["transparent", "opaque", "auto"].includes(args.background ?? "auto")) {
    throw new Error("Unsupported image options. Choose values listed in the tool parameters.");
  }
  if (!model.startsWith("gpt-image-2.5-") && ["xhigh", "max"].includes(args.quality ?? "auto")) {
    throw new Error("This quality requires GPT Image 2.5. Choose Sunburst or Flare, or use quality high or lower.");
  }
  if (args.background === "transparent" && format === "jpeg") {
    throw new Error("JPEG does not support transparency. Use PNG or WebP, or choose an opaque background.");
  }
  if (args.output_compression !== undefined && (format === "png" || !Number.isInteger(args.output_compression) || args.output_compression < 0 || args.output_compression > 100)) {
    throw new Error("Invalid output compression. Use a value from 0 to 100 with JPEG or WebP.");
  }
  if (!args.prompt.trim()) throw new Error("The image prompt is empty. Describe the image or edit to make.");
  const slug = args.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "image";
  const path = sandboxPath(args.output_path ?? `/workspace/generated-images/${randomUUID()}-${slug}.${FORMATS[format].ext}`);
  const ext = posix.extname(path).toLowerCase();
  if (!(format === "jpeg" ? [".jpg", ".jpeg"] : [`.${format}`]).includes(ext)) {
    throw new Error(`The output filename does not match ${format}. Use a matching extension or change output_format.`);
  }
  return { model, format, path, options: {
    model, size: args.size ?? "auto", quality: args.quality ?? "auto", output_format: format,
    ...(args.background === undefined ? {} : { background: args.background }),
    ...(args.output_compression === undefined ? {} : { output_compression: args.output_compression }),
  } };
}

async function validateImage(bytes: Uint8Array, expectedFormat?: string): Promise<string> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("The image is empty or exceeds 20 MB. Use a smaller image or request a smaller output.");
  }
  try {
    const sharp = globalThis.__VALET_SHARP__ ?? (await import("sharp")).default;
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !Object.hasOwn(FORMATS, metadata.format) || (expectedFormat && metadata.format !== expectedFormat) ||
      !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Invalid image");
    // Decode all pixels, not just the header. Keep the original encoded bytes for the saved file and attachment.
    await image.stats();
    return metadata.format;
  } catch {
    throw new Error("The image is malformed, too large to decode, or has the wrong format. Use a valid PNG, JPEG, or WebP image. If it exceeds 16,777,216 pixels, resize it.");
  }
}

/** Keep the original file, but bound the preview replayed to the session model. */
async function imageAttachment(bytes: Uint8Array, format: "png" | "jpeg" | "webp"): Promise<Uint8Array> {
  if (bytes.byteLength <= MAX_ATTACHMENT_BYTES) return bytes;
  const sharp = globalThis.__VALET_SHARP__ ?? (await import("sharp")).default;
  const preview = new Uint8Array(await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS })
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .toFormat(format).toBuffer());
  if (!preview.length || preview.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("Cannot create an image preview smaller than 5 MB. Request a smaller image.");
  }
  return preview;
}

async function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  const body = await readResponseBytes(res, MAX_RESPONSE_BYTES, signal);
  if (!body.ok) throw new Error("OpenAI returned an oversized image response. Request a smaller output.");
  try { return JSON.parse(new TextDecoder().decode(body.data)); }
  catch {
    if (!res.ok) return undefined;
    throw new Error("OpenAI returned malformed image data. Retry the request with a simpler prompt.");
  }
}

function returnedImage(body: unknown, responses: boolean) {
  if (!record(body)) throw new Error("OpenAI returned no image data. Retry with a simpler prompt.");
  let item: unknown;
  if (responses) {
    const calls = Array.isArray(body.output) ? body.output.filter((output: unknown) => record(output) && output.type === "image_generation_call") : [];
    if (body.status !== "completed" || calls.length !== 1 || !record(calls[0]) || calls[0].status !== "completed") {
      throw new Error("OpenAI did not complete one image generation call. Retry with a simpler prompt.");
    }
    item = calls[0];
  } else {
    if (!Array.isArray(body.data) || body.data.length !== 1) throw new Error("OpenAI returned no single image. Retry with a simpler prompt.");
    item = body.data[0];
  }
  const b64 = record(item) ? item[responses ? "result" : "b64_json"] : undefined;
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("OpenAI returned missing, malformed, or oversized image data. Retry with a smaller output.");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (Buffer.from(bytes).toString("base64") !== b64) throw new Error("OpenAI returned invalid base64 image data. Retry the request.");
  return { bytes, outputFormat: record(item) ? item.output_format : undefined, revisedPrompt: record(item) && typeof item.revised_prompt === "string" ? item.revised_prompt : undefined };
}

/** Both APIs finish through the same sandbox write and attachment contract. */
export async function executeImage(args: ImageArgs, ctx: PluginActionContext, key: string, apiUrl: string): Promise<PluginActionResult> {
  ctx.signal.throwIfAborted();
  const { model, format, path, options } = validateArgs(args);
  let source: Uint8Array | undefined;
  let sourceFormat: string | undefined;
  let sourcePath: string | undefined;
  if (args.image_path !== undefined) {
    sourcePath = sandboxPath(args.image_path);
    try {
      const stat = await ctx.sandbox.stat(sourcePath);
      if (!stat.isFile || stat.size > MAX_IMAGE_BYTES) throw new Error("Invalid source");
      source = await ctx.sandbox.readBinary(sourcePath);
    } catch {
      ctx.signal.throwIfAborted();
      throw new Error(`Cannot read the image file at ${sourcePath}. Use an existing sandbox file smaller than 20 MB.`);
    }
    sourceFormat = await validateImage(source);
  }
  ctx.signal.throwIfAborted();
  let body: string | FormData;
  let endpoint: string;
  if (args.responses_model) {
    endpoint = "/v1/responses";
    body = JSON.stringify({
      model: args.responses_model, store: false, max_tool_calls: 1,
      input: [{ role: "user", content: [
        { type: "input_text", text: args.prompt },
        ...(source ? [{ type: "input_image", image_url: `data:image/${sourceFormat};base64,${Buffer.from(source).toString("base64")}`, detail: "auto" }] : []),
      ] }],
      tools: [{ type: "image_generation", ...options, action: source ? "edit" : "generate" }],
      tool_choice: { type: "image_generation" },
    });
  } else if (source && sourcePath) {
    endpoint = "/v1/images/edits";
    const form = new FormData();
    for (const [name, value] of Object.entries(options)) form.append(name, String(value));
    form.append("prompt", args.prompt);
    // Copy to an ArrayBuffer-backed view accepted by the DOM Blob types.
    form.append("image", new Blob([new Uint8Array(source)], { type: `image/${sourceFormat}` }), posix.basename(sourcePath));
    body = form;
  } else {
    endpoint = "/v1/images/generations";
    body = JSON.stringify({ ...options, prompt: args.prompt, n: 1 });
  }
  const res = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
    body, signal: ctx.signal,
  });
  const json = await readJson(res, ctx.signal);
  if (!res.ok) {
    const detail = record(json) && record(json.error) && typeof json.error.message === "string"
      ? json.error.message.replaceAll(key, "[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 600) : "";
    return { success: false, error: `Image request failed: OpenAI returned ${res.status}. ${detail} Check the parameters, model access, and OpenAI billing.` };
  }
  const { bytes, outputFormat, revisedPrompt } = returnedImage(json, !!args.responses_model);
  if (outputFormat !== undefined && outputFormat !== null && outputFormat !== format) {
    throw new Error("OpenAI returned an unexpected output format. Retry with the requested PNG, JPEG, or WebP format.");
  }
  await validateImage(bytes, format);
  const attachment = await imageAttachment(bytes, format);
  ctx.signal.throwIfAborted();
  try {
    await ctx.sandbox.mkdir(posix.dirname(path));
    ctx.signal.throwIfAborted();
    await ctx.sandbox.writeBinary(path, bytes);
  } catch {
    ctx.signal.throwIfAborted();
    throw new Error(`Cannot save the image at ${path}. Use a writable file path inside /workspace.`);
  }
  ctx.signal.throwIfAborted();
  return {
    success: true,
    data: { path, bytes: bytes.byteLength, mimeType: FORMATS[format].mime, model,
      ...(args.responses_model ? { responses_model: args.responses_model } : {}),
      ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) },
    attachments: [{ type: "image", data: attachment, mimeType: FORMATS[format].mime, name: posix.basename(path) }],
  };
}
