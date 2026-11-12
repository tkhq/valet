import { describe, expect, it } from "vitest";
import { deriveActionLabel, deriveMcpToolLabel } from "./action-label.js";

describe("deriveActionLabel", () => {
  it.each([
    ["gmail", "gmail.list_messages", { query: "invoice" }, "Searched Gmail messages for “invoice”"],
    ["gmail", "gmail.get_message", { messageId: "18f3a9b2c4d5e6f7a8b9c0" }, "Read Gmail message"],
    ["gmail", "gmail.trash_message", { messageId: "18f3a9b2c4d5e6f7a8b9c0" }, "Moved Gmail message to trash"],
    ["gmail", "gmail.get_draft", { draftId: "r-123" }, "Read Gmail draft r-123"],
    ["gmail", "gmail.send_email", { to: "a@b.co", subject: "Hi" }, "Sent Gmail email “Hi”"],
    ["github", "github.get_issue", { owner: "acme", repo: "valet", issueNumber: 12 }, "Read GitHub issue #12"],
    ["github", "github.get_pull_request", { owner: "acme", repo: "valet", pullNumber: 34 }, "Read GitHub pull request #34"],
    ["github", "github.get_workflow_run", { owner: "acme", repo: "valet", run_id: 99 }, "Read GitHub workflow run 99"],
    ["github", "github.create_branch", { owner: "acme", repo: "valet", branch: "fix-x" }, "Created GitHub branch fix-x"],
    ["slack", "slack.lookup_user_by_email", { email: "a@b.co" }, "Looked up Slack user a@b.co"],
    ["slack", "slack.fetch_file", { url: "https://user:pw@files.slack.com/files-pri/T1-F1/report.pdf?t=secret" }, "Read Slack file files.slack.com/report.pdf"],
    ["google_workspace", "docs.read_document", { documentId: "short-id" }, "Read Google Docs document short-id"],
    ["google_workspace", "sheets.get_spreadsheet_info", { spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }, "Read Google Sheets spreadsheet info"],
    ["google_workspace", "calendar.create_event", { summary: "Standup" }, "Created Google Calendar event “Standup”"],
    ["github", "github.list_issues", { owner: "acme", repo: "valet" }, "Listed GitHub issues in acme/valet"],
    ["google_workspace", "drive.search_files", { query: "budget" }, "Searched Google Drive files for “budget”"],
    ["slack", "slack.read_history", { channel: "C01ABCDEFG" }, "Read Slack history"],
    ["slack-user", "slack_user.add_reaction", { name: "eyes" }, "Added Slack reaction “eyes”"],
  ])("%s %s", (service, id, args, expected) => {
    expect(deriveActionLabel(service, id, args)).toBe(expected);
  });

  it("returns nothing for an unknown verb", () => {
    expect(deriveActionLabel("sentry", "sentry.whoami", {})).toBeUndefined();
  });

  it("cuts a long target", () => {
    expect(deriveActionLabel("gmail", "gmail.list_messages", { query: "x".repeat(200) })!.length).toBeLessThan(100);
  });
});

describe("deriveMcpToolLabel", () => {
  it.each([
    ["linear", "list_issues", { query: "deploy" }, "Searched Linear issues for “deploy”"],
    ["linear", "get_issue", { id: "ENG-123" }, "Read Linear issue ENG-123"],
    ["notion", "notion-fetch", { id: "https://www.notion.so/acme/Roadmap-abc123?pvs=4&token=secret" }, "Read Notion www.notion.so/Roadmap-abc123"],
    ["linear", "save_issue", { title: "Fix login" }, "Saved Linear issue “Fix login”"],
    ["linear", "create_comment", { issueId: "ENG-123", body: "x" }, "Created Linear comment on ENG-123"],
    ["linear", "list_teams", {}, "Listed Linear teams"],
    ["notion", "notion-fetch", { id: "page-title" }, "Read Notion page-title"],
    ["notion", "notion-search", { query: "roadmap" }, "Searched Notion for “roadmap”"],
    ["sentry", "whoami", {}, "Ran Sentry whoami"],
  ])("%s %s", (service, tool, args, expected) => {
    expect(deriveMcpToolLabel(service, tool, args)).toBe(expected);
  });
});

describe("service names with regex characters", () => {
  it("does not treat the service as a pattern", () => {
    expect(deriveMcpToolLabel("a+b(", "a+b(-whoami", {})).toMatch(/^Ran .*whoami$/);
    expect(() => deriveMcpToolLabel("(", "x", {})).not.toThrow();
  });
});

describe("present tense", () => {
  it("names a running call", () => {
    expect(deriveActionLabel("gmail", "gmail.list_messages", { query: "invoice" }, "present")).toBe("Searching Gmail messages for “invoice”");
    expect(deriveActionLabel("linear", "linear.get_issue", { id: "ENG-1" }, "present")).toBe("Reading Linear issue ENG-1");
    expect(deriveMcpToolLabel("sentry", "whoami", {}, "present")).toBe("Running Sentry whoami");
  });
});
