/**
 * Local LLM inference using node-llama-cpp.
 * Handles model loading and streaming generation.
 */

import { getLlama, LlamaChatSession } from "node-llama-cpp";

export interface LocalSession {
  context: any;
  session: LlamaChatSession;
  modelPath: string;
}

/**
 * Create a local inference session by loading a model.
 * @param modelPath Full path to the GGUF model file
 * @returns A session object with the context
 */
export async function createLocalSession(modelPath: string): Promise<LocalSession> {
  console.log(`Loading model: ${modelPath}`);

  // Load the model using node-llama-cpp v3 API
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

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
 * @returns The full generated text
 */
export async function streamCompletionRealtime(
  modelPath: string,
  prompt: string,
  onToken: (token: string) => void
): Promise<string> {
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });

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
