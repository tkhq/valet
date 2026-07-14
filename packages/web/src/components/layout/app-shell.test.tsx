// @vitest-environment jsdom
/**
 * Mobile sidebar drawer toggle. The `md:flex`/`hidden` sidebar has no way
 * to open on mobile without this — verifies the toggle button opens the
 * overlay, and that the backdrop, ✕ button, and clicking a link inside all
 * close it.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";

function renderShell() {
  return render(
    <AppShell
      topNav={<div>nav</div>}
      sidebar={
        <nav>
          <a href="/chat?thread=t1">thread one</a>
        </nav>
      }
    >
      <div>content</div>
    </AppShell>,
  );
}

describe("AppShell — mobile sidebar drawer", () => {
  it("has no toggle button when there is no sidebar", () => {
    render(
      <AppShell topNav={<div>nav</div>}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByRole("button", { name: /open threads/i })).toBeNull();
  });

  it("opens the drawer on toggle click, closed by default", async () => {
    renderShell();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /open threads/i }));
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("closes on the ✕ button", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /open threads/i }));
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on backdrop click", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /open threads/i }));
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.firstElementChild as HTMLElement;
    await userEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when a link inside the drawer is clicked (thread selection)", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /open threads/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("link", { name: /thread one/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
