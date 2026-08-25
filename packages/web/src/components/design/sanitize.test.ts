// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  checkDesignVersion,
  DESIGN_ALLOWED_URI,
  parseSlides,
  sanitizeCssText,
  sanitizeDesignHtml,
} from "./sanitize";

const DOC = (body: string, head = "") =>
  `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe("sanitizeDesignHtml", () => {
  it("strips script tags and on* handlers, keeps content", () => {
    const out = sanitizeDesignHtml(
      DOC(`<h1 data-vdid="a1b2" onclick="alert(1)">Hi</h1><script>alert(2)</script>`),
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert(2)");
    expect(out).toContain("Hi");
  });

  it("strips iframe/object/embed/base/form", () => {
    const out = sanitizeDesignHtml(
      DOC(
        `<iframe src="https://x.test"></iframe><object></object><embed>` +
          `<base href="https://x.test"><form action="https://x.test"><input></form>`,
      ),
    );
    for (const tag of ["<iframe", "<object", "<embed", "<base", "<form"]) {
      expect(out).not.toContain(tag);
    }
  });

  it("preserves data-vdid attributes and <style> blocks", () => {
    const out = sanitizeDesignHtml(
      DOC(`<section data-vdid="e8f7"><h1 data-vdid="a1b2">T</h1></section>`, `<style>h1 { color: var(--color-primary); }</style>`),
    );
    expect(out).toContain(`data-vdid="e8f7"`);
    expect(out).toContain(`data-vdid="a1b2"`);
    expect(out).toContain("<style>");
    expect(out).toContain("var(--color-primary)");
  });

  it("strips external and javascript: URLs, keeps data:/fragment/relative", () => {
    const out = sanitizeDesignHtml(
      DOC(
        `<a href="javascript:alert(1)">j</a>` +
          `<a href="https://evil.test/x">e</a>` +
          `<a href="//evil.test/x">p</a>` +
          `<a href="#section-2">f</a>` +
          `<a href="images/logo.png">r</a>` +
          `<img src="data:image/png;base64,AAAA" alt="d">`,
      ),
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("evil.test");
    expect(out).toContain(`href="#section-2"`);
    expect(out).toContain(`href="images/logo.png"`);
    expect(out).toContain(`src="data:image/png;base64,AAAA"`);
  });
});

describe("sanitizeCssText", () => {
  it("strips @import rules outright (url and string forms)", () => {
    const out = sanitizeCssText(
      `@import url(https://evil.test/a.css);\n@import "https://evil.test/b.css" layer(base);\nh1 { color: red; }`,
    );
    expect(out).not.toContain("@import");
    expect(out).not.toContain("evil.test");
    expect(out).toContain("h1 { color: red; }");
  });

  it("strips an escaped @import (@\\69mport)", () => {
    const out = sanitizeCssText(`@\\69mport "https://evil.test/c.css";`);
    expect(out).not.toContain("evil.test");
    expect(out.toLowerCase()).not.toContain("import");
  });

  it("neutralizes external url() targets, bare and quoted", () => {
    const out = sanitizeCssText(
      `body { background: url(https://tracker.test/x.gif); }
       .a { background: url("//tracker.test/y.gif"); }
       @font-face { font-family: X; src: url('https://evil.test/f.woff2') format('woff2'); }`,
    );
    expect(out).not.toContain("tracker.test");
    expect(out).not.toContain("evil.test");
    expect(out).toContain(`url("")`);
    expect(out).toContain("font-family: X");
  });

  it("neutralizes the src() alias of url()", () => {
    const out = sanitizeCssText(`@font-face { src: src("https://evil.test/f.woff2"); }`);
    expect(out).not.toContain("evil.test");
  });

  it("keeps data:, fragment, and relative url() targets", () => {
    const css =
      `.a { background: url(data:image/png;base64,AAAA); }` +
      `.b { filter: url(#blur); }` +
      `.c { background: url(images/x.png); }` +
      `.d { background: url('./y.png'); }` +
      `.e { background: url("/abs/z.png"); }`;
    const out = sanitizeCssText(css);
    expect(out).toContain("url(data:image/png;base64,AAAA)");
    expect(out).toContain("url(#blur)");
    expect(out).toContain("url(images/x.png)");
    expect(out).toContain("url('./y.png')");
    expect(out).toContain(`url("/abs/z.png")`);
  });

  it("catches escaped-token tricks: u\\rl( and u\\72l(", () => {
    const out = sanitizeCssText(
      `.a { background: u\\rl("https://evil.test/1"); } .b { background: u\\72l(https://evil.test/2); }`,
    );
    expect(out).not.toContain("evil.test");
  });

  it("blocks a scheme split by an escaped control character", () => {
    // \A decodes to a newline in the CSS string; a URL parser strips it,
    // which would re-form https:. The leftover escape is grounds to strip.
    const out = sanitizeCssText(`.a { background: url("http\\A s://evil.test/x"); }`);
    expect(out).not.toContain("evil.test");
  });

  it("removes comments before scanning, so they cannot hide a target", () => {
    const out = sanitizeCssText(`.a { background: url(/* hide */ "https://evil.test/x"); }`);
    expect(out).not.toContain("evil.test");
  });

  it("neutralizes external bare strings inside image-set(), keeps local ones", () => {
    const out = sanitizeCssText(
      `.a { background-image: image-set("https://evil.test/x.png" 1x, "img/local.png" 2x); }`,
    );
    expect(out).not.toContain("evil.test");
    expect(out).toContain(`"img/local.png"`);
  });
});

