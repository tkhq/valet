/**
 * Engine-native plugin export. The `githubPlugin: ActionPlugin` is the
 * canonical entry point for the engine's plugin catalog.
 */
export { githubPlugin } from "./actions.js";
export { githubFetch } from "./api.js";
export { githubTriggerDefs } from "../triggers.js";
