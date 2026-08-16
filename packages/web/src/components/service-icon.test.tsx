// @vitest-environment jsdom
/**
 * `ServiceIcon`: real brand marks where the upstream set has one, the
 * initial-letter monogram where it does not.
 *
 * The bug this guards: every card printed one letter, so GitHub, Gmail,
 * Google Calendar, Google Docs, Google Drive, and Google Sheets were six
 * identical circles. The first test therefore compares the RENDERED PATH
 * DATA across those services — same-looking marks would fail it.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ServiceIcon, brandHex, brandMark } from "./service-icon";

/** The `d` of the single path a mark draws, or null when the icon fell back
 * to the monogram. */
function markPath(container: HTMLElement): string | null {
  return container.querySelector("svg path")?.getAttribute("d") ?? null;
}

describe("ServiceIcon brand marks", () => {
  it("draws a different mark for every service that shares an initial", () => {
    const slugs = ["github", "gmail", "google-calendar", "google-docs", "google-drive", "google-sheets"];
    const paths = slugs.map((slug) => {
      const { container } = render(<ServiceIcon slug={slug} label={slug} />);
      const path = markPath(container);
      expect(path, `${slug} has no mark`).toBeTruthy();
      return path;
    });
    expect(new Set(paths).size).toBe(slugs.length);
  });

  it("draws the mark in currentColor so it follows the theme", () => {
    const { container } = render(<ServiceIcon slug="github" label="GitHub" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    // No inline background either: a mark tile takes theme tokens, and only
    // the monogram fallback paints a brand hue.
    expect(container.querySelector("span")?.getAttribute("style")).toBeNull();
  });

  it("hides the icon from assistive technology, which reads the name beside it", () => {
    const { container } = render(<ServiceIcon slug="linear" label="Linear" />);
    expect(container.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps a plugin id with no declared slug of its own", () => {
    // `google-workspace` reaches Drive, Docs, and Sheets through one
    // credential; the card falls back to the plugin id when the wire ships
    // no slug.
    expect(brandMark("google-workspace")).toBeDefined();
    expect(brandMark("google-workspace")?.path).toBe(brandMark("google-drive")?.path);
  });
});

describe("ServiceIcon monogram fallback", () => {
  it("falls back to the initial for a service the upstream set has no mark for", () => {
    // Slack, Typefully, and DeepWiki have no mark in `simple-icons`.
    const { container } = render(<ServiceIcon slug="slack" label="Slack" />);
    expect(markPath(container)).toBeNull();
    expect(container.textContent).toBe("S");
  });

  it("falls back for an unknown slug and for no slug at all", () => {
    const unknown = render(<ServiceIcon slug="acme-tickets" label="Acme tickets" />);
    expect(markPath(unknown.container)).toBeNull();
    expect(unknown.container.textContent).toBe("A");

    const none = render(<ServiceIcon label="Deploy notes" />);
    expect(markPath(none.container)).toBeNull();
    expect(none.container.textContent).toBe("D");
  });

  it("paints a hue behind the letter, and a different hue per service", () => {
    // jsdom reports the computed `rgb(...)`, so read the two tiles against
    // each other rather than against the source hex.
    const slack = render(<ServiceIcon slug="slack" label="Slack" />);
    const typefully = render(<ServiceIcon slug="typefully" label="Typefully" />);
    const hue = (root: HTMLElement) => root.querySelector("span")?.style.backgroundColor;
    expect(hue(slack.container)).toBeTruthy();
    expect(hue(slack.container)).not.toBe(hue(typefully.container));
    // Unknown ids hash into the fallback palette — stable across renders.
    expect(brandHex("acme-tickets")).toBe(brandHex("acme-tickets"));
    expect(brandHex("slack")).toBe("#611f69");
  });

  it("keeps the accent tone free of any brand mark", () => {
    // A stored skill belongs to no vendor, so it takes the accent tile even
    // when its name collides with a brand slug.
    const { container } = render(<ServiceIcon slug="github" label="Github notes" tone="accent" />);
    expect(markPath(container)).toBeNull();
    expect(container.querySelector("span")?.className).toContain("bg-moss");
  });
});
