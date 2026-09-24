/** Real sandbox + daemon + engine + HTTP approvals + durable screenshot evidence. */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import browserPlugin from "@valet/plugin-browser/plugin";
import { browserRequest } from "@valet/plugin-browser";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { BrowserArtifact, BrowserResponse } from "@valet/shared";
import { bootTestApi } from "./_setup.js";
import type {
  CreateSessionResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  SessionBrowserResponse,
  WireEvent,
} from "../wire/types.js";

const image = process.env.VALET_BROWSER_TEST_IMAGE;

// The serial browser row owns this fixture. The root unit sweep runs other
// Docker fixtures concurrently and must not start another managed browser.
describe.skipIf(!image || process.env.VALET_BROWSER_INTEGRATION !== "1")(
  "browser full stack in Docker",
  () => {
    it("autoallows routine browser work, retains export approval, and serves direct frames", async () => {
      const root = await mkdtemp(join(tmpdir(), "valet-browser-api-"));
      const provider = new DockerSandboxProvider({
        inventoryRoot: join(root, "inventory"),
        browserEnabled: true,
      });
      const api = await bootTestApi({
        sandboxProvider: provider,
        defaultImage: image,
        plugins: [browserPlugin],
      });
      const faux = registerFauxProvider({ provider: "browser-fullstack" });
      let sessionId: string | undefined;
      let ws: WebSocket | undefined;
      const events: WireEvent[] = [];
      const json = async <T>(
        path: string,
        method = "GET",
        body?: unknown,
      ): Promise<T> => {
        const response = await fetch(`${api.baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result: unknown = await response.json();
        expect(
          response.ok,
          `${method} ${path}: ${JSON.stringify(result)}`,
        ).toBe(true);
        return result as T;
      };
      try {
        const created = await json<CreateSessionResponse>(
          "/api/sessions",
          "POST",
          { workspace: join(root, "workspace"), profile: "headless" },
        );
        sessionId = created.id;
        const path = `/api/sessions/${sessionId}/browser`;
        const initial = await json<SessionBrowserResponse>(path);
        expect(initial.status).toBeNull();
        const started = await json<SessionBrowserResponse>(
          `${path}/start`,
          "POST",
        );
        expect(started.status?.state).toBe("ready");
        const session = api.providers.engineHost.liveSession(sessionId);
        if (!session)
          throw new Error(
            "Browser start did not materialize the engine session",
          );
        const sandbox = session.attachment.current();
        if (!sandbox) throw new Error("Browser sandbox is not attached");
        await sandbox.writeFile(
          "fixture.cjs",
          `require('node:http').createServer((req,res)=>{if(req.url==='/download'){res.setHeader('content-disposition','attachment; filename=dogfood.txt');return res.end('Valet download fixture')}res.setHeader('content-type','text/html');res.end('<title>Browser fixture</title><a href="/download" download>Download fixture</a><h1>Before</h1><label>Name<input aria-label="Name"></label><button onclick="document.querySelector(\\'h1\\').textContent=\\'Saved \\'+document.querySelector(\\'input\\').value">Save</button>')}).listen(5173,'0.0.0.0')`,
        );
        expect(
          (
            await sandbox.exec(
              "node fixture.cjs > /tmp/browser-fixture.log 2>&1 &",
            )
          ).exitCode,
        ).toBe(0);
        session.options.resolveModel = async () => ({
          model: faux.getModel(),
          apiKey: "fixture",
        });
        await session.setModel(faux.getModel().id);
        expect(session.options.tools?.map((tool) => tool.name)).toContain(
          "browser__execute",
        );
        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall(
                "browser__execute",
                {
                  title: "Verify form",
                  code: 'var tab = await browser.tabs.new({url:"http://127.0.0.1:5173"}); await tab.reload(); await tab.playwright.getByLabel("Name").fill("Ada"); await tab.playwright.getByRole("button",{name:"Save",exact:true}).click(); await tab.playwright.getByRole("link",{name:"Download fixture",exact:true}).click(); await tab.markDeliverable(); output.write(await tab.getAXState()); output.image(await tab.getScreenshot()); await tab.content.export("text");',
                },
                { id: "browser-fullstack-call" },
              ),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("The form shows Saved Ada."),
        ]);
        ws = new WebSocket(`${api.wsUrl}/api/sessions/${sessionId}/ws`);
        await new Promise<void>((resolve, reject) => {
          if (!ws) throw new Error("Missing websocket");
          ws.onmessage = (event) => {
            const wire: WireEvent = JSON.parse(String(event.data));
            events.push(wire);
            if (wire.type === "init") resolve();
          };
          ws.onerror = () => reject(new Error("WebSocket failed"));
        });
        await session.prompt("Inspect the fixture and save visual evidence.", {
          author: { id: "local-user", name: "Local Dev" },
        });
        const approvals: string[] = [];
        const resolved = new Set<string>();
        await expect
          .poll(
            async () => {
              const decisions = await json<ListDecisionsResponse>(
                `/api/sessions/${sessionId}/decisions`,
              );
              for (const gate of decisions.gates) {
                if (resolved.has(gate.id)) continue;
                resolved.add(gate.id);
                approvals.push(gate.title);
                await json(
                  `/api/sessions/${sessionId}/decisions/${gate.id}/resolve`,
                  "POST",
                  { actionId: "allow" },
                );
              }
              const history = await json<ListMessagesResponse>(
                `/api/sessions/${sessionId}/messages`,
              );
              return history.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.content.includes("The form shows Saved Ada."),
              );
            },
            { timeout: 120_000, interval: 250 },
          )
          .toBe(true);
        const history = await json<ListMessagesResponse>(
          `/api/sessions/${sessionId}/messages`,
        );
        const completed = history.messages
          .flatMap((message) => message.parts)
          .find(
            (part) =>
              part.kind === "tool_call" && part.toolName === "browser__execute",
          );
        expect(
          completed?.kind === "tool_call" ? completed.status : undefined,
        ).toBe("completed");
        const result =
          completed?.kind === "tool_call"
            ? JSON.stringify(completed.result)
            : "";
        if (!result.includes("Saved Ada"))
          console.error(
            "Browser fixture daemon log:",
            (
              await sandbox.exec("cat /var/lib/valet/browser/daemon.log", {
                privileged: true,
              })
            ).stdout,
          );
        expect(result).toContain("Saved Ada");
        expect(result).toContain("image/png");
        expect(approvals).toEqual(["Browser: tab.export"]);
        expect(
          events.some(
            (event) =>
              event.type === "tool_end" &&
              JSON.stringify(event.resultData).includes("image/png"),
          ),
        ).toBe(true);
        const status = await json<SessionBrowserResponse>(path);
        const tab = status.status?.tabs[0];
        if (!tab || !status.status)
          throw new Error("Deliverable tab was not retained");
        await expect
          .poll(async () => {
            const current = await json<SessionBrowserResponse>(path);
            return current.status?.downloads?.some(
              (file) => file.filename === "dogfood.txt",
            );
          })
          .toBe(true);
        const downloaded = (
          await json<SessionBrowserResponse>(path)
        ).status?.downloads?.find((file) => file.filename === "dogfood.txt");
        if (!downloaded) throw new Error("Missing downloaded fixture");
        expect(downloaded.bytes).toBe(
          Buffer.byteLength("Valet download fixture"),
        );
        const downloadResponse = await fetch(
          `${api.baseUrl}${path}/downloads/${downloaded.id}`,
        );
        expect(downloadResponse.status).toBe(200);
        expect(await downloadResponse.text()).toBe("Valet download fixture");
        const artifact = await json<BrowserArtifact>(
          `${path}/evidence`,
          "POST",
          {
            runtimeId: status.status.runtimeId,
            tabId: tab.id,
          },
        );
        const evidence = await fetch(`${api.baseUrl}${artifact.url}`);
        expect(evidence.headers.get("content-type")).toBe("image/png");
        expect((await evidence.arrayBuffer()).byteLength).toBeGreaterThan(1000);
        const annotation = await json<{ id: string; stale: boolean }>(
          `${path}/evidence/${artifact.id}/annotations`,
          "POST",
          {
            documentId: artifact.documentId,
            marks: [{ x: 20, y: 20, label: "" }],
          },
        );
        expect(annotation.stale).toBe(false);
        const ticket = await json<{ ticket: string }>(
          `${path}/ticket`,
          "POST",
          {
            scope: "view",
          },
        );
        const frame = await fetch(
          `${api.baseUrl}${path}/frame?runtimeId=${status.status.runtimeId}&tabId=${tab.id}`,
          { headers: { "x-browser-ticket": ticket.ticket } },
        );
        expect(frame.status).toBe(200);
        expect(frame.headers.get("content-type")).toBe("image/jpeg");
        const take = await json<BrowserResponse>(`${path}/control`, "POST", {
          action: "take",
          privateMode: true,
        });
        const lease = take.status?.control;
        if (!lease) throw new Error("Missing human control lease");
        const agentStatus = await browserRequest(sandbox, {
          protocolVersion: "1.0",
          sessionId,
          threadId: "other",
          actorId: "local-user",
          ownerId: "local-user",
          command: "status",
        });
        expect(agentStatus.status?.tabs).toEqual([]);
        const privateCapture = await fetch(`${api.baseUrl}${path}/evidence`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runtimeId: status.status.runtimeId,
            tabId: tab.id,
          }),
        });
        expect(privateCapture.status).toBe(409);
        await json(`${path}/control`, "POST", {
          action: "release",
          leaseId: lease.id,
        });
        // Normal human input must not leave an exclusive lease behind.
        const sharedReload = await json<BrowserResponse>(
          `${path}/input`,
          "POST",
          {
            runtimeId: status.status.runtimeId,
            tabId: tab.id,
            documentId: frame.headers.get("x-browser-document-id"),
            input: { type: "reload" },
          },
        );
        const annotations = await json<{ annotations: { stale: boolean }[] }>(
          `${path}/evidence/${artifact.id}/annotations`,
        );
        expect(annotations.annotations[0]?.stale).toBe(true);
        expect(sharedReload.ok).toBe(true);
        expect(
          (await json<SessionBrowserResponse>(path)).status?.control,
        ).toBeNull();
        const opened = await json<BrowserResponse>(`${path}/tab`, "POST", {
          action: "new",
          runtimeId: status.status.runtimeId,
          url: "about:blank",
        });
        expect(opened.ok).toBe(true);
        const sharedTab = opened.status?.selectedTabId;
        expect(sharedTab).toBeTruthy();
        expect(sharedTab).not.toBe(tab.id);
        const selected = await json<BrowserResponse>(`${path}/tab`, "POST", {
          action: "select",
          runtimeId: status.status.runtimeId,
          tabId: tab.id,
        });
        expect(selected.ok).toBe(true);
        const closed = await json<BrowserResponse>(`${path}/tab`, "POST", {
          action: "close",
          runtimeId: status.status.runtimeId,
          tabId: sharedTab,
        });
        expect(closed.ok).toBe(true);
        expect(closed.status?.control).toBeNull();
        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall(
                "browser__execute",
                {
                  title: "Continue after shared input",
                  code: `var sharedTab = await browser.tabs.get(${JSON.stringify(tab.id)}); await sharedTab.getAXState(); await sharedTab.playwright.getByLabel("Name").fill("Shared"); await sharedTab.playwright.getByRole("button",{name:"Save",exact:true}).click(); output.write(await sharedTab.getAXState());`,
                },
                { id: "browser-shared-call" },
              ),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Shared browser input verified."),
        ]);
        await session.prompt(
          "Continue using the page after my browser input.",
          {
            author: { id: "local-user", name: "Local Dev" },
          },
        );
        await expect
          .poll(
            async () => {
              const current = await json<ListMessagesResponse>(
                `/api/sessions/${sessionId}/messages`,
              );
              return current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.content.includes("Shared browser input verified."),
              );
            },
            { timeout: 30_000, interval: 250 },
          )
          .toBe(true);
        const sharedHistory = await json<ListMessagesResponse>(
          `/api/sessions/${sessionId}/messages`,
        );
        const sharedResult = sharedHistory.messages
          .flatMap((message) => message.parts)
          .find(
            (part) =>
              part.kind === "tool_call" &&
              part.callId === "browser-shared-call",
          );
        expect(
          sharedResult?.kind === "tool_call" ? sharedResult.status : undefined,
        ).toBe("completed");
        expect(
          sharedResult?.kind === "tool_call"
            ? JSON.stringify(sharedResult.result)
            : "",
        ).toContain("Saved Shared");
        expect(
          (await json<SessionBrowserResponse>(path)).status?.control,
        ).toBeNull();
        await json(`${path}/settings`, "PATCH", { enabled: false });
        const denied = await fetch(`${api.baseUrl}${path}/start`, {
          method: "POST",
        });
        expect(denied.status).toBe(409);
        await json(`${path}/settings`, "PATCH", { enabled: true });
        const restarted = await json<SessionBrowserResponse>(
          `${path}/start`,
          "POST",
        );
        expect(restarted.status?.state).toBe("ready");
        expect(restarted.status?.runtimeId).not.toBe(status.status.runtimeId);
      } finally {
        ws?.close();
        if (sessionId) await api.providers.engineHost.destroy(sessionId);
        faux.unregister();
        await api.cleanup();
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
