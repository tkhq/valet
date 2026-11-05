// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EvidenceAnnotations, screenshotSize } from "./evidence-annotations";

const api = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({ id: "saved" }),
}));
vi.mock("~/api/browser", () => ({
  browserApi: {
    evidence: (session: string, id: string) => `/evidence/${session}/${id}`,
    annotationExport: (session: string, artifact: string, annotation: string) =>
      `/export/${session}/${artifact}/${annotation}`,
  },
  useBrowserAnnotations: () => ({
    isPending: false,
    isError: false,
    data: { annotations: [] },
  }),
  useSaveBrowserAnnotation: () => ({ mutateAsync: api.save, isPending: false }),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const evidence = {
  id: "artifact",
  sessionId: "session",
  documentId: "doc",
  filename: "page.png",
  mimeType: "image/png",
  width: 2560,
  height: 1440,
  viewport: {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    scrollX: 0,
    scrollY: 0,
  },
};

describe("saved browser annotations", () => {
  it("uses screenshot-local CSS coordinates for crops and full-page images", () => {
    expect(
      screenshotSize({
        ...evidence,
        clip: { x: 300, y: 100, width: 200, height: 150 },
      }),
    ).toEqual({ width: 200, height: 150 });
    expect(screenshotSize({ ...evidence, height: 2880 })).toEqual({
      width: 1280,
      height: 1440,
    });
  });

  it("adds a labeled pin and saves it against the captured document", async () => {
    render(<EvidenceAnnotations evidence={evidence} />);
    const image = screen.getByRole("button", {
      name: "Place a pin on page.png",
    });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 360),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Pin label" }), {
      target: { value: "Check this field" },
    });
    fireEvent.click(image, { clientX: 320, clientY: 180 });
    fireEvent.click(screen.getByRole("button", { name: "Save annotations" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        documentId: "doc",
        marks: [{ x: 640, y: 360, label: "Check this field" }],
      }),
    );
  });

  it("keeps pins near the last pixel inside the captured image", async () => {
    render(<EvidenceAnnotations evidence={evidence} />);
    const image = screen.getByRole("button", {
      name: "Place a pin on page.png",
    });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 360),
    );
    fireEvent.click(image, { clientX: 639.9, clientY: 359.9 });
    fireEvent.click(screen.getByRole("button", { name: "Save annotations" }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        documentId: "doc",
        marks: [{ x: 1279, y: 719, label: "" }],
      }),
    );
  });
});
