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
import { ARTIFACT_DS_RUNTIME_JS, ARTIFACT_RUNTIME_JS } from "@valet/shared";

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
  // The runtimes are IIFEs; executing them IS the parse test.
  new Function(ARTIFACT_RUNTIME_JS)();
  new Function(ARTIFACT_DS_RUNTIME_JS)();
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

  it("valetDS themes charts from CSS variables, page overrides first", () => {
    interface ValetDS {
      token: (name: string) => string;
      palette: string[];
      textColor: string;
      applyChartTheme: (chart: {
        defaults: { color?: string; borderColor?: string; font: { family?: string } };
        register: (plugin: { id: string; beforeUpdate: (chart: unknown) => void }) => void;
      }) => void;
      echartsTheme: () => { color: string[] };
    }
    const ds = (window as unknown as { valetDS: ValetDS }).valetDS;
    expect(ds).toBeDefined();

    // The shell's defaults are absent in jsdom (no injected base sheet), so
    // set both layers explicitly and check precedence: --ds-* wins.
    document.documentElement.style.setProperty("--artifact-chart-1", "#111111");
    document.documentElement.style.setProperty("--ds-chart-1", "#4c48ff");
    document.documentElement.style.setProperty("--artifact-chart-2", "#222222");
    expect(ds.token("chart-1")).toBe("#4c48ff");
    expect(ds.token("chart-2")).toBe("#222222");
    expect(ds.palette).toEqual(["#4c48ff", "#222222"]);

    // The Chart.js adapter sets defaults and registers the color plugin,
    // which assigns palette colors only to datasets that picked none.
    const registered: Array<{ id: string; beforeUpdate: (chart: unknown) => void }> = [];
    const fakeChart = {
      defaults: { font: {} } as { color?: string; borderColor?: string; font: { family?: string } },
      register: (plugin: { id: string; beforeUpdate: (chart: unknown) => void }) => {
        registered.push(plugin);
      },
    };
    ds.applyChartTheme(fakeChart);
    expect(registered.map((p) => p.id)).toEqual(["valet-ds-colors"]);
    const datasets = [{ backgroundColor: undefined }, { backgroundColor: "#custom" }, {}];
    registered[0]?.beforeUpdate({ data: { datasets } });
    expect(datasets[0]?.backgroundColor).toBe("#4c48ff");
    expect(datasets[1]?.backgroundColor).toBe("#custom");
    // Index 2 wraps the two-color palette back to the first color.
    expect((datasets[2] as { backgroundColor?: string }).backgroundColor).toBe("#4c48ff");

    expect(ds.echartsTheme().color).toEqual(["#4c48ff", "#222222"]);
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

  it("stamps and clears data-theme on the theme message", async () => {
    window.postMessage({ type: "valet-artifact:theme", theme: "dark" }, "*");
    await flush();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    window.postMessage({ type: "valet-artifact:theme", theme: null }, "*");
    await flush();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
