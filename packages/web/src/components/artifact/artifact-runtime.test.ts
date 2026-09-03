// @vitest-environment jsdom
/**
 * Executes the shell's comment runtime (`ARTIFACT_RUNTIME_JS`) in jsdom and
 * drives it over the real postMessage channel. In jsdom `window.parent` is
 * the window itself, so the runtime's posts loop back to this test's
 * listener — the same wire `ArtifactFrame` reads in the browser.
 *
 * This is the executable proof the inline script PARSES and boots: it ships
 * as a string, so a stray escape in the TS template literal would otherwise
 * only fail at view time.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARTIFACT_RUNTIME_JS } from "@valet/shared";

type BridgeMessage = { type: string } & Record<string, unknown>;

const received: BridgeMessage[] = [];

function collect(e: MessageEvent) {
  const data: unknown = e.data;
  if (typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string") {
    received.push(data as BridgeMessage);
  }
}

async function flush(): Promise<void> {
  // postMessage delivery + the runtime's requestAnimationFrame throttle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(type: string): Promise<BridgeMessage> {
  for (let i = 0; i < 20; i++) {
    const found = received.find((m) => m.type === type);
    if (found) return found;
    await flush();
  }
  throw new Error(`no ${type} message arrived; got: ${received.map((m) => m.type).join(", ")}`);
}

beforeAll(() => {
  window.addEventListener("message", collect);
  document.body.innerHTML = `
    <h1>Scorecard</h1>
    <p>Reasoning effort beats model tier.</p>
    <p>Reasoning effort beats model tier.</p>
    <section data-vdid="preexisting-design-id"><p>From a design revision</p></section>
    <div>direct text div</div>
    <div><span>no direct text</span></div>
  `;
  // The runtime is an IIFE; executing it IS the parse test.
  new Function(ARTIFACT_RUNTIME_JS)();
});

afterEach(() => {
  received.length = 0;
});

describe("artifact comment runtime", () => {
  it("boots, posts ready, and assigns deterministic distinct vdids", async () => {
    await waitFor("valet-artifact:ready");

    const h1 = document.querySelector("h1");
    expect(h1?.getAttribute("data-vdid")).toMatch(/^[0-9a-f]{16}$/);

    // Two identical paragraphs must get DISTINCT ids (occurrence counter).
    const [p1, p2] = [...document.querySelectorAll("p")].slice(0, 2);
    expect(p1?.getAttribute("data-vdid")).toBeTruthy();
    expect(p2?.getAttribute("data-vdid")).toBeTruthy();
    expect(p1?.getAttribute("data-vdid")).not.toBe(p2?.getAttribute("data-vdid"));

    // A published design revision arrives with its own ids — preserved.
    expect(document.querySelector("section")?.getAttribute("data-vdid")).toBe("preexisting-design-id");

    // Divs are addressable only with direct text.
    const divs = [...document.querySelectorAll("div")];
    expect(divs[0]?.getAttribute("data-vdid")).toBeTruthy();
    expect(divs[1]?.hasAttribute("data-vdid")).toBe(false);
  });

  it("reports rects for requested anchors that exist, and omits the rest", async () => {
    const vdid = document.querySelector("h1")?.getAttribute("data-vdid") ?? "";
    window.postMessage({ type: "valet-artifact:anchors", vdids: [vdid, "0000000000000000"] }, "*");
    const msg = await waitFor("valet-artifact:rects");
    const rects = msg.rects as Record<string, { top: number }>;
    expect(Object.keys(rects)).toEqual([vdid]);
    expect(typeof rects[vdid]?.top).toBe("number");
  });

  it("in pick mode, a click posts the element's vdid and text label", async () => {
    window.postMessage({ type: "valet-artifact:mode", picking: true }, "*");
    await flush();

    const h1 = document.querySelector("h1") as HTMLElement;
    h1.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const pick = await waitFor("valet-artifact:pick");
    expect(pick.vdid).toBe(h1.getAttribute("data-vdid"));
    expect(pick.label).toBe("Scorecard");

    // Out of pick mode, clicks are the page's own business again.
    window.postMessage({ type: "valet-artifact:mode", picking: false }, "*");
    await flush();
    received.length = 0;
    h1.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(received.find((m) => m.type === "valet-artifact:pick")).toBeUndefined();
  });
});