describe("sanitizeDesignHtml css integration", () => {
  it("sanitizes <style> element text: @import and external url() are gone", () => {
    const out = sanitizeDesignHtml(
      DOC(
        `<h1>T</h1>`,
        `<style>@import url(https://evil.test/a.css); h1 { background: url(https://tracker.test/x.gif); color: teal; }</style>`,
      ),
    );
    expect(out).toContain("<style>");
    expect(out).not.toContain("@import");
    expect(out).not.toContain("evil.test");
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("color: teal");
  });

  it("sanitizes style attributes: external url() neutralized, rest kept", () => {
    const out = sanitizeDesignHtml(
      DOC(`<div style="background:url(https://tracker.test/p.gif);color:red">x</div>`),
    );
    // The url target is emptied; the serializer entity-encodes its quotes.
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("color:red");
    expect(out).toMatch(/url\((?:&quot;){2}\)/);
  });

  it("keeps data:/relative/fragment urls in style text and attributes", () => {
    const out = sanitizeDesignHtml(
      DOC(
        `<div style="background:url(data:image/png;base64,AAAA)">x</div>`,
        `<style>.hero { background: url(images/bg.png); clip-path: url(#clip); }</style>`,
      ),
    );
    expect(out).toContain("url(data:image/png;base64,AAAA)");
    expect(out).toContain("url(images/bg.png)");
    expect(out).toContain("url(#clip)");
  });
});

describe("DESIGN_ALLOWED_URI", () => {
  it("permits data:, fragments, and scheme-less relative paths only", () => {
    for (const ok of ["data:image/png;base64,AAAA", "#top", "a/b.png", "./x", "/root.css"]) {
      expect(DESIGN_ALLOWED_URI.test(ok)).toBe(true);
    }
    for (const bad of ["javascript:alert(1)", "https://x.test", "//x.test", "vbscript:x"]) {
      expect(DESIGN_ALLOWED_URI.test(bad)).toBe(false);
    }
  });
});

describe("checkDesignVersion", () => {
  it("accepts v=1 and documents without the meta tag", () => {
    expect(
      checkDesignVersion(DOC("", `<meta name="valet-design" content="v=1; template=slides">`)),
    ).toEqual({ ok: true });
    expect(checkDesignVersion(DOC(""))).toEqual({ ok: true });
  });

  it("refuses unknown versions", () => {
    expect(
      checkDesignVersion(DOC("", `<meta name="valet-design" content="v=2; template=slides">`)),
    ).toEqual({ ok: false, version: "2" });
  });
});

describe("parseSlides", () => {
  it("extracts index, vdid, heading, and speaker notes per top-level section", () => {
    const sanitized = sanitizeDesignHtml(
      DOC(
        `<section data-vdid="s1"><h1>Pitch Deck</h1><aside>Welcome slide.</aside></section>` +
          `<section data-vdid="s2"><h2>The Problem</h2><p>x</p></section>`,
      ),
    );
    const slides = parseSlides(sanitized);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({
      index: 0,
      vdid: "s1",
      heading: "Pitch Deck",
      notes: "Welcome slide.",
    });
    expect(slides[1]).toMatchObject({ index: 1, vdid: "s2", heading: "The Problem", notes: "" });
  });

  it("labels a heading-less slide by position", () => {
    const slides = parseSlides(sanitizeDesignHtml(DOC(`<section><p>text only</p></section>`)));
    expect(slides[0].heading).toBe("Slide 1");
  });
});

describe("parseSlides wrapper tolerance", () => {
  it("finds outermost sections nested inside a wrapper div", () => {
    const html = `<div class="deck"><section data-vdid="aaa"><h2>One</h2><aside>n1</aside></section><section data-vdid="bbb"><h2>Two</h2></section></div>`;
    const slides = parseSlides(html);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({ vdid: "aaa", heading: "One", notes: "n1" });
    expect(slides[1]).toMatchObject({ vdid: "bbb", heading: "Two" });
  });

  it("ignores sections nested inside other sections", () => {
    const html = `<section data-vdid="outer"><h2>Outer</h2><section data-vdid="inner"><h3>Inner</h3></section></section>`;
    const slides = parseSlides(html);
    expect(slides).toHaveLength(1);
    expect(slides[0].vdid).toBe("outer");
  });
});
