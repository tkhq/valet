import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { ELIDED_TOOL_OUTPUT } from "./compaction.js";
import { supportsNativeImageGeneration } from "./model-catalog.js";
import { decodeImageBase64, imageAttachment, imageDecoder, validateImage, IMAGE_FORMATS, MAX_IMAGE_BYTES } from "./image-output.js";
import type { Sandbox, ToolDef, ToolResult } from "./types.js";

export const NATIVE_IMAGE_RESULT_TOOL = "openai_native_image";
/** The plugin action native generation replaces. Its availability and policy decide whether the hosted tool is offered. */
export const NATIVE_IMAGE_PLUGIN_ACTION = "openai.generate_image";
/** The hosted tool also edits images in context, so this action's policy must allow too. */
export const NATIVE_IMAGE_EDIT_ACTION = "openai.edit_image";
/** The hosted tool's fixed parameters. Policy sees them as the plugin action's params. */
export const NATIVE_IMAGE_TOOL_PARAMS = { model: "gpt-image-2.5-sunburst", output_format: "png", quality: "auto" } as const;
const NATIVE_PATH = /^generated-images\/[a-f0-9-]+\.(png|jpg|webp)$/;
const IMAGE_INSTRUCTIONS = "Use native image_generation to generate images and edit images already in context. Images are saved automatically and receipts return their paths. For an existing sandbox image not in context, use openai.edit_image. Do not call plugin image generation.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only request-time image-tool access/availability errors qualify, not auth, quota, or stream errors. */
function imageToolRejected(message: string): boolean {
  return /^OpenAI API error \((?:400|403|404|422)\):/.test(message)
    && /image[_ -]generation|gpt-image-[\w.-]+/i.test(message)
    && /not[_ ](?:supported|available|found)|unsupported|unavailable|does not (?:exist|support)|access|permission|scope|model_not_found|must (?:be verified|verify)/i.test(message)
    && !/invalid[_ -]?(?:api[_ -]?key)|authentication[_ -]?error|insufficient[_ -]?quota|rate[_ -]?limit/i.test(message);
}

/** Text of a replayed receipt output, whether pi serialized it as a string or as content parts. Image parts are skipped. */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  const texts: string[] = [];
  for (const part of output) {
    if (record(part) && part.type === "input_text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("");
}

/** The context a saved original leaves when its receipt result cannot carry it. */
function savedNote(paths: string[], detail: string): string {
  return `Image originals saved at ${paths.join(", ")}. ${detail} Use these files; do not regenerate them. To change one, use openai.edit_image on that file.`;
}

/** Receipt paths in an assistant message, from the receipt tool-call arguments. */
function receiptPathsOf(message: Message): string[] {
  if (message.role !== "assistant") return [];
  const paths: string[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall" && block.name === NATIVE_IMAGE_RESULT_TOOL && typeof block.arguments.path === "string") paths.push(block.arguments.path);
  }
  return paths;
}

/** The message an error carries when the provider threw before it streamed anything. */
function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: "error", timestamp: Date.now() };
}

/** What the thread supplies for a hosted request. A boolean stands in for tests. */
export interface HostedImageHooks {
  /** The turn's policy check. False or a throw withholds the hosted tool for the turn. */
  permitted: () => Promise<boolean>;
  /**
   * Called once per saved original, right after its write and before the
   * stream continues. `callId` is the receipt tool call the message will carry,
   * so the thread can persist a checkpoint that survives a crash before the
   * terminal stream event.
   */
  saved?: (receipt: { path: string; image_id: string; callId: string }) => void | Promise<void>;
}

/** One thread owns this bridge. The engine stores its results through ordinary tool persistence. */
export class NativeImageBridge {
  private saved = new Map<string, ToolResult>();
  private unavailable = false;
  private withheld = false;
  /** The turn's policy-and-sandbox check, made once. */
  private ready: boolean | undefined;
  savedInRequest = false;
  /** True while the most recent request offered the hosted tool, so duplicate plugin actions hide only then. */
  offered = false;

  beginTurn(): void {
    this.savedInRequest = false;
    this.unavailable = false;
    this.withheld = false;
    this.ready = undefined;
    this.offered = false;
  }

