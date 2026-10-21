/**
 * Engine-native plugin export. The `slackPlugin: ActionPlugin` is the
 * canonical entry point for the engine's plugin catalog.
 */
export { slackPlugin, slimMessage } from "./actions.js";
export { slackFetch, slackGet } from "./api.js";
export { checkPrivateChannelAccess, isPermanentSlackAccessError } from "./channel-access.js";
export { withEventChannelName } from "../event-channel-name.js";
export { markdownToSlackMrkdwn } from "../transport/format.js";
export { joinedChannelDirectory } from "../transport/filter-options.js";
