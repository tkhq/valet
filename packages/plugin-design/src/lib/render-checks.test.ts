import { describe, expect, it } from "vitest";
import { hidesSectionsByDefault, staticRenderChecks } from "./render-checks.js";

const REVEAL_DECK = `<html><head><style>
  section { position: absolute; width: 100%; opacity: 0; pointer-events: none; }
  section.active { opacity: 1; position: relative; }
</style></head>
<body>
  <section class="active"><h1>One</h1></section>
  <section><h2>Two</h2></section>
  <script>document.addEventListener("keydown", () => {});</script>
</body></html>`;

const CLEAN_DECK = `<html><head><style>
  section { width: 100%; aspect-ratio: 16/9; padding: 2rem; }
</style></head>
<body><section><h1>One</h1></section></body></html>`;

describe("static render checks", () => {
  it("flags the reveal-deck pattern: scripts + sections hidden by default", () => {
    const notes = staticRenderChecks(REVEAL_DECK);
    expect(notes.join(" ")).toContain("NEVER run");
    expect(notes.join(" ")).toContain("hides <section> elements by default");
  });

  it("flags inline event handlers", () => {
    const notes = staticRenderChecks('<body><button onclick="go()">x</button></body>');
    expect(notes.join(" ")).toContain("event handler");
  });

  it("stays silent for a statically visible document", () => {
    expect(staticRenderChecks(CLEAN_DECK)).toEqual([]);
  });

  it("hidesSectionsByDefault ignores class-scoped hiding rules", () => {
    // Hiding only a CLASS of sections (e.g. section.backup) is a styling
    // choice, not the reveal pattern — the bare `section` rule is.
    expect(
      hidesSectionsByDefault("<style>section.backup { display: none; }</style>"),
    ).toBe(false);
    expect(hidesSectionsByDefault("<style>section { opacity: 0; }</style>")).toBe(true);
    // opacity: 0.9 is not hidden.
    expect(hidesSectionsByDefault("<style>section { opacity: 0.9; }</style>")).toBe(false);
  });
});
