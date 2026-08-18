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

export {
  getValetDir,
  getSyncDir,
  getCacheDir,
  getAuthPath,
  isLoggedIn,
  getAuthToken,
  saveAuthToken,
  clearAuth,
  sync,
  type SyncOptions,
  type AuthToken,
} from "./sync.js";

export {
  proxyToolCall,
  requiresCloudProxy,
  queueToolCall,
  flushQueue,
  type ToolCall,
  type ToolResult,
} from "./proxy.js";
