import type { ValetPlugin } from "@valet/engine";
import { openaiPlugin } from "./actions.js";

/**
 * No `credentials` declaration on purpose: the OpenAI key is not a
 * user-connectable integration. The api's session credential resolver
 * answers `credentials.get("openai")` from the org's OpenAI LLM-provider
 * key, a stored "openai" credential, or the OPENAI_API_KEY env var.
 */
const plugin: ValetPlugin = {
  name: "openai",
  version: "0.1.0",
  description: "OpenAI media tools — image generation and editing, transcription, text to speech",
  actions: [openaiPlugin],
};

export default plugin;
