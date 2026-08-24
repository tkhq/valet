/**
 * Local LLM inference using node-llama-cpp.
 * Handles model loading and streaming generation.
 */

import { getLlama, LlamaChatSession } from "node-llama-cpp";

/**
 * Options for local inference, including GPU configuration.
 */
export interface LocalInferenceOptions {
  gpu?: "auto" | "metal" | "cuda" | "vulkan" | false;
  gpuLayers?: "auto" | "max" | number;
}

export interface LocalSession {
  context: any;
  session: LlamaChatSession;
  modelPath: string;
}

/**
 * Create a local inference session by loading a model.
 * @param modelPath Full path to the GGUF model file
 * @param options GPU and inference options (default: auto GPU detection)
 * @returns A session object with the context
 */
export async function createLocalSession(
  modelPath: string,
  options: LocalInferenceOptions = {}
): Promise<LocalSession> {
  console.log(`Loading model: ${modelPath}`);

  // Load the model using node-llama-cpp v3 API
  // gpu: "auto" enables automatic GPU detection (Metal on macOS, CUDA on Linux/Windows)
  const llama = await getLlama({ gpu: options.gpu ?? "auto" });
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: options.gpuLayers ?? "auto"
  });
  const context = await model.createContext();
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

  // Log which GPU backend is active
  const gpuBackend = (llama as any).gpu ? (llama as any).gpu : "CPU";
  console.log(`Loaded model on ${gpuBackend}`);

  return {
    context,
    session,
    modelPath,
  };
}

/**
 * Stream completion tokens for a prompt.
 * Yields tokens as they are generated.
 * @param session The local session
 * @param prompt The input prompt
 * @yields Generated tokens
 */
export async function* streamCompletion(
  session: LocalSession,
  prompt: string,
): AsyncGenerator<string> {
  try {
    let full = "";
    await session.session.prompt(prompt, {
      onTextChunk: (chunk: string) => {
        full += chunk;
      }
    });
    yield full;
  } catch (err) {
    console.error("Error during generation:", err);
    throw err;
  }
}

/**
 * Stream completion tokens in realtime, calling a callback for each token.
 * @param modelPath Full path to the GGUF model file
 * @param prompt The input prompt
 * @param onToken Callback invoked for each token generated
 * @param options GPU and inference options (default: auto GPU detection)
 * @returns The full generated text
 */
export async function streamCompletionRealtime(
  modelPath: string,
  prompt: string,
  onToken: (token: string) => void,
  options: LocalInferenceOptions = {}
): Promise<string> {
  // gpu: "auto" enables automatic GPU detection (Metal on macOS, CUDA on Linux/Windows)
  const llama = await getLlama({ gpu: options.gpu ?? "auto" });
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: options.gpuLayers ?? "auto"
  });
  const context = await model.createContext();
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

  // Log which GPU backend is active
  const gpuBackend = (llama as any).gpu ? (llama as any).gpu : "CPU";
  console.log(`Loaded model on ${gpuBackend}`);

  let full = "";
  await session.prompt(prompt, {
    onTextChunk: (chunk: string) => {
      full += chunk;
      onToken(chunk);
    },
  });
  return full;
}

/**
 * Cleanup a session and release resources.
 * @param session The session to cleanup
 */
export async function cleanupSession(session: LocalSession): Promise<void> {
  try {
    if (session.context && typeof session.context.dispose === "function") {
      session.context.dispose();
    }
  } catch (err) {
    console.warn("Error during session cleanup:", err);
  }
}
