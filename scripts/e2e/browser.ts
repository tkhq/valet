/** Real Docker browser boundary, lifecycle, journal, and viewer regression. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserEvent,
  BrowserIdentity,
  BrowserRequest,
  BrowserResponse,
} from "../../packages/shared/src/browser.js";

async function main() {
  const image =
    process.env.VALET_BROWSER_TEST_IMAGE ?? "valet-browser-e2e:local";
  const inspected = spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
  });
  if (inspected.status !== 0) {
    assert(
      !process.env.VALET_BROWSER_TEST_IMAGE,
      `Browser test image ${image} is missing. Build docker/Dockerfile.sandbox-k8s first.`,
    );
    const build = spawnSync(
      "docker",
      ["build", "-f", "docker/Dockerfile.sandbox-k8s", "-t", image, "."],
      { stdio: "inherit" },
    );
    assert.equal(
      build.status,
      0,
      "Build the browser test image before running this suite.",
    );
  }
  await runBrowserScenario(image, false);
  await runBrowserScenario(image, true);
  const api = spawnSync(
    "pnpm",
    ["--filter", "@valet/api", "test", "browser.docker.test"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        VALET_BROWSER_TEST_IMAGE: image,
        VALET_BROWSER_INTEGRATION: "1",
      },
    },
  );
  assert.equal(
    api.status,
    0,
    "The browser HTTP integration failed. Inspect its test output.",
  );
}

async function runBrowserScenario(image: string, docker: boolean) {
  const { DockerSandboxProvider, createSandboxWorkspace } =
    await import("../../packages/sandbox-docker/src/sandbox.js");
  const { browserRequest, readBrowserExport } =
    await import("../../packages/plugin-browser/src/client.js");
  const root = await createSandboxWorkspace("valet-browser-e2e-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const options = {
    browserEnabled: true,
    browserImage: image,
    inventoryRoot: join(root, "private"),
  };
  let provider = new DockerSandboxProvider(options);
  const sessionId = `browser-e2e-${root.split("/").at(-1)}`;
  const create = {
    workspace,
    sessionId,
    image,
    docker,
    browser: { enabled: true },
    env: { VALET_BROWSER_DEV_PORTS: "5173" },
  };
  let sandbox = await provider.create(create);
  const identity: BrowserIdentity = {
    protocolVersion: "1.0",
    sessionId,
    threadId: "fixture-thread",
    actorId: "fixture-user",
    ownerId: "fixture-user",
  };
  const viewer: BrowserIdentity = { ...identity, audience: "viewer" };
  const request = (body: BrowserRequest) => browserRequest(sandbox, body);

  async function finish(
    invocationId: string,
    response: BrowserResponse,
  ): Promise<{ response: BrowserResponse; events: BrowserEvent[] }> {
    const events: BrowserEvent[] = [];
    for (let attempts = 0; attempts < 100; attempts++) {
      events.push(...response.events);
      for (const event of response.events)
        if (event.type === "approval") {
          const approval = event.request;
          await request({
            ...identity,
            command: "resolve",
            invocationId,
            operationId: approval.operationId,
            hash: approval.hash,
            runtimeId: approval.runtimeId,
            decision: "allow",
            policyVersion: approval.policyVersion,
            expiresAt: approval.expiresAt,
          });
        }
      if (
        response.cell &&
        !["running", "awaiting_approval"].includes(response.cell.status)
      ) {
        assert.equal(
          response.cell.status,
          "completed",
          JSON.stringify(response.cell),
        );
        return { response, events };
      }
      response = await request({
        ...identity,
        command: "events",
        invocationId,
        after: response.cursor,
        waitMs: 1000,
      });
    }
    throw Error(
      `Cell ${invocationId} did not finish. Inspect the browser daemon log.`,
    );
  }
  async function cell(invocationId: string, code: string) {
    return finish(
      invocationId,
      await request({
        ...identity,
        command: "submit",
        invocationId,
        title: invocationId,
        code,
      }),
    );
  }
  async function startFixture() {
    const html = '<label>Count<input value="0"></label><button onclick="this.previousElementSibling.firstElementChild.value=String(Number(this.previousElementSibling.firstElementChild.value)+1)">Increment</button><input type="file" aria-label="Upload" onchange="this.files[0].text().then(text=>this.nextElementSibling.textContent=text)"><output></output>';
    await sandbox.writeFile(
      "fixture.cjs",
      `require('node:http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.setHeader('set-cookie','fixture=signed-in; Path=/; Max-Age=3600; HttpOnly');res.end('<title>'+((req.headers.cookie||'').includes('fixture=signed-in')?'Signed in':'Guest')+'</title>'+${JSON.stringify(html)});}).listen(5173,'127.0.0.1',()=>console.log('ready'));`,
    );
    const job = await sandbox.execJob("node fixture.cjs");
    for (let attempt = 0; attempt < 30; attempt++) {
      const probe = await sandbox.exec(
        'node -e \'require("http").get("http://127.0.0.1:5173",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))\'',
      );
      if (probe.exitCode === 0) return job;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(
      "The browser fixture server did not start. Inspect its job output.",
    );
  }

  try {
    if (docker) {
      let daemon = await sandbox.exec("docker info --format '{{.ServerVersion}}'");
      for (let attempt = 0; attempt < 60 && daemon.exitCode !== 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        daemon = await sandbox.exec("docker info --format '{{.ServerVersion}}'");
      }
      assert.equal(daemon.exitCode, 0, daemon.stderr);
      assert(daemon.stdout.trim(), "Docker must remain available alongside the browser.");
      const container = await sandbox.exec("docker run --rm busybox:stable echo docker-browser-ok", { timeout: 60_000 });
      assert.equal(container.exitCode, 0, container.stderr);
      assert.equal(container.stdout.trim(), "docker-browser-ok");
      const privateState = await sandbox.exec("test ! -S /var/lib/valet/browser/runtime.sock");
      assert.equal(privateState.exitCode, 0, "The workload must not mount the browser socket.");
    }
    await startFixture();
    const initial = await request({ ...identity, command: "status" });
    assert.equal(initial.status?.state, "ready");
    const pending = await request({
      ...identity,
      command: "submit",
      invocationId: "open",
      title: "Open fixture",
      code: 'const tab = await browser.tabs.new({url:"http://localhost:5173"}); await tab.getAXState();',
    });
    let approvalBatch = pending;
    for (
      let attempt = 0;
      attempt < 10 &&
      !approvalBatch.events.some((event) => event.type === "approval");
      attempt++
    )
      approvalBatch = await request({
        ...identity,
        command: "events",
        invocationId: "open",
        after: approvalBatch.cursor,
        waitMs: 1000,
      });
    assert(
      approvalBatch.events.some((event) => event.type === "approval"),
      `A browser effect must pause for approval. ${JSON.stringify(approvalBatch)}`,
    );
    assert.equal(
      approvalBatch.cell?.operations[0]?.status,
      "awaiting_approval",
    );
    await finish("open", approvalBatch);
    const mutationCode =
      'await tab.playwright.getByRole("button",{name:"Increment",exact:true}).click(); await tab.getAXState(); await tab.getScreenshot();';
    const mutation = await cell("mutation", mutationCode);
    assert(
      mutation.events.some(
        (event) =>
          event.type === "text" &&
          /textbox "Count"[^\n]*: "?1"?/.test(event.text),
      ),
      "The approved mutation must appear in the page snapshot.",
    );
    const artifact = mutation.events.find((event) => event.type === "artifact");
    assert(artifact?.type === "artifact");
    const exported = await request({
      ...identity,
      command: "export",
      artifactId: artifact.artifact.id,
    });
    assert(exported.artifact);
    const png = await readBrowserExport(sandbox, exported.artifact);
    assert.deepEqual([...png.slice(0, 4)], [137, 80, 78, 71]);
    await assert.rejects(sandbox.readBinary(exported.artifact.path));
    await request({
      ...identity,
      command: "ack",
      transferId: exported.artifact.transferId,
    });
    const repeated = await request({
      ...identity,
      command: "submit",
      invocationId: "mutation",
      title: "mutation",
      code: mutationCode,
    });
    assert.equal(repeated.cell?.cellId, mutation.response.cell?.cellId);
    const unchanged = await cell("no-replay", "await tab.getAXState();");
    assert(
      unchanged.events.some(
        (event) =>
          event.type === "text" &&
          /textbox "Count"[^\n]*: "?1"?/.test(event.text),
      ),
    );
    for (const absolute of [false, true]) {
      const content = `upload-${absolute ? "absolute" : "relative"}-exact-bytes`;
      await sandbox.writeFile("upload.txt", content);
      const uploaded = await cell(`upload-${absolute}`, `var uploadSnapshot=await tab.getAXState(); var uploadLine=uploadSnapshot.split("\\n").find(line=>line.includes('"Upload"')); var uploadRef=uploadLine?.match(/\\[ref=([^\\]]+)\\]/)?.[1]; if(!uploadRef)throw Error(uploadSnapshot); await tab.upload(uploadRef,[${JSON.stringify(absolute ? "/workspace/upload.txt" : "upload.txt")}]); await tab.playwright.getByText(${JSON.stringify(content)},{exact:true}).waitFor({state:"visible"}); await tab.getAXState();`);
      assert(uploaded.events.some(event => event.type === "text" && event.text.includes(content)), "Uploaded file bytes must reach the page.");
    }
    if (docker) {
      const write = await sandbox.exec("echo forbidden > /workspace/browser-write.txt", { target: "browser", privileged: true });
      assert.notEqual(write.exitCode, 0, "The browser companion must not write the working directory.");
    }
    provider = new DockerSandboxProvider(options);
    sandbox = await provider.restore(sandbox.id);
    assert.equal(
      (await request({ ...identity, command: "status" })).runtimeId,
      initial.runtimeId,
      "API restart must adopt the same daemon.",
    );
    await cell("persistent-binding", "await tab.title();");
    const control = await request({
      ...viewer,
      command: "control",
      action: "take",
      privateMode: true,
    });
    const lease = control.status?.control;
    assert(lease);
    assert.deepEqual(
      (await request({ ...identity, command: "status" })).status?.tabs,
      [],
      "Private human takeover must hide agent observations.",
    );
    const visible = control.status?.tabs[0];
    assert(visible);
    const frame = await request({
      ...viewer,
      command: "frame",
      runtimeId: control.runtimeId,
      tabId: visible.id,
    });
    assert(frame.artifact);
    assert((await readBrowserExport(sandbox, frame.artifact)).length > 100);
    await assert.rejects(
      request({
        ...viewer,
        actorId: "other",
        command: "input",
        leaseId: lease.id,
        runtimeId: control.runtimeId,
        tabId: visible.id,
        documentId: visible.documentId,
        input: { type: "key", key: "x" },
      }),
    );
    await request({
      ...viewer,
      command: "control",
      action: "release",
      leaseId: lease.id,
    });
    await cell(
      "persist-cookie",
      "await tab.reload(); await tab.markDeliverable(); await tab.title();",
    );
    const audit = await request({
      ...identity,
      audience: "lifecycle",
      command: "audit",
    });
    assert(
      audit.audit?.some(
        (entry) =>
          entry.method === "locator.click" && entry.status === "completed",
      ),
    );
    await request({ ...identity, audience: "lifecycle", command: "suspend" });
    const previousId = sandbox.id;
    await provider.release(previousId);
    sandbox = await provider.create(create);
    await startFixture();
    const fresh = await request({ ...identity, command: "status" });
    assert.notEqual(fresh.runtimeId, initial.runtimeId);
    const lost = await request({
      ...identity,
      command: "submit",
      invocationId: "mutation",
      title: "mutation",
      code: mutationCode,
    });
    assert.equal(
      lost.cell?.cellId,
      mutation.response.cell?.cellId,
      "Container replacement must not replay a journaled invocation.",
    );
    const cookie = await cell(
      "cookie-after-replacement",
      'const nextTab = await browser.tabs.new({url:"http://localhost:5173"}); await nextTab.title();',
    );
    assert(
      cookie.response.cell?.operations.some(
        (operation) => operation.result === "Signed in",
      ),
      "The browser profile cookie must survive container replacement.",
    );
    await request({ ...identity, audience: "lifecycle", command: "suspend" });
    await provider.release(sandbox.id);
    const retained = await provider.readBrowserAudit(sandbox.id);
    assert(retained.total > 0);
    assert.equal(retained.entries.length, retained.total);
    assert(
      retained.entries.some(
        (entry) =>
          entry.method === "locator.click" && entry.status === "completed",
      ),
    );
    console.log(
      `[browser docker=${docker}] PASS: confinement, approvals, media, no replay, takeover, adoption, and profile retention`,
    );
  } catch (error) {
    console.error(
      await sandbox.exec("cat /var/lib/valet/browser/daemon.log", {
        privileged: true,
        target: "browser",
      }),
    );
    throw error;
  } finally {
    await provider.destroy(sandbox.id);
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
