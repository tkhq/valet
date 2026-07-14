/**
 * Engine-native plugin export. The `gmailPlugin: ActionPlugin` is the
 * canonical entry point for the engine's plugin catalog.
 */
export { gmailPlugin } from "./actions.js";
export { gmailFetch, decodeBase64Url, encodeBase64Url } from "./api.js";
