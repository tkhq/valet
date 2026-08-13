// @vitest-environment jsdom
/**
 * Markdown: a fenced code block renders through CodeBlock (real Prism
 * tokens for a known language, language pulled from the fence's info
 * string), inline code and prose text are unaffected.
 *
 * Link handling has two modes. The default (chat) sends every link to a new
 * tab. With `memoryLinks`, a cross-reference to another memory file
 * navigates in place instead — the memory corpus is written with relative
 * paths between files, which a new tab cannot open.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders prose text", () => {
    render(<Markdown>{"hello **world**"}</Markdown>);
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("tokenizes a fenced code block via CodeBlock", () => {
    const { container } = render(<Markdown>{"```typescript\nconst x = 1;\n```"}</Markdown>);
    expect(container.querySelector(".code-block")).toBeTruthy();
    expect(container.querySelectorAll(".token").length).toBeGreaterThan(0);
  });

  it("leaves inline code as plain text, not a code block", () => {
    const { container } = render(<Markdown>{"use `npm install`"}</Markdown>);
    expect(container.querySelector(".code-block")).toBeNull();
    expect(screen.getByText("npm install")).toBeTruthy();
  });

  it("falls back to plain text for a fence with no recognized language", () => {
    render(<Markdown>{"```cobol\nSOME COBOL\n```"}</Markdown>);
    expect(screen.getByText("SOME COBOL")).toBeTruthy();
  });

  describe("links", () => {
    function anchor(name: string): HTMLAnchorElement {
      const el = screen.getByText(name).closest("a");
      if (!el) throw new Error(`no anchor around '${name}'`);
      return el;
    }

    /** jsdom cannot follow a link and logs an error when a click on a real
     * href keeps its default action. This cancels the default after React's
     * handler has run, which is the behavior under test. */
    function click(link: HTMLAnchorElement, init: { button: number; metaKey?: boolean }): void {
      const cancel = (e: Event) => e.preventDefault();
      document.addEventListener("click", cancel);
      try {
        fireEvent.click(link, init);
      } finally {
        document.removeEventListener("click", cancel);
      }
    }

    it("sends every link to a new tab by default — chat behavior is unchanged", () => {
      render(<Markdown>{"see [docs](https://example.com/x) and [sibling](../people/alice.md)"}</Markdown>);

      expect(anchor("docs").target).toBe("_blank");
      expect(anchor("docs").rel).toBe("noopener noreferrer");
      // No memory context here, so a relative path stays an ordinary link.
      expect(anchor("sibling").target).toBe("_blank");
    });

    it("routes a memory cross-reference in place instead of opening a tab", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "journal/2026-08-12.md", onNavigate }}>
          {"see [alice](../people/alice.md)"}
        </Markdown>,
      );

      const link = anchor("alice");
      expect(link.target).toBe("");
      expect(link.getAttribute("href")).toBe("/memory/people/alice.md");

      click(link, { button: 0 });
      expect(onNavigate).toHaveBeenCalledWith("people/alice.md");
    });

    it("resolves a root-relative cross-reference from the bundle root", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "projects/valet/notes.md", onNavigate }}>
          {"see [prefs](/preferences/style.md#voice)"}
        </Markdown>,
      );

      click(anchor("prefs"), { button: 0 });
      expect(onNavigate).toHaveBeenCalledWith("preferences/style.md");
    });

    it("keeps a genuinely external link in a new tab inside a memory document", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "journal/2026-08-12.md", onNavigate }}>
          {"see [example](https://example.com/x) and [mail](mailto:a@b.test)"}
        </Markdown>,
      );

      // No click here: an external anchor carries no handler at all, and
      // jsdom logs an unimplemented-navigation error if one is dispatched.
      expect(anchor("example").target).toBe("_blank");
      expect(anchor("example").rel).toBe("noopener noreferrer");
      expect(anchor("mail").target).toBe("_blank");
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("keeps an in-page anchor in this tab and does not navigate away", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "journal/2026-08-12.md", onNavigate }}>
          {"jump to [part two](#part-two)"}
        </Markdown>,
      );

      const link = anchor("part two");
      expect(link.target).toBe("");
      expect(link.getAttribute("href")).toBe("#part-two");
      click(link, { button: 0 });
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("leaves a modified click to the browser so cmd-click still opens a tab", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "journal/2026-08-12.md", onNavigate }}>
          {"see [alice](../people/alice.md)"}
        </Markdown>,
      );

      click(anchor("alice"), { button: 0, metaKey: true });
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("encodes each path segment so a spaced filename still routes", () => {
      const onNavigate = vi.fn();
      render(
        <Markdown memoryLinks={{ fromPath: "notes/index.md", onNavigate }}>
          {"see [q3](./q3%20plan.md)"}
        </Markdown>,
      );

      expect(anchor("q3").getAttribute("href")).toBe("/memory/notes/q3%20plan.md");
    });
  });
});
