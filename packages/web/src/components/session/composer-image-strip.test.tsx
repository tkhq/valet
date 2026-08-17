// @vitest-environment jsdom
/**
 * Preview and removal for held composer images, plus the refusal notice.
 * Both controls are named after the file they act on, so a screen reader
 * user can tell two attached pictures apart.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ComposerImageErrors, ComposerImageStrip } from "./composer-image-strip";
import type { ComposerImage } from "./composer-images";

function image(name: string, id: string): ComposerImage {
  return {
    id,
    name,
    mimeType: "image/png",
    bytes: 2048,
    dataUrl: `data:image/png;base64,${id}`,
  };
}

describe("ComposerImageStrip", () => {
  it("renders nothing while no image is held", () => {
    const { container } = render(<ComposerImageStrip images={[]} onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows one thumbnail per image, sourced from its data URL", () => {
    render(
      <ComposerImageStrip
        images={[image("chart.png", "img-1"), image("logo.png", "img-2")]}
        onRemove={vi.fn()}
      />,
    );
    const chart = screen.getByAltText("chart.png") as HTMLImageElement;
    expect(chart.src).toBe("data:image/png;base64,img-1");
    expect(screen.getByAltText("logo.png")).toBeDefined();
  });

  it("labels the thumbnail with the file name and size", () => {
    render(<ComposerImageStrip images={[image("chart.png", "img-1")]} onRemove={vi.fn()} />);
    expect(screen.getByAltText("chart.png").getAttribute("title")).toBe("chart.png — 2 KB");
  });

  it("removes by id, so the right image goes when two are held", () => {
    const onRemove = vi.fn();
    render(
      <ComposerImageStrip
        images={[image("chart.png", "img-1"), image("logo.png", "img-2")]}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove logo.png" }));
    expect(onRemove).toHaveBeenCalledWith("img-2");
  });
});

describe("ComposerImageErrors", () => {
  it("renders nothing without messages", () => {
    const { container } = render(<ComposerImageErrors messages={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces every refusal", () => {
    render(
      <ComposerImageErrors
        messages={["a.heic is not a supported image.", "b.png is 9 MB."]}
        onDismiss={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("a.heic is not a supported image.");
    expect(alert.textContent).toContain("b.png is 9 MB.");
  });

  it("dismisses on request", () => {
    const onDismiss = vi.fn();
    render(<ComposerImageErrors messages={["a.heic is not supported."]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss image errors" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
