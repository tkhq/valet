/**
 * Engine-native plugin export. The `slackPlugin: ActionPlugin` is the
 * canonical entry point for the engine's plugin catalog.
 */
export { slackPlugin, slimMessage } from "./actions.js";
export { slackFetch, slackGet } from "./api.js";
export { checkPrivateChannelAccess } from "./channel-access.js";
export { formatSlackBlocks, markdownToSlackMrkdwn } from "../transport/format.js";