  /** False after a request-time rejection, a policy denial, or an unready sandbox in this turn, so the plugin action stays visible. */
  enabled(model: Model<Api>): boolean {
    return !this.unavailable && !this.withheld && supportsNativeImageGeneration(model);
  }

  /** Policy first, then the sandbox. A cold sandbox must be ready before a paid request, as the fallback's directory prep is. */
  private async prepare(hosted: boolean | HostedImageHooks, sandbox: Sandbox): Promise<boolean> {
    const permitted = typeof hosted === "boolean" ? hosted : await hosted.permitted().catch(() => false);
    if (!permitted) return false;
    try {
      await sandbox.mkdir("generated-images");
      return true;
    } catch {
      return false;
    }
  }

  tool(): ToolDef {
    return {
      name: NATIVE_IMAGE_RESULT_TOOL,
      description: "Internal receipt for an image generated by the session model. Never call this tool yourself.",
      parameters: Type.Object({ path: Type.String(), image_id: Type.String() }),
      // Prunable: the sandbox file is the durable record, and replay restores the path when the preview is elided.
      execute: async (args, ctx) => {
        ctx.signal.throwIfAborted();
        if (!record(args) || typeof args.path !== "string" || !NATIVE_PATH.test(args.path) || typeof args.image_id !== "string") {
          throw new Error("Invalid native image receipt. Request the image again.");
        }
        const key = `${args.image_id}:${args.path}`;
        const saved = this.saved.get(key);
        if (saved) { this.saved.delete(key); return saved; }
        // An interrupted turn can replay its receipt after restart. Never regenerate or pay again.
        const stat = await ctx.sandbox.stat(args.path);
        if (!stat.isFile || stat.size > MAX_IMAGE_BYTES) throw new Error("The saved native image is unavailable. Request it again.");
        const bytes = await ctx.sandbox.readBinary(args.path);
        return this.result(bytes, args.path, args.image_id, ctx.signal);
      },
    };
  }

  private receipt(bytes: Uint8Array, path: string, id: string, format: string, warning?: string): ToolResult {
    return { text: JSON.stringify({ path, bytes: bytes.byteLength, mimeType: `image/${format}`, image_id: id, model: "gpt-image-2.5-sunburst", ...(warning ? { warning } : {}) }) };
  }

  private async result(bytes: Uint8Array, path: string, id: string, signal?: AbortSignal): Promise<ToolResult> {
    const sharp = await imageDecoder();
    const format = await validateImage(bytes, sharp);
    if (format !== "png" && format !== "jpeg" && format !== "webp") throw new Error("Unsupported image format. Request PNG, JPEG, or WebP.");
    if (path.slice(path.lastIndexOf(".")) !== `.${IMAGE_FORMATS[format].ext}`) throw new Error("The saved image format differs from its filename. Request the image again.");
    const result = this.receipt(bytes, path, id, format);
    try {
      const preview = await imageAttachment(bytes, format, sharp);
      signal?.throwIfAborted();
      return { ...result, attachments: [{ type: "image", data: preview, mimeType: IMAGE_FORMATS[format].mime, name: path.slice(path.lastIndexOf("/") + 1) }] };
    } catch {
      signal?.throwIfAborted();
      return this.receipt(bytes, path, id, format, "Image saved without a preview. Use the saved original; do not regenerate it.");
    }
  }

