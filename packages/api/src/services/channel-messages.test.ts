import { describe, expect, it } from "vitest";
import {
  actionChannelMessage, channelUrl, inboundSlackMessage, parseChannelKey, pullRequestComment, slackConversationFromThreadKey,
} from "./channel-messages.js";

const base = { orgId: "o1", sessionId: "s1", threadId: "t1", status: "completed" };

describe("channel keys", () => {
  it("parses Slack and pull request keys, and refuses anything else", () => {
    expect(parseChannelKey("slack:C123")).toEqual({ provider: "slack", channelId: "C123" });
    expect(parseChannelKey("github:acme/app#12")).toEqual({ provider: "github", owner: "acme", repo: "app", number: 12 });
    expect(parseChannelKey("slack:c123")).toBeNull();
    expect(parseChannelKey("github:acme/app")).toBeNull();
    expect(channelUrl("github:acme/app#12", "https://github.com")).toBe("https://github.com/acme/app/pull/12");
  });

  it("reads a Slack conversation from a thread key, but never a DM", () => {
    expect(slackConversationFromThreadKey("slack:C123:1700.1")).toEqual({ channelId: "C123", threadTs: "1700.1" });
    expect(slackConversationFromThreadKey("slack:D123:1700.1")).toBeNull();
    expect(slackConversationFromThreadKey("web:abc")).toBeNull();
  });

  it("links an inbound reply inside its Slack thread", () => {
    expect(inboundSlackMessage("slack:C123:1700.1", "1700.2", "Dana", "hi")).toMatchObject({
      channelKey: "slack:C123", conversationKey: "slack:C123:1700.1", providerMessageId: "1700.2", author: "Dana",
      url: "https://slack.com/archives/C123/p17002?thread_ts=1700.1&cid=C123",
    });
    expect(inboundSlackMessage("slack:C123:1700.1", undefined, "Dana", "hi")).toBeUndefined();
  });
});

describe("actionChannelMessage", () => {
  it("records a Slack send under the thread it names", () => {
    const message = actionChannelMessage({
      ...base, actionId: "slack.send_message",
      params: { channel: "C123", text: "Deployed", thread_ts: "1700.1" },
      result: { success: true, data: { channel: "C123", ts: "1700.5" } },
    }, null);
    expect(message).toMatchObject({
      channelKey: "slack:C123", conversationKey: "slack:C123:1700.1", providerMessageId: "1700.5", direction: "out", text: "Deployed",
    });
  });

  it("threads reply_to_origin under the engine thread's Slack conversation", () => {
    const message = actionChannelMessage({
      ...base, actionId: "slack.reply_to_origin", params: { text: "On it" },
      result: { success: true, data: { channel: "C123", ts: "1700.9" } },
    }, "slack:C123:1700.1");
    expect(message?.conversationKey).toBe("slack:C123:1700.1");
  });

  it("ignores DMs, failures, and issue comments", () => {
    expect(actionChannelMessage({ ...base, actionId: "slack.send_message", result: { success: true, data: { channel: "D1", ts: "1" } } }, null)).toBeNull();
    expect(actionChannelMessage({ ...base, actionId: "slack.send_message", result: { success: false } }, null)).toBeNull();
    expect(actionChannelMessage({
      ...base, actionId: "github.create_comment", params: { owner: "acme", repo: "app", issueNumber: 3, body: "x" },
      result: { success: true, data: { id: 1, html_url: "https://github.com/acme/app/issues/3#issuecomment-1" } },
    }, null)).toBeNull();
  });

  it("records a pull request comment on the pull request's channel", () => {
    const message = actionChannelMessage({
      ...base, actionId: "github.create_comment", params: { owner: "acme", repo: "app", issueNumber: 12, body: "Fixed" },
      result: { success: true, data: { id: 77, body: "Fixed", html_url: "https://github.com/acme/app/pull/12#issuecomment-77" } },
    }, null);
    expect(message).toMatchObject({ channelKey: "github:acme/app#12", providerMessageId: "77", text: "Fixed" });
  });
});

describe("pullRequestComment", () => {
  it("reads a comment on a pull request, and skips an issue comment", () => {
    const comment = pullRequestComment("github.issue_comment.created", {
      issue: { pull_request: { html_url: "https://github.com/acme/app/pull/12" } },
      comment: { id: 5, body: "Please pin it", html_url: "https://github.com/acme/app/pull/12#issuecomment-5", user: { login: "rev" } },
    });
    expect(comment).toMatchObject({
      pullRequestUrl: "https://github.com/acme/app/pull/12", channelKey: "github:acme/app#12",
      message: { providerMessageId: "5", author: "rev", text: "Please pin it" },
    });
    expect(pullRequestComment("github.issue_comment.created", { issue: {}, comment: { id: 5 } })).toBeNull();
    expect(pullRequestComment("github.push", {})).toBeNull();
  });

  it("leaves a bot's comment, Valet's own included, off the pull request thread", () => {
    const payload = (user: { login: string; type?: string }) => ({
      issue: { pull_request: { html_url: "https://github.com/acme/app/pull/12" } },
      comment: { id: 6, body: "Pinned it.", user },
    });
    expect(pullRequestComment("github.issue_comment.created", payload({ login: "valet[bot]", type: "Bot" }))).toBeNull();
    expect(pullRequestComment("github.issue_comment.created", payload({ login: "ci[bot]" }))).toBeNull();
    expect(pullRequestComment("github.issue_comment.created", payload({ login: "rev", type: "User" }))).not.toBeNull();
  });

  it("describes a review with no body by its state", () => {
    const review = pullRequestComment("github.pull_request_review.submitted", {
      pull_request: { html_url: "https://github.com/acme/app/pull/12" },
      review: { id: 9, body: null, state: "CHANGES_REQUESTED", user: { login: "rev" } },
    });
    expect(review?.message.text).toBe("Review: changes requested");
  });
});
