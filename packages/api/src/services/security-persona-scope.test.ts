import { describe, expect, it } from "vitest";
import { NATIVE_IMAGE_RESULT_TOOL } from "@valet/engine";
import { PERSONA_DENIED_TOOLS, personaToolScope, reservedToolServices } from "./security-persona-scope.js";

describe("personaToolScope", () => {
  it("gives a static persona its sec tools and the sandbox tools, and no actions", () => {
    const scope = personaToolScope({ persona: "sast", review: false }, []);
    expect(scope.tools).toEqual(expect.arrayContaining(["sec_fs_write", "sec_fs_read", "sec_fs_list", "sec_protocol_read", "sec_finding_report", "sec_coverage_report", "sec_need_report", "read", "write", "edit", "bash", "update_plan", "thread_read", "watch", "wake_at", "hold_sandbox", "process_read", "wakeup_list", "wakeup_cancel", "list_tools", "call_tool", "focus_tools"]));
    expect(scope.tools).not.toEqual(expect.arrayContaining(["child_send", "child_read", "child_status", "ask_question", "ask_approval", "switch_model", "wait_for_event", "task", "list_threads"]));
    expect(scope.actions).toEqual([]);
  });
  it("gives every persona the declared MCP services as wildcard actions", () => {
    expect(personaToolScope({ persona: "dast", review: false }, ["zap", "nuclei"]).actions).toEqual(["zap.*", "nuclei.*"]);
    expect(personaToolScope({ persona: "sast", review: false }, ["semgrep"]).actions).toEqual(["semgrep.*"]);
  });
  it("drops a stored service name that the tool scope parser would refuse", () => {
    expect(personaToolScope({ persona: "dast", review: false }, ["zap", "zap.proxy", "bad name"]).actions).toEqual(["zap.*"]);
  });
  it("drops a declared service that is an installed integration", () => {
    expect(personaToolScope({ persona: "dast", review: false }, ["github", "zap"], new Set(["github"])).actions).toEqual(["zap.*"]);
  });
  it("gives the report persona sec_report_write and reconcile sec_finding_review", () => {
    expect(personaToolScope({ persona: "report", review: false }, []).tools).toContain("sec_report_write");
    expect(personaToolScope({ persona: "reconcile", review: false }, []).tools).toContain("sec_finding_review");
  });
  it("grants sec_finding_review only to a review cell", () => {
    expect(personaToolScope({ persona: "sast", review: false }, []).tools).not.toContain("sec_finding_review");
    expect(personaToolScope({ persona: "sast", review: true }, []).tools).toContain("sec_finding_review");
  });
  it("never grants file_attach or the image receipt, which move bytes past the tripwire", () => {
    const tools = personaToolScope({ persona: "sast", review: false }, []).tools;
    expect(tools).not.toContain("file_attach");
    expect(tools).not.toContain(NATIVE_IMAGE_RESULT_TOOL);
    expect(PERSONA_DENIED_TOOLS).toContain(NATIVE_IMAGE_RESULT_TOOL);
  });
});

describe("reservedToolServices", () => {
  it("reserves each service key and the prefix of each dotted action id", () => {
    const reserved = reservedToolServices(
      new Map([
        ["slack-user", { actionPlugin: { actions: [{ id: "slack_user.post_message" }] } }],
        ["github", { actionPlugin: { actions: [{ id: "create_issue" }] } }],
      ]),
    );
    expect([...reserved].sort()).toEqual(["github", "slack-user", "slack_user"]);
  });
});
