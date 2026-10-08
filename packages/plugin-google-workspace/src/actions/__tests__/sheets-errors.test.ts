import { describe, expect, it, vi, afterEach } from "vitest";
import { sheetsError, readRange, resolveSheetId, sheetsBatchUpdate } from "../sheets-helpers.js";
const disabled = () => new Response(JSON.stringify({ error: {
  message: "Google Sheets API has not been used in project 1070525638420 before or it is disabled.",
  details: [{ reason: "SERVICE_DISABLED", metadata: { service: "sheets.googleapis.com", consumer: "projects/1070525638420" } }],
} }), { status: 403 });
afterEach(() => vi.unstubAllGlobals());
describe("Sheets actionable errors", () => {
  it("retains disabled API reason, project and enable URL", async () => {
    const result = await sheetsError(disabled());
    expect(result.error).toContain("SERVICE_DISABLED");
    expect(result.error).toContain("https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=1070525638420");
    expect(result.error).toContain("project administrator");
  });
  it("recognizes the older message-only disabled response", async () => {
    const result = await sheetsError(new Response(JSON.stringify({ error: { message: "Google Sheets API has not been used in project 123456 before or it is disabled." } }), { status: 403 }));
    expect(result.error).toContain("?project=123456");
  });
  it("does not mislabel a spreadsheet permission failure as a disabled API", async () => {
    const result = await sheetsError(new Response(JSON.stringify({ error: { message: "The caller does not have permission" } }), { status: 403 }));
    expect(result.error).toContain("The caller does not have permission");
    expect(result.error).not.toContain("SERVICE_DISABLED");
  });
  it.each([readRange, resolveSheetId])("preserves remediation from helper failures", async (helper) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(disabled()));
    await expect(helper("token", "spreadsheet", "Sheet1")).rejects.toThrow("?project=1070525638420");
  });
  it("preserves remediation from write/batch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(disabled()));
    await expect(sheetsBatchUpdate("token", "spreadsheet", [])).rejects.toThrow("SERVICE_DISABLED");
  });
  it("uses a generic enable link when structured project metadata is invalid", async () => {
    const result = await sheetsError(new Response(JSON.stringify({ error: { details: [{ reason: "SERVICE_DISABLED", metadata: { service: "sheets.googleapis.com", consumer: "projects/123&redirect=evil" } }] } }), { status: 403 }));
    expect(result.error).toContain("SERVICE_DISABLED");
    expect(result.error).not.toContain("redirect=evil");
  });
});
