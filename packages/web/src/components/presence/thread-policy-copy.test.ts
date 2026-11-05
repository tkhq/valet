import { describe, expect, it } from "vitest";
import {
  carriesSlackConversation,
  defaultWizardThreadPolicy,
  displayThreadPolicy,
  sameThreadPolicy,
  subjectKindForKeys,
} from "./thread-policy-copy";

describe("subjectKindForKeys", () => {
  it("names a Slack channel", () => {
    expect(subjectKindForKeys(["slack.app_mention"])).toBe("channel");
    expect(subjectKindForKeys(["slack.message", "slack.reaction"])).toBe("channel");
  });

  it("names a pull request for pull request, review, check, and status keys", () => {
    expect(subjectKindForKeys(["github.pr.opened"])).toBe("pull request");
    expect(subjectKindForKeys(["github.pull_request.closed"])).toBe("pull request");
    expect(subjectKindForKeys(["github.review.submitted"])).toBe("pull request");
    expect(subjectKindForKeys(["github.check_run.completed"])).toBe("pull request");
    expect(subjectKindForKeys(["github.status"])).toBe("pull request");
    expect(subjectKindForKeys(["github.issue.opened", "github.pr.opened"])).toBe("pull request");
  });

  it("names a GitHub issue for issue keys, else the repository", () => {
    expect(subjectKindForKeys(["github.issue.opened"])).toBe("issue");
    expect(subjectKindForKeys(["github.push"])).toBe("repository");
    expect(subjectKindForKeys(["github.*"])).toBe("repository");
  });

  it("names a Linear issue", () => {
    expect(subjectKindForKeys(["linear.issue.created"])).toBe("issue");
  });

  it("returns null when no key names a subject", () => {
    expect(subjectKindForKeys([])).toBeNull();
    expect(subjectKindForKeys(["webhook.received"])).toBeNull();
  });

  it("uses the first key that names a subject", () => {
    expect(subjectKindForKeys(["webhook.received", "linear.issue.created"])).toBe("issue");
  });
});

describe("displayThreadPolicy", () => {
  it("reads an absent policy as new for a follow rule", () => {
    expect(displayThreadPolicy({ follow: true }, ["github.pr.opened"])).toEqual({ mode: "new" });
    expect(displayThreadPolicy({ thread: null, follow: true }, [])).toEqual({ mode: "new" });
  });

  it("reads an absent policy as new when the keys carry Slack mentions or messages", () => {
    expect(displayThreadPolicy({}, ["slack.app_mention"])).toEqual({ mode: "new" });
    expect(displayThreadPolicy({ follow: false }, ["slack.message"])).toEqual({ mode: "new" });
  });

  it("reads an absent policy as one thread per channel for other Slack keys", () => {
    expect(displayThreadPolicy({}, ["slack.reaction_added"])).toEqual({ mode: "subject" });
    expect(displayThreadPolicy({}, ["slack.channel_archive", "github.pr.opened"])).toEqual({ mode: "subject" });
  });

  it("reads an absent policy as own otherwise", () => {
    expect(displayThreadPolicy({ follow: false }, ["github.pr.opened"])).toEqual({ mode: "own" });
    expect(displayThreadPolicy({}, [])).toEqual({ mode: "own" });
  });

  it("keeps a stored policy", () => {
    expect(displayThreadPolicy({ thread: { mode: "subject" }, follow: true }, ["slack.message"])).toEqual({ mode: "subject" });
  });
});

describe("carriesSlackConversation", () => {
  it("is true for mention and message keys only", () => {
    expect(carriesSlackConversation(["github.pr.opened", "slack.app_mention"])).toBe(true);
    expect(carriesSlackConversation(["slack.message"])).toBe(true);
    expect(carriesSlackConversation(["slack.reaction_added"])).toBe(false);
  });
});

describe("defaultWizardThreadPolicy", () => {
  it("defaults mentions to a new thread", () => {
    expect(defaultWizardThreadPolicy("reply", "channel")).toEqual({ mode: "new" });
  });

  it("defaults a notification or a workflow event with a subject to one thread per subject", () => {
    expect(defaultWizardThreadPolicy("notify", "pull request")).toEqual({ mode: "subject" });
    expect(defaultWizardThreadPolicy("workflow", "channel")).toEqual({ mode: "subject" });
  });

  it("defaults everything else to the rule's own thread", () => {
    expect(defaultWizardThreadPolicy("notify", null)).toEqual({ mode: "own" });
    expect(defaultWizardThreadPolicy("advanced", "channel")).toEqual({ mode: "own" });
    expect(defaultWizardThreadPolicy("schedule", null)).toEqual({ mode: "own" });
    expect(defaultWizardThreadPolicy("thread", "channel")).toEqual({ mode: "own" });
  });
});

describe("sameThreadPolicy", () => {
  it("compares modes and existing targets", () => {
    expect(sameThreadPolicy({ mode: "new" }, { mode: "new" })).toBe(true);
    expect(sameThreadPolicy({ mode: "new" }, { mode: "own" })).toBe(false);
    expect(sameThreadPolicy(
      { mode: "existing", sessionId: "s", threadId: "t1" },
      { mode: "existing", sessionId: "s", threadId: "t2" },
    )).toBe(false);
    expect(sameThreadPolicy(
      { mode: "existing", sessionId: "s", threadId: "t1" },
      { mode: "existing", sessionId: "s", threadId: "t1" },
    )).toBe(true);
  });
});
