/**
 * `fullstack-k8s` step: run the shared full-stack scenario against the helm
 * deployment on the local rancher-desktop cluster. Sessions become Sandbox
 * CRs + pods (VALET_SANDBOX_BACKEND=kubernetes via the chart).
 *
 * SAFETY (binding, see CLAUDE.md): every kubectl/helm invocation here pins
 * `--context rancher-desktop` — the ambient kubectl context on a dev machine
 * can be a PRODUCTION cluster and must never be touched. `make k8s-*`
 * targets already pin it; the direct kubectl calls below pin it themselves.
 *
 * Flow: ensure sandbox controller → ensure images (skip the 15-20 min build
 * when both :dev images exist) → helm up → rollout wait → port-forward on a
 * random local port → runScenario → kill port-forward. The helm release is
 * left installed (teardown is a deliberate separate step: `make k8s-down`).
 * Exit 0/1.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./fullstack-scenario.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CTX = "rancher-desktop";
// Dedicated release + namespace: the dev `valet` release's retained DB
// requires invites for signups, so the e2e stack gets its own. First deploy
// = fresh PVC = our sign-up is the first-ever signup (auto-admin); retained
// re-runs fall back to sign-in with the same creds.
const NS = "valet-e2e";
const RELEASE = "valet-e2e";
const LOCAL_PORT = 18890 + Math.floor(Math.random() * 100);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

function run(label: string, cmd: string, args: string[], timeoutMs: number): void {
  console.log(`[fullstack-k8s] ${label}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", timeout: timeoutMs });
  if (r.status !== 0) {
    console.error(`[fullstack-k8s] ${label} failed (exit ${r.status ?? "timeout"})`);
    process.exit(1);
  }
}

function imagesPresent(): boolean {
  const r = spawnSync("docker", ["image", "inspect", "valet-api:dev", "valet-sandbox:dev"], {
    stdio: "ignore",
    timeout: 30_000,
  });
  return r.status === 0;
}

async function main(): Promise<number> {
  // 1. Sandbox controller CRD/controller (idempotent).
  run("sandbox controller", "make", ["k8s-sandbox-install"], 5 * 60_000);

  // 2. Images (cold build is 15-20 min; skip when both exist).
  // VALET_E2E_K8S_REBUILD=1 forces the build — otherwise Dockerfile drift
  // hides behind stale :dev images.
  if (imagesPresent() && process.env.VALET_E2E_K8S_REBUILD !== "1") {
    console.log("[fullstack-k8s] images valet-api:dev + valet-sandbox:dev present — skipping k8s-build");
  } else {
    run("image build", "make", ["k8s-build"], 40 * 60_000);
  }

  // 3. Deploy + wait for the api rollout.
  // The dev release owns the cluster-scoped valet-sandboxes namespace, so the
  // e2e release brings its own sandbox namespace too.
  run("helm up", "make", [
    "k8s-up",
    `HELM_RELEASE=${RELEASE}`,
    `K8S_NAMESPACE=${NS}`,
    // registry.bundled=false: the dev release already claims NodePort 30500,
    // and the e2e scenario never builds prebuilt images.
    `HELM_EXTRA_ARGS=--set sandbox.namespace=${NS}-sandboxes --set registry.bundled=false`,
  ], 10 * 60_000);
  run("rollout", "kubectl", [
    "--context", CTX, "-n", NS,
    "rollout", "status", `deploy/${RELEASE}-api`, "--timeout=300s",
  ], 6 * 60_000);

  // 4. Port-forward svc/valet-api on a random local port.
  const pf = spawn("kubectl", [
    "--context", CTX, "-n", NS,
    "port-forward", `svc/${RELEASE}-api`, `${LOCAL_PORT}:80`,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const killPf = (): void => {
    if (pf.pid) {
      try {
        process.kill(-pf.pid, "SIGKILL");
      } catch {}
    }
  };

  try {
    // Wait for the tunnel.
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        const res = await fetch(`http://localhost:${LOCAL_PORT}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        up = res.ok;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (!up) throw new Error("port-forward did not become healthy within 30s");

    // The chart deploys REAL better-auth (no local-auth stub), so
    // authenticate first: sign up a deterministic e2e user (first-ever signup
    // is auto-admin), falling back to sign-in when the retained release
    // already has it from a previous run.
    const base = `http://localhost:${LOCAL_PORT}`;
    const creds = { email: "e2e@valet.test", password: "e2e-fullstack-password" };
    // better-auth CSRF check requires a trusted Origin on auth POSTs;
    // http://localhost:5173 is always in trustedOrigins (auth/config.ts).
    const authHeaders = { "Content-Type": "application/json", origin: "http://localhost:5173" };
    let authRes = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "E2E Fullstack", ...creds }),
    });
    if (!authRes.ok) {
      const signUpDetail = `sign-up ${authRes.status}: ${await authRes.text()}`;
      authRes = await fetch(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(creds),
      });
      if (!authRes.ok) {
        throw new Error(
          `auth failed — ${signUpDetail}; sign-in ${authRes.status}: ${await authRes.text()}`,
        );
      }
    }
    const cookie = authRes.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    if (cookie === "") throw new Error("auth succeeded but no session cookie was set");

    // 5. The shared scenario; in-cluster sessions use the image's workspace
    // convention and get a generous turn budget (pod scheduling + image pull).
    const { sessionId } = await runScenario({
      baseUrl: base,
      headers: { cookie },
      workspace: "/workspace/e2e",
      turnTimeoutMs: 10 * 60_000,
    });
    // Delete the session so its Sandbox CR + pod don't accumulate in the
    // retained e2e release across runs.
    const del = await fetch(`${base}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    console.log(`[fullstack-k8s] session cleanup: ${del.status}`);
    console.log("[fullstack-k8s] PASS (release left installed; remove with `make k8s-down HELM_RELEASE=valet-e2e K8S_NAMESPACE=valet-e2e`)");
    return 0;
  } catch (err) {
    console.error(`[fullstack-k8s] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    killPf();
  }
}

main().then((code) => process.exit(code));
