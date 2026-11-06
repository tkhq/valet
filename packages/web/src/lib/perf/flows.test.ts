// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flowForNavigation, interactionName } from "./flows";

describe("flowForNavigation", () => {
  const at = (pathname: string, search: Record<string, unknown> = {}) => ({ pathname, search });

  it("names a thread link as opening a thread, even across spaces", () => {
    expect(flowForNavigation(at("/"), at("/chat", { thread: "t1" }))).toBe("thread.open");
    expect(flowForNavigation(at("/chat", { workspace: "user", thread: "t1" }), at("/chat", { workspace: "team-a", thread: "t2" }))).toBe("thread.open");
  });

  it("names a space name as switching space, on the same page or into Threads", () => {
    expect(flowForNavigation(at("/workflows", { workspace: "user" }), at("/workflows", { workspace: "team-a" }))).toBe("space.switch");
    expect(flowForNavigation(at("/"), at("/chat", { workspace: "team-a" }))).toBe("space.switch");
  });

  it("names a space's page by the page", () => {
    expect(flowForNavigation(at("/"), at("/workflows", { workspace: "team-a" }))).toBe("workflows.open");
    expect(flowForNavigation(at("/workflows"), at("/presence/"))).toBe("presence.open");
    expect(flowForNavigation(at("/"), at("/settings/integrations"))).toBe("integrations.open");
    expect(flowForNavigation(at("/settings/teams/t1"), at("/settings/teams/t1/integrations"))).toBe("integrations.open");
  });

  it("names the phone Tasks tab, and any other route by its path", () => {
    expect(flowForNavigation(at("/"), at("/", { view: "tasks" }))).toBe("tasks.open");
    expect(flowForNavigation(at("/"), at("/usage"))).toBe("route:/usage");
  });
});

describe("interactionName", () => {
  function render(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body;
  }

  it("prefers data-perf-flow, then the control's role and label", () => {
    const body = render(`<button data-perf-flow="tasks.open"><span id="in">Tasks</span></button><a href="/x" id="a">Open <b>x</b></a><p id="p">text</p>`);
    expect(interactionName(body.querySelector("#in"), "click")).toEqual({ name: "tasks.open", tagged: true });
    expect(interactionName(body.querySelector("#a"), "click")).toEqual({ name: "a:Open x", tagged: false });
    expect(interactionName(body.querySelector("#p"), "click")).toBeUndefined();
  });

  it("credits Enter in a form field to the form's tagged submit control, and skips typing", () => {
    const body = render(`<form><textarea id="t"></textarea><button type="submit" data-perf-flow="message.send">Send</button></form>`);
    const field = body.querySelector("#t");
    expect(interactionName(field, "keydown", "Enter")).toEqual({ name: "message.send", tagged: true });
    expect(interactionName(field, "keydown", "a")).toBeUndefined();
  });

  it("ignores presses on the overlay itself", () => {
    const body = render(`<div data-perf-overlay><button id="b">Clear</button></div>`);
    expect(interactionName(body.querySelector("#b"), "click")).toBeUndefined();
  });
});
