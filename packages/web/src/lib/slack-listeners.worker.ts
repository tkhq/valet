import { slackChannelListeners } from "./slack-listeners";
import type { SlackListenersRequest, SlackListenersResponse } from "./slack-listeners-protocol";

// This module runs only in the dedicated worker created by the coverage hook.
self.onmessage = ({ data }: MessageEvent<SlackListenersRequest>) => {
  let response: SlackListenersResponse;
  try {
    const { subscriptions, teamId, teamNames, catalog } = data;
    response = { kind: "ready", listeners: [...slackChannelListeners(subscriptions, teamId, (id) => teamNames[id], catalog)] };
  } catch {
    response = { kind: "error" };
  }
  self.postMessage(response);
};
