import type { SlackListenersRequest, SlackListenersResponse } from "./slack-listeners-protocol";
import { slackChannelListeners } from "./slack-listeners";

/** A controlled transport. Matching still uses the real pure helper. */
export class ListenerWorkerDouble {
  static instances: ListenerWorkerDouble[] = [];
  static autoRespond = false;
  onmessage: ((event: MessageEvent<SlackListenersResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: SlackListenersRequest;
  terminated = false;

  constructor(readonly url: URL, readonly options: WorkerOptions) {
    ListenerWorkerDouble.instances.push(this);
  }
  postMessage(request: SlackListenersRequest) {
    this.request = request;
    if (ListenerWorkerDouble.autoRespond) queueMicrotask(() => this.respond());
  }
  respond() {
    if (!this.request) throw new Error("Worker has no request");
    const { subscriptions, teamId, teamNames, catalog } = this.request;
    this.send({ kind: "ready", listeners: [...slackChannelListeners(subscriptions, teamId, (id) => teamNames[id], catalog)] });
  }
  send(response: SlackListenersResponse) {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }
  terminate() { this.terminated = true; }
}
