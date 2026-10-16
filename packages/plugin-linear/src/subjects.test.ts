import { describe, expect, it } from "vitest";
import { issueFromUrl, linearEventSubjects, linearSubjects } from "./subjects.js";

// Recorded webhook payloads, trimmed to the fields `linearEventSubjects`
// reads (spec: docs/specs/2026-10-15-event-wakeups-design.md, Part A4/A6).
const issueCreateTriage = {
  action: "create",
  type: "Issue",
  actor: { id: "u-1", type: "user" },
  data: {
    id: "i-8",
    identifier: "ENG-8",
    team: { key: "ENG" },
    state: { type: "triage" },
  },
};

const commentByApp = {
  action: "create",
  type: "Comment",
  actor: { id: "app-1", type: "application" },
  data: {
    id: "c-1",
    issue: { identifier: "ENG-8", team: { key: "ENG" } },
  },
};

const commentNoParent = {
  action: "create",
  type: "Comment",
  actor: { id: "u-1", type: "user" },
  data: {
    id: "c-2",
    team: { key: "ENG" },
  },
};

describe("linearEventSubjects", () => {
  it("issue create in triage gives the team and issue subjects and status triage", () => {
    const r = linearEventSubjects("Issue", issueCreateTriage);
    expect(r.subjects).toEqual(["linear:team/ENG", "linear:ENG-8"]);
    expect(r.status).toBe("triage");
    expect(r.bot).toBe(false);
  });

  it("a comment by an application actor gives bot: true", () => {
    const r = linearEventSubjects("Comment", commentByApp);
    expect(r.bot).toBe(true);
    expect(r.subjects).toEqual(["linear:team/ENG", "linear:ENG-8"]);
  });

  it("a comment whose issue has only { id, title } takes the parent from the top-level url (final review, item 9)", () => {
    const r = linearEventSubjects("Comment", {
      action: "create",
      type: "Comment",
      actor: { id: "u-1", type: "user" },
      url: "https://linear.app/acme/issue/ENG-7/fix-login#comment-c3",
      data: { id: "c-3", body: "ping", issue: { id: "i-7", title: "Fix login" } },
    });
    expect(r.subjects).toEqual(["linear:team/ENG", "linear:ENG-7"]);
  });

  it("a comment in Linear's documented shape (data has only issueId) takes its parent from the url", () => {
    const r = linearEventSubjects("Comment", {
      action: "create",
      type: "Comment",
      actor: { id: "u-1", type: "user", name: "Ada" },
      createdAt: "2026-10-15T00:00:00.000Z",
      url: "https://linear.app/acme/issue/ENG-7/fix-login#comment-c3",
      data: { id: "c-3", body: "ping", issueId: "539068e2-ae88-4d09-bd75-22eb4a59612f", userId: "u-1" },
    });
    expect(r.subjects).toEqual(["linear:team/ENG", "linear:ENG-7"]);
    expect(r.bot).toBe(false);
  });

  it("issueFromUrl reads the identifier and team key, or null", () => {
    expect(issueFromUrl("https://linear.app/acme/issue/ENG-7/fix-login")).toEqual({ identifier: "ENG-7", teamKey: "ENG" });
    expect(issueFromUrl("https://linear.app/acme/issue/A2B-12")).toEqual({ identifier: "A2B-12", teamKey: "A2B" });
    expect(issueFromUrl("https://linear.app/acme/team/ENG/triage")).toBeNull();
    expect(issueFromUrl(undefined)).toBeNull();
  });

  it("a comment payload without the parent identifier gives only the team subject", () => {
    const r = linearEventSubjects("Comment", commentNoParent);
    expect(r.subjects).toEqual(["linear:team/ENG"]);
  });
});

describe("linearSubjects.fromUrl", () => {
  it("an issue URL maps to the issue subject", () => {
    expect(linearSubjects.fromUrl("https://linear.app/acme/issue/ENG-7/fix-login")).toEqual({
      subject: "linear:ENG-7",
    });
  });

  it("a team triage URL maps to the team subject", () => {
    expect(linearSubjects.fromUrl("https://linear.app/acme/team/ENG/triage")).toEqual({
      subject: "linear:team/ENG",
    });
  });

  it("a non-Linear URL returns null", () => {
    expect(linearSubjects.fromUrl("https://example.com/x")).toBeNull();
  });
});

describe("linearSubjects url", () => {
  it('url("linear:ENG-7") is the issue URL', () => {
    expect(linearSubjects.url("linear:ENG-7")).toBe("https://linear.app/issue/ENG-7");
  });
});
