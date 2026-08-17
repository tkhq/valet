// @vitest-environment jsdom
/**
 * What the shell owns: the sidebar's open/closed state, and the drawer that
 * state opens on mobile. It draws none of the controls — the top nav renders
 * those from `useSidebarControls` (see `SidebarControls` for why they are no
 * longer floated over the sidebar).
 *
 * So these tests drive the drawer through that contract rather than through
 * a button the shell no longer has, and assert the drawer still closes on
 * the backdrop, the ✕, and any link inside it (thread selection).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, useSidebarControls } from "./app-shell";

/** Stands in for the real nav: the shell publishes the controls, something
 * else renders them. Also reports what it was given, so the "no sidebar"
 * case can assert the nav is told to draw nothing. */
function NavProbe() {
  const controls = useSidebarControls();
  if (controls === null) return <div>no shell</div>;
  return (
    <div>
      <span data-testid="present">{String(controls.present)}</span>
      <span data-testid="collapsed">{String(controls.collapsed)}</span>
      <button type="button" onClick={controls.openDrawer}>
        open threads
      </button>
      <button type="button" onClick={controls.toggleCollapsed}>
        toggle
      </button>
    </div>
  );
}

function renderShell() {
  return render(
    <AppShell
      topNav={<NavProbe />}
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

describe("AppShell — sidebar controls", () => {
  it("tells the nav there is nothing to control when there is no sidebar", () => {
    render(
      <AppShell topNav={<NavProbe />}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.getByTestId("present").textContent).toBe("false");
  });

  it("publishes the collapsed state and flips it on toggle", async () => {
    renderShell();
    expect(screen.getByTestId("present").textContent).toBe("true");
    expect(screen.getByTestId("collapsed").textContent).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: /toggle/i }));
    expect(screen.getByTestId("collapsed").textContent).toBe("true");
  });

  it("gives no controls outside a shell, so a bare nav can draw no toggle", () => {
    render(<NavProbe />);
    expect(screen.getByText("no shell")).toBeTruthy();
  });
});

describe("AppShell — mobile sidebar drawer", () => {
  it("opens the drawer via the published control, closed by default", async () => {
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
