/**
 * Local LLM inference using node-llama-cpp.
 * Handles model loading and streaming generation.
 */

export interface LocalSession {
  context: any;
  modelPath: string;
}

/**
 * Create a local inference session by loading a model.
 * @param modelPath Full path to the GGUF model file
 * @returns A session object with the context
 */
export async function createLocalSession(modelPath: string): Promise<LocalSession> {
  // Dynamically import node-llama-cpp to avoid loading when not needed
  const { Llama } = await import("node-llama-cpp");

  console.log(`Loading model: ${modelPath}`);

  // Load the model and create a context
  const llama = new Llama({
    model: modelPath,
    n_gpu_layers: 0, // CPU-only inference (no GPU)
    n_threads: 4, // Use 4 threads
  });

  const context = llama.createContext();

  return {
    context,
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
  // Default inference parameters
  const maxTokens = 256; // Reduced for faster response
  const temperature = 0.7;
  const topP = 0.9;

  try {
    // Encode the prompt
    const promptTokens = session.context.encode(prompt);

    // Generate completions with streaming
    // node-llama-cpp context.evaluate returns token IDs
    let totalTokens = 0;
    let currentOutput = "";

    // Evaluate the prompt first
    await session.context.evaluate(promptTokens);

    // Then generate new tokens
    while (totalTokens < maxTokens) {
      // Sample the next token
      const token = session.context.sample({
        temperature,
        topP,
      });

      // Check for end-of-sequence
      if (token === 0) break; // EOS token

      // Evaluate this token and get its text
      const tokenText = session.context.decode([token]);
      currentOutput += tokenText;

      yield tokenText;
      totalTokens++;

      // Stop on double newline
      if (currentOutput.endsWith("\n\n")) {
        break;
      }
    }
  } catch (err) {
    console.error("Error during generation:", err);
    throw err;
  }
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
