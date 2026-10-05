/** Run the user-facing smoke definitions through real routes, run host and plugins.
 * Only provider HTTP is mocked; no LLM or real Slack messages are involved. */
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { googleWorkspacePlugin } from "@valet/plugin-google-workspace/actions";
import { slackPlugin } from "@valet/plugin-slack/actions";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam } from "../services/teams.js";
import { zip } from "../services/docx-test-fixture.js";
import type { CreateWorkflowResponse, GetWorkflowRunResponse, StartWorkflowRunResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.unstubAllGlobals(); });

it("runs the Drive DOCX and team Slack smoke workflows with workspace credentials and no linked personal identity", async () => {
  api = await bootTestApi({ plugins: [
    { name: "google-workspace", version: "0.0.1", actions: [googleWorkspacePlugin] },
    { name: "slack", version: "0.0.1", actions: [slackPlugin], credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }] },
  ] });
  const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Smoke test", creatorUserId: "local-user" });
  for (const service of ["google_workspace", "slack"]) {
    const owner = service === "slack" ? { type: "org" as const, id: "local-org" } : { type: "team" as const, id: team.id };
    await api.providers.engineCredentials.save(owner, service, {
      type: service === "slack" ? "bot_token" : "oauth2", accessToken: `test-${service}`,
    });
  }
  const docx = zip({ "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>VAL_TEST_927: confidentiality lasts 30 days.</w:t></w:r></w:p></w:body></w:document>' });
  const realFetch = globalThis.fetch;
  const providerCalls: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === api!.baseUrl) return realFetch(input, init);
    providerCalls.push(url.pathname);
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/files/TESTDOCX") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-google_workspace");
      return url.searchParams.get("alt") === "media"
        ? new Response(new Uint8Array(docx), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })
        : json({ id: "TESTDOCX", name: "smoke.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: String(docx.length) });
    }
    if (url.origin === "https://slack.com") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-slack");
      if (url.pathname === "/api/conversations.info") return json({ ok: true, channel: { id: "CTEST", name: "smoke", is_private: false } });
      if (url.pathname === "/api/conversations.history") return json({ ok: true, messages: [{ text: "Smoke test", ts: "1.1" }], has_more: false });
      if (url.pathname === "/api/conversations.open") {
        expect(JSON.parse(String(init?.body))).toEqual({ users: "UTEST" });
        return json({ ok: true, channel: { id: "DTEST" } });
      }
      if (url.pathname === "/api/chat.postMessage") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ channel: "DTEST", text: "Valet team workflow test: explicit-recipient DM works." });
        return json({ ok: true, channel: "DTEST", ts: "2.1" });
      }
    }
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  });

  for (const name of ["drive-docx", "team-slack"]) {
    const source = await readFile(new URL(`../../../../docs/testing/workflows/${name}.json`, import.meta.url), "utf8");
    const definition: unknown = JSON.parse(source.replace("REPLACE_WITH_TEST_DOCX_FILE_ID", "TESTDOCX").replace("REPLACE_WITH_PUBLIC_TEST_CHANNEL_ID", "CTEST").replace("REPLACE_WITH_YOUR_SLACK_USER_ID", "UTEST"));
    const create = await fetch(`${api.baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, teamId: team.id, definition }) });
    expect(create.status, await create.clone().text()).toBe(201);
    const workflow = await create.json() as CreateWorkflowResponse;
    expect(workflow.ownerType).toBe("team");
    const start = await fetch(`${api.baseUrl}/api/workflows/${workflow.id}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(start.status, await start.clone().text()).toBe(201);
    const { runId } = await start.json() as StartWorkflowRunResponse;
    let detail: GetWorkflowRunResponse | undefined;
    await vi.waitFor(async () => {
      detail = await (await fetch(`${api!.baseUrl}/api/workflows/runs/${runId}`)).json() as GetWorkflowRunResponse;
      expect(detail.run.status).toBe("settled");
    }, { timeout: 15_000, interval: 100 });
    expect(detail!.run.outcome, JSON.stringify(detail!.checkpoints)).toBe("completed");
    if (name === "drive-docx") expect(detail!.checkpoints.find(c => c.nodeId === "read_document")?.result).toMatchObject({ content: expect.stringContaining("VAL_TEST_927: confidentiality lasts 30 days.") });
    else expect(detail!.checkpoints.find(c => c.nodeId === "send_dm")?.result).toMatchObject({ channel: "DTEST", ts: "2.1" });
  }
  expect(providerCalls.filter(path => path === "/api/chat.postMessage")).toHaveLength(1);
});
