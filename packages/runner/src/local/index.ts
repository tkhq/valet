/**
 * Local LLM inference module
 */

export {
  createLocalSession,
  streamCompletion,
  cleanupSession,
  type LocalSession,
} from "./inference.js";

export {
  MODEL_REGISTRY,
  getModelsDir,
  resolveModelPath,
  listModels,
  removeModel,
  pullModel,
  type ModelInfo,
} from "./models.js";
