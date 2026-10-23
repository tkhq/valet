import type { ChannelListener, slackChannelListeners } from "./slack-listeners";

export interface SlackListenersRequest {
  subscriptions: Parameters<typeof slackChannelListeners>[0];
  teamId: string;
  teamNames: Record<string, string | undefined>;
  catalog: NonNullable<Parameters<typeof slackChannelListeners>[3]>;
}

export type SlackListenersResponse =
  | { kind: "ready"; listeners: [string, ChannelListener][] }
  | { kind: "error" };