  stream(model: Model<Api>, context: { messages: Message[] }, options: SimpleStreamOptions, sandbox: Sandbox, hosted: boolean | HostedImageHooks = true) {
    this.saved.clear();
    this.savedInRequest = false;
    // Pi preserves rs_* signatures but drops their following hosted image item. The image guide
    // permits edits from image context alone. Omit this turn's reasoning, not unrelated reasoning.
    const orphanedReasoning = new Set<string>();
    const receiptCalls = new Set<string>();
    const unpairedItemIds = new Set<string>();
    const unpairedCalls = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "assistant" || !message.content.some((block) => block.type === "toolCall" && block.name === NATIVE_IMAGE_RESULT_TOOL)) continue;
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === NATIVE_IMAGE_RESULT_TOOL) receiptCalls.add(block.id.split("|")[0]);
        if (block.type !== "thinking" || !block.thinkingSignature) continue;
        const signature: unknown = JSON.parse(block.thinkingSignature);
        if (record(signature) && signature.type === "reasoning" && typeof signature.id === "string") orphanedReasoning.add(signature.id);
      }
    }
    const output = createAssistantMessageEventStream();
    const receipts: Array<{ path: string; image_id: string; callId: string }> = [];
    const receiptCall = (receipt: { path: string; image_id: string; callId: string }) =>
      ({ type: "toolCall" as const, id: receipt.callId, name: NATIVE_IMAGE_RESULT_TOOL, arguments: { path: receipt.path, image_id: receipt.image_id } });
    const seen = new Map<string, string>();
    // Function calls the provider marked completed with parseable arguments, by call_id.
    // Pi also ends an incomplete item, so only the provider's status counts.
    const completeCalls = new Set<string>();
    let partial: AssistantMessage | undefined;
    const deliver = (message: AssistantMessage, cutOff?: string) => {
      // Once originals exist, a failed or cut-off stream becomes receipts, not a retryable assistant error.
      if (cutOff !== undefined) {
        this.unavailable = true;
        // Only calls that finished streaming may run. A truncated call must never execute.
        message.content = message.content.filter((block) => block.type !== "toolCall" || completeCalls.has(block.id.split("|")[0]));
        const warning = `The image stream ended early (${cutOff}) after saving this original. Use saved originals; do not regenerate them.`;
        for (const receipt of receipts) {
          const key = `${receipt.image_id}:${receipt.path}`;
          const result = this.saved.get(key);
          if (result) this.saved.set(key, { ...result, text: JSON.stringify({ ...JSON.parse(result.text), stream_warning: warning }) });
        }
      }
      delete message.errorMessage;
      // Tools run in content order. Receipts go before any other call, so a stop or a
      // restart during a slow or gated call cannot leave a saved original unrecorded.
      const firstCall = message.content.findIndex((block) => block.type === "toolCall");
      let contentIndex = firstCall === -1 ? message.content.length : firstCall;
      for (const receipt of receipts) {
        const toolCall = receiptCall(receipt);
        message.content.splice(contentIndex, 0, toolCall);
        output.push({ type: "toolcall_start", contentIndex, partial: message });
        output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        contentIndex++;
      }
      message.stopReason = "toolUse";
      output.push({ type: "done", reason: "toolUse", message });
    };
    // An aborted message persists its text and tool calls, not its error. Pi drops aborted
    // messages from later requests, so the receipt calls here let `request` re-inject the paths.
    const abortWithSaved = (message: AssistantMessage) => {
      const note = savedNote(receipts.map((receipt) => receipt.path), "The turn was aborted.");
      message.content.push({ type: "text", text: note });
      for (const receipt of receipts) {
        const toolCall = receiptCall(receipt);
        const contentIndex = message.content.length;
        message.content.push(toolCall);
        output.push({ type: "toolcall_start", contentIndex, partial: message });
        output.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
      }
      output.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: note } });
    };
    const capture = async (item: unknown) => {
      if (!record(item) || item.type !== "image_generation_call") return;
      if (item.status !== "completed" || typeof item.id !== "string" || !item.id || item.id.length > 200) {
        throw new Error("OpenAI did not complete the image. Request it again with a simpler prompt.");
      }
      const bytes = decodeImageBase64(item.result);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (seen.has(item.id)) {
        if (seen.get(item.id) !== hash) throw new Error("OpenAI returned conflicting image results. Request the image again.");
        return;
      }
      const sharp = await imageDecoder();
      const format = await validateImage(bytes, sharp);
      if (format !== "png" && format !== "jpeg" && format !== "webp") throw new Error("Unsupported image format. Request PNG, JPEG, or WebP.");
      if (item.output_format != null && item.output_format !== format) throw new Error("OpenAI returned a mismatched image format. Request the image again.");
      const path = `generated-images/${crypto.randomUUID()}.${IMAGE_FORMATS[format].ext}`;
      options.signal?.throwIfAborted();
      try {
        await sandbox.mkdir("generated-images");
        options.signal?.throwIfAborted();
        await sandbox.writeBinary(path, bytes);
      } catch { options.signal?.throwIfAborted(); throw new Error("Cannot save the generated image. Check the sandbox storage and request it again."); }
      // Register the original immediately. Preview work or a later abort cannot erase its receipt.
      this.savedInRequest = true;
      const receipt = { path, image_id: item.id, callId: `call_${crypto.randomUUID().replaceAll("-", "")}` };
      receipts.push(receipt);
      if (typeof hosted !== "boolean") await hosted.saved?.(receipt);
      seen.set(item.id, hash);
      const key = `${item.id}:${path}`;
      this.saved.set(key, this.receipt(bytes, path, item.id, format, "Image saved. Use the saved original; do not regenerate it."));
      this.saved.set(key, await this.result(bytes, path, item.id, options.signal));
    };
    const request = (native: boolean) => {
      let instructed = false;
      const transcript: { messages: Message[] } = { messages: context.messages.flatMap((message, messageIndex): Message[] => {
        // Pi drops an aborted or errored assistant message. Its saved originals must still reach the model.
        if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
          const paths = receiptPathsOf(message);
          return paths.length ? [message, { role: "user", content: savedNote(paths, "That turn was interrupted after saving them."), timestamp: message.timestamp }] : [message];
        }
        return [mapped(message, messageIndex)];
      }) };
      let started = false;
      function mapped(message: Message, messageIndex: number): Message {
        if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.name === NATIVE_IMAGE_RESULT_TOOL)) {
          // Temporary IDs identify exactly this message's paired items after pi's conversion.
          // The payload hook removes them with the missing hosted item's reasoning.
          return { ...message, content: message.content.map((block, blockIndex) => {
            if (block.type !== "text" && block.type !== "toolCall") return block;
            if (block.type === "toolCall") {
              // Match pi's call_id normalization without changing tool/result pairing.
              unpairedCalls.add(block.id.split("|")[0].replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, ""));
              return block;
            }
            const id = `msg_valet_replay_${messageIndex}_${blockIndex}`;
            unpairedItemIds.add(id);
            const signature: unknown = block.textSignature?.startsWith("{") ? JSON.parse(block.textSignature) : undefined;
            return { ...block, textSignature: JSON.stringify({ ...(record(signature) ? signature : {}), v: 1, id }) };
          }) };
        }
        if (message.role !== "system") return message;
        const hidden = (name: string) => name === NATIVE_IMAGE_RESULT_TOOL || (native && name === "openai__generate_image");
        const addInstruction = native && !instructed;
        instructed = true;
        return { ...message, toolsAdded: message.toolsAdded?.filter((tool) => !hidden(tool.name)), toolsRemoved: message.toolsRemoved?.filter((tool) => !hidden(tool.name)),
          ...(addInstruction ? { sections: { ...message.sections, "valet-native-images": IMAGE_INSTRUCTIONS } } : {}) };
      }
      const upstream = streamSimple(model, transcript, {
        ...options,
        onResponse: async (response, requestModel) => {
          started = true;
          await options.onResponse?.(response, requestModel);
        },
        onPayload: async (payload, requestModel) => {
          const transformed = (await options.onPayload?.(payload, requestModel)) ?? payload;
          if (!record(transformed)) throw new Error("Invalid Responses payload. Restart this turn.");
          // Receipt paths, keyed by call_id. A pruned receipt output replays the path alone.
          const receiptPaths = new Map<string, string>();
          const replay = receiptCalls.size && Array.isArray(transformed.input)
            ? { ...transformed, input: transformed.input.flatMap((item): unknown[] => {
              if (!record(item)) return [item];
              if (item.type === "reasoning" && typeof item.id === "string" && orphanedReasoning.has(item.id)) return [];
              // Internal receipts are not provider function calls. Replay their text/vision as user context.
              if (item.type === "function_call" && item.name === NATIVE_IMAGE_RESULT_TOOL) {
                const args: unknown = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
                if (typeof item.call_id === "string" && record(args) && typeof args.path === "string") receiptPaths.set(item.call_id, args.path);
                return [];
              }
              if (item.type === "function_call_output" && typeof item.call_id === "string" && receiptCalls.has(item.call_id)) {
                // A pruned, interrupted, or errored receipt result loses its path. The call arguments keep it.
                const path = receiptPaths.get(item.call_id);
                const text = outputText(item.output);
                if (path && !(text ?? "").includes(path)) {
                  const detail = text === ELIDED_TOOL_OUTPUT ? "Its preview was removed to save context." : "Its receipt did not complete.";
                  return [{ role: "user", content: [{ type: "input_text", text: savedNote([path], detail) }] }];
                }
                return [{ role: "user", content: Array.isArray(item.output) ? item.output : [{ type: "input_text", text: item.output }] }];
              }
              if ((typeof item.id === "string" && unpairedItemIds.has(item.id))
                || ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string" && unpairedCalls.has(item.call_id))) {
                const { id: _id, ...unpaired } = item;
                return [unpaired];
              }
              return [item];
            }) }
            : transformed;
          if (!native) return replay;
          await imageDecoder();
          return { ...replay, tools: [...(Array.isArray(transformed.tools) ? transformed.tools : []),
            { type: "image_generation", ...NATIVE_IMAGE_TOOL_PARAMS }] };
        },
        onProviderStreamEvent: async (event, requestModel) => {
          await options.onProviderStreamEvent?.(event, requestModel);
          if (!native || !record(event)) return;
          if (event.type === "response.output_item.done") {
            const item = event.item;
            if (record(item) && item.type === "function_call" && item.status === "completed" && typeof item.call_id === "string") {
              try { JSON.parse(String(item.arguments)); completeCalls.add(item.call_id); } catch { /* truncated arguments never run */ }
            }
            await capture(item);
          }
          if (event.type === "response.completed" && record(event.response) && Array.isArray(event.response.output)) {
            for (const item of event.response.output) await capture(item);
          }
        },
      });
      return { upstream, started: () => started };
    };
    void (async () => {
      try {
        let native = this.enabled(model);
        if (native) {
          this.ready ??= await this.prepare(hosted, sandbox);
          if (!this.ready) { this.withheld = true; native = false; }
        }
        let current = request(native);
        for (;;) {
          this.offered = native;
          let retryWithoutImages = false;
          for await (const event of current.upstream) {
            if ("partial" in event) partial = event.partial;
            if (event.type === "error") partial = event.error;
            if (event.type === "error" && native && !current.started() && !options.signal?.aborted && !receipts.length && imageToolRejected(event.error.errorMessage ?? "")) {
              this.unavailable = true;
              retryWithoutImages = true;
              break;
            }
            if ((event.type === "done" || event.type === "error") && receipts.length) {
              const message = event.type === "done" ? event.message : event.error;
              if (options.signal?.aborted) abortWithSaved(message);
              else if (event.type === "error") deliver(message, (message.errorMessage ?? "stream error").slice(0, 300));
              else deliver(message, message.stopReason === "toolUse" || message.stopReason === "stop" ? undefined : message.stopReason);
            } else output.push(event);
          }
          if (!retryWithoutImages) {
            // Some providers end with a final result without emitting a terminal event.
            output.end(await current.upstream.result());
            break;
          }
          native = false;
          current = request(false);
        }
      } catch (error) {
        if (partial && receipts.length && !options.signal?.aborted) deliver(partial, (error instanceof Error ? error.message : "image delivery failed").slice(0, 300));
        else if (partial && receipts.length) abortWithSaved(partial);
        else {
          // A throw before the first event (provider setup, a missing key) must still end
          // the stream with a message, or the agent loop waits forever.
          const reason = options.signal?.aborted ? "aborted" : "error";
          const message = partial ?? emptyAssistantMessage(model);
          output.push({ type: "error", reason, error: { ...message, stopReason: reason,
            errorMessage: error instanceof Error ? error.message : "The model request failed. Retry the turn." } });
        }
      } finally {
        output.end();
        seen.clear();
      }
    })();
    return output;
  }
}
