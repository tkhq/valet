/**
 * Client-side full-stack scenario shared by `fullstack-docker` and
 * `fullstack-k8s` (spec: docs/specs/2026-07-25-e2e-runner-design.md). Talks
 * ONLY the public HTTP/WS surface — the same wire contract the web client and
 * CLI use — so the two stack variants cannot drift apart.
 *
 * Flow: health-check → create session → WS subscribe → prompt the agent to
 * write a marker file → wait for turn_end → assert a non-empty assistant
 * reply via GET /messages. Throws on any failure.
 */

export interface ScenarioOpts {
  baseUrl: string;
  /** Extra headers (e.g. x-api-key) for HTTP calls. */
  headers?: Record<string, string>;
  /** Workspace path to request for the session (server-side path). */
  workspace?: string;
  /** Overall turn deadline. Default 180s. */
  turnTimeoutMs?: number;
}

interface WireEventish {
  type: string;
  [key: string]: unknown;
}

export async function runScenario(opts: ScenarioOpts): Promise<void> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", ...opts.headers };
  const workspace = opts.workspace ?? "/tmp/valet-e2e-fullstack/ws";
  const turnTimeoutMs = opts.turnTimeoutMs ?? 180_000;

  // 1. Health.
  const health = await fetch(`${base}/api/health`, { headers });
  if (!health.ok) throw new Error(`health check failed: ${health.status}`);
  console.log(`[fullstack] health ok (${base})`);

  // 2. Create session.
  const createRes = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace }),
  });
  if (!createRes.ok) {
    throw new Error(`create session failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { id: sessionId } = (await createRes.json()) as { id: string };
  console.log(`[fullstack] session: ${sessionId}`);

  // 3-4. WS subscribe, prompt on init, wait for turn_end.
  const wsUrl = `${base.replace(/^http/, "ws")}/api/sessions/${sessionId}/ws`;
  const ws = new WebSocket(wsUrl);
  const prompt = "use bash to write fullstack.txt with contents ok then read it back";

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout: no turn_end within ${turnTimeoutMs / 1000}s`));
    }, turnTimeoutMs);
    ws.onmessage = async (ev) => {
      const e = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as WireEventish;
      if (e.type === "init") {
        const r = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text: prompt }),
        });
        if (!r.ok) {
          clearTimeout(t);
          ws.close();
          reject(new Error(`send prompt failed: ${r.status}`));
          return;
        }
        console.log(`[fullstack] prompt posted (${r.status})`);
      }
      if (e.type === "tool_end") console.log(`[fullstack] tool_end isError=${String(e.isError)}`);
      if (e.type === "error") console.error(`[fullstack] wire error: ${String(e.message)}`);
      if (e.type === "turn_end") {
        clearTimeout(t);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
  console.log("[fullstack] turn ended");

  // 5. Assert a non-empty assistant reply exists. The final assistant entry
  // persists on message_end, which can land moments after turn_end — poll
  // briefly rather than racing it.
  interface WireMessage {
    role: string;
    content?: string;
    parts?: { kind: string; text?: string }[];
  }
  let assistantText = "";
  let lastPayload: WireMessage[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const msgsRes = await fetch(`${base}/api/sessions/${sessionId}/messages`, { headers });
    if (!msgsRes.ok) throw new Error(`list messages failed: ${msgsRes.status}`);
    const { messages } = (await msgsRes.json()) as { messages: WireMessage[] };
    lastPayload = messages;
    const assistant = messages.filter((m) => m.role === "assistant");
    const partsText = assistant
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("");
    const contentText = assistant.map((m) => m.content ?? "").join("");
    assistantText = (partsText + contentText).trim();
    if (assistantText !== "") break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (assistantText === "") {
    const sample = JSON.stringify(lastPayload).slice(0, 2000);
    throw new Error(`no assistant text in GET /messages; payload: ${sample}`);
  }
  console.log(`[fullstack] assistant reply length: ${assistantText.length}`);
}
