import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { executeImage, imageParameters } from "./images.js";

/**
 * Base URL is a module-level seam so tests can point actions at a mock
 * server without patching global fetch's URL handling. Production always
 * uses the real API host.
 */
export const OPENAI_API_URL = "https://api.openai.com";

const NO_KEY_MESSAGE =
  "No OpenAI API key is configured. Add an OpenAI provider in Settings or set OPENAI_API_KEY.";

/**
 * Curried action builder, same idiom as plugin-github's `action()` — the
 * first call binds T from the parameters schema so `execute`'s args stay
 * fully typed in long files.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

async function getApiKey(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  const key = cred?.accessToken;
  if (!key) throw new Error(NO_KEY_MESSAGE);
  return key;
}

/** First 40 chars of the prompt as a filesystem-safe slug, "media" when empty. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "media";
}

function defaultPath(dir: string, prompt: string, ext: string): string {
  return `/workspace/${dir}/${Date.now()}-${slugify(prompt)}.${ext}`;
}

/** Read the OpenAI error body's message when present; fall back to status. */
async function apiError(verb: string, res: Response): Promise<PluginActionResult> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = ` ${body.error.message}`;
  } catch {
    // Non-JSON error body — the status line is all we can report.
  }
  return {
    success: false,
    error: `${verb} failed: OpenAI returned ${res.status}.${detail} Check the request parameters and the configured OpenAI API key.`,
  };
}

async function readSandboxFile(
  ctx: PluginActionContext,
  path: string,
  kind: string,
): Promise<Uint8Array> {
  try {
    return await ctx.sandbox.readBinary(path);
  } catch {
    throw new Error(`Cannot read the ${kind} file at ${path}. Check that the path exists in the sandbox.`);
  }
}

async function writeSandboxFile(ctx: PluginActionContext, path: string, data: Uint8Array): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await ctx.sandbox.mkdir(dir);
  await ctx.sandbox.writeBinary(path, data);
}

const generateImage = action(Type.Object(imageParameters))({
  id: "openai.generate_image",
  name: "Generate Image",
  description: "Generate an image with a selectable OpenAI image model, save it in the sandbox, and show it inline. Set responses_model to use a supported chat model through Responses.",
  riskLevel: "low",
  execute: async (args, ctx) => executeImage(args, ctx, await getApiKey(ctx), OPENAI_API_URL),
});

const editImage = action(Type.Object({
  ...imageParameters,
  image_path: Type.String({ description: "Sandbox path of the source PNG, JPEG, or WebP image to edit." }),
}))({
  id: "openai.edit_image",
  name: "Edit Image",
  description: "Edit a sandbox image with a selectable OpenAI image model, save the result, and show it inline. Set responses_model to use a supported chat model through Responses.",
  riskLevel: "low",
  execute: async (args, ctx) => executeImage(args, ctx, await getApiKey(ctx), OPENAI_API_URL),
});

const transcribeAudio = action(
  Type.Object({
    audio_path: Type.String({ description: "Sandbox path of the audio file (mp3, mp4, wav, webm, m4a, flac, or ogg)." }),
    language: Type.Optional(
      Type.String({ description: "ISO-639-1 language hint, e.g. \"en\". Omit for auto-detection." }),
    ),
  }),
)({
  id: "openai.transcribe_audio",
  name: "Transcribe Audio",
  description: "Transcribe a sandbox audio file to text with OpenAI gpt-4o-transcribe.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const key = await getApiKey(ctx);
    const audio = await readSandboxFile(ctx, args.audio_path, "audio");
    const form = new FormData();
    form.append("model", "gpt-4o-transcribe");
    if (args.language) form.append("language", args.language);
    form.append(
      "file",
      new Blob([audio as BlobPart]),
      args.audio_path.slice(args.audio_path.lastIndexOf("/") + 1),
    );
    const res = await fetch(`${OPENAI_API_URL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: ctx.signal,
    });
    if (!res.ok) return apiError("Transcription", res);
    const body = (await res.json()) as { text?: string };
    return { success: true, data: { text: body.text ?? "" } };
  },
});

const VOICES = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"] as const;

const textToSpeech = action(
  Type.Object({
    text: Type.String({ description: "The text to speak." }),
    voice: Type.Optional(
      Type.Union(
        VOICES.map((v) => Type.Literal(v)),
        { description: 'Voice name. Default "alloy".' },
      ),
    ),
    format: Type.Optional(
      Type.Union([Type.Literal("mp3"), Type.Literal("wav"), Type.Literal("opus"), Type.Literal("flac")], {
        description: 'Audio container. Default "mp3".',
      }),
    ),
    output_path: Type.Optional(
      Type.String({ description: "Sandbox path for the audio file. Default /workspace/generated-audio/<timestamp>-<slug>.<format>" }),
    ),
  }),
)({
  id: "openai.text_to_speech",
  name: "Text to Speech",
  description: "Render text to spoken audio with OpenAI gpt-4o-mini-tts and save the file in the sandbox.",
  riskLevel: "low",
  execute: async (args, ctx) => {
    const key = await getApiKey(ctx);
    const format = args.format ?? "mp3";
    const res = await fetch(`${OPENAI_API_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: args.text,
        voice: args.voice ?? "alloy",
        response_format: format,
      }),
      signal: ctx.signal,
    });
    if (!res.ok) return apiError("Speech synthesis", res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const outputPath = args.output_path ?? defaultPath("generated-audio", args.text, format);
    await writeSandboxFile(ctx, outputPath, bytes);
    return { success: true, data: { path: outputPath, bytes: bytes.byteLength } };
  },
});

export const openaiPlugin: ActionPlugin = {
  service: "openai",
  description: "OpenAI media tools: image generation and editing, audio transcription, text to speech.",
  // Statically-listed actions — without this flag list_tools would advertise
  // the tools even when no OpenAI key resolves. The api's credential resolver
  // answers the "openai" probe: org LLM-provider key → stored credential →
  // OPENAI_API_KEY env.
  requiresCredential: true,
  actions: [generateImage, editImage, transcribeAudio, textToSpeech],
};
