import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { readResponseBytes, imageDecoder, validateImage, imageAttachment, decodeImageBase64, IMAGE_FORMATS as FORMATS, MAX_IMAGE_BYTES, type PluginActionContext, type PluginActionResult } from "@valet/engine";

// Verified against the OpenAI image guide and model pages on 2026-10-09.
const IMAGE_MODELS = [
  "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst-2026-09-08", "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2", "gpt-image-2-2026-04-21", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini",
] as const;
export { MAX_IMAGE_BYTES } from "@valet/engine";
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024;

export const imageParameters = {
  prompt: Type.String({ minLength: 1, description: "What to draw or change. Be specific about style, subject, and composition." }),
  // Schema defaults are applied before policy resolution, so a policy scoped to the default value applies to an omitted field.
  model: Type.Optional(Type.Union(IMAGE_MODELS.map((model) => Type.Literal(model)), {
    default: "gpt-image-2.5-sunburst",
    description: "Image model, separate from the chat model. Default gpt-image-2.5-sunburst for precision; choose gpt-image-2.5-flare for speed.",
  })),
  size: Type.Optional(Type.Union([Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536"), Type.Literal("auto")], { default: "auto", description: 'Output size. Default "auto".' })),
  quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"), Type.Literal("auto")], { default: "auto", description: 'Quality. Default "auto". xhigh and max require a GPT Image 2.5 model.' })),
  output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { default: "png", description: 'File format. Default "png".' })),
  background: Type.Optional(Type.Union([Type.Literal("transparent"), Type.Literal("opaque"), Type.Literal("auto")])),
  output_compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Compression, 0-100. Only valid for JPEG or WebP." })),
  output_path: Type.Optional(Type.String({ description: "File path in the sandbox working directory. Absolute container paths must be inside /workspace. Extension must match output_format. Default generated-images/<unique-id>-<slug>.<ext>." })),
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
  return posix.isAbsolute(path) ? normalized : posix.relative("/workspace", normalized);
}

function validateArgs(args: ImageArgs) {
  const model = args.model ?? "gpt-image-2.5-sunburst";
  const format = args.output_format ?? "png";
  if (!IMAGE_MODELS.includes(model)) {
    throw new Error("Unsupported image model. Choose a model listed in the tool parameters.");
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
  const path = sandboxPath(args.output_path ?? `generated-images/${randomUUID()}-${slug}.${FORMATS[format].ext}`);
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

async function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  const body = await readResponseBytes(res, res.ok ? MAX_RESPONSE_BYTES : 64 * 1024, signal);
  if (!body.ok) {
    if (!res.ok) return undefined;
    throw new Error("OpenAI returned an oversized image response. Request a smaller output.");
  }
  try { return JSON.parse(new TextDecoder().decode(body.data)); }
  catch {
    if (!res.ok) return undefined;
    throw new Error("OpenAI returned malformed image data. Retry the request with a simpler prompt.");
  }
}

function returnedImage(body: unknown) {
  if (!record(body) || !Array.isArray(body.data) || body.data.length !== 1 || !record(body.data[0])) {
    throw new Error("OpenAI returned no single image. Retry with a simpler prompt.");
  }
  const item = body.data[0];
  return { bytes: decodeImageBase64(item.b64_json), outputFormat: item.output_format,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined };
}

/**
 * Direct Images API fallback for models without native image generation.
 * The action identity selects the operation: only `edit` reads a source image,
 * so a stray `image_path` cannot turn a generation into an edit under the
 * generation action's policy.
 */
export async function executeImage(args: ImageArgs, ctx: PluginActionContext, key: string, apiUrl: string, operation: "generate" | "edit"): Promise<PluginActionResult> {
  ctx.signal.throwIfAborted();
  if (operation === "generate" && args.image_path !== undefined) {
    return { success: false, error: "openai.generate_image does not edit files. Use openai.edit_image with image_path to edit an existing image." };
  }
  const { model, format, path, options } = validateArgs(args);
  const sharp = await imageDecoder();
  let source: Uint8Array | undefined;
  let sourceFormat: string | undefined;
  let sourcePath: string | undefined;
  if (operation === "edit") {
    if (args.image_path === undefined) return { success: false, error: "openai.edit_image needs image_path. Give the sandbox path of the image to edit." };
    sourcePath = sandboxPath(args.image_path);
    try {
      const stat = await ctx.sandbox.stat(sourcePath);
      if (!stat.isFile || stat.size > MAX_IMAGE_BYTES) throw new Error("Invalid source");
      source = await ctx.sandbox.readBinary(sourcePath);
    } catch (cause) {
      ctx.signal.throwIfAborted();
      const reason = cause instanceof Error ? cause.message.replaceAll(key, "[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "Sandbox read failed";
      throw new Error(`Cannot read the image file at ${sourcePath}: ${reason}. Use an existing sandbox file smaller than 20 MB.`);
    }
    sourceFormat = await validateImage(source, sharp);
  }
  ctx.signal.throwIfAborted();
  let body: string | FormData;
  let endpoint: string;
  if (source && sourcePath) {
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
  // Fail before spending credits if this invocation has no usable sandbox.
  await ctx.sandbox.mkdir(posix.dirname(path));
  ctx.signal.throwIfAborted();
  const res = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
    body, signal: ctx.signal,
  });
  let json: unknown;
  try { json = await readJson(res, ctx.signal); }
  catch (error) {
    ctx.signal.throwIfAborted();
    if (res.ok) throw error;
  }
  if (!res.ok) {
    const detail = record(json) && record(json.error) && typeof json.error.message === "string"
      ? json.error.message.replaceAll(key, "[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 600) : "";
    return { success: false, error: `Image request failed: OpenAI returned ${res.status}. ${detail} Check the parameters, model access, and OpenAI billing.` };
  }
  const { bytes, outputFormat, revisedPrompt } = returnedImage(json);
  if (outputFormat !== undefined && outputFormat !== null && outputFormat !== format) {
    throw new Error("OpenAI returned an unexpected output format. Retry with the requested PNG, JPEG, or WebP format.");
  }
  await validateImage(bytes, sharp, format);
  ctx.signal.throwIfAborted();
  // Save the paid original before any preview work. Nothing after this write may discard its path.
  try {
    await ctx.sandbox.writeBinary(path, bytes);
  } catch (cause) {
    ctx.signal.throwIfAborted();
    const reason = cause instanceof Error ? cause.message.replaceAll(key, "[redacted]").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "Sandbox write failed";
    throw new Error(`Cannot save the image at ${path}: ${reason}. Use a writable file path inside /workspace.`);
  }
  const data = { path, bytes: bytes.byteLength, mimeType: FORMATS[format].mime, model,
    ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) };
  // A post-write abort or preview failure still returns the saved path, so the agent never regenerates.
  if (ctx.signal.aborted) {
    return { success: true, data: { ...data, warning: "The turn was aborted after the image was saved. Use the saved original; do not regenerate it." } };
  }
  let attachment: Uint8Array;
  try {
    attachment = await imageAttachment(bytes, format, sharp);
  } catch {
    return { success: true, data: { ...data, warning: "Image saved without a preview. Use the saved original; do not regenerate it." } };
  }
  return {
    success: true,
    data,
    attachments: [{ type: "image", data: attachment, mimeType: FORMATS[format].mime, name: posix.basename(path) }],
  };
}
