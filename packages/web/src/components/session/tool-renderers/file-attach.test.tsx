// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fileAttachRenderer, parseFileDownload } from "./file-attach";
import { pickRenderer } from "./index";

afterEach(cleanup);
const file = { name: "Revised report.docx", url: "/api/sessions/session-1/threads/thread-1/files/abc-123" };

describe("file download result", () => {
  it.each([
    JSON.stringify(file),
    { text: JSON.stringify(file) },
    { content: [{ type: "text", text: JSON.stringify(file) }] },
  ])("keeps the download usable across live and persisted result shapes", (result) => {
    const Body = fileAttachRenderer.Body;
    render(<Body args={{ path: "/workspace/report.docx" }} result={result} status="completed" toolName="file_attach" />);
    const link = screen.getByRole("link", { name: "Download Revised report.docx" });
    expect(link.getAttribute("href")).toBe(file.url);
    expect(link.getAttribute("download")).toBe(file.name);
    expect(pickRenderer("file_attach")).toBe(fileAttachRenderer);
  });

  it.each([
    (url: string) => JSON.stringify({ ...file, url }),
    (url: string) => ({ text: JSON.stringify({ ...file, url }) }),
    (url: string) => ({ content: [{ type: "text", text: JSON.stringify({ ...file, url }) }] }),
  ])("renders same-origin absolute links after persistence", wrap => {
    const url = `${window.location.origin}${file.url}`;
    const Body = fileAttachRenderer.Body;
    render(<Body args={{}} result={wrap(url)} status="completed" toolName="file_attach" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(url);
  });

  it.each(["https://other.test/api/sessions/s/threads/t/files/id", "https://user:pass@valet.test/api/sessions/s/threads/t/files/id", "/api/sessions/s/threads/t/files/id?redirect=evil", "/api/sessions/s/threads/t/files/id#evil"])("rejects untrusted download URLs: %s", url => {
    expect(parseFileDownload({ text: JSON.stringify({ ...file, url }) }, "https://valet.test")).toBeNull();
  });

  it.each(["javascript:alert(1)", "https://other.test/file", "//other.test/file", "/api/artifacts/share"])('does not turn %s into a download', (url) => {
    expect(parseFileDownload({ text: JSON.stringify({ ...file, url }) })).toBeNull();
  });

  it("uses the authenticated local path when viewed through another deployment alias", () => {
    expect(parseFileDownload({ text: JSON.stringify({ ...file, url: "https://canonical.test" + file.url, webUrl: file.url }) }, "https://alias.test"))
      .toEqual({ name: file.name, url: file.url });
    expect(parseFileDownload({ text: JSON.stringify({ ...file, webUrl: "//evil.test" + file.url }) }, "https://alias.test")).toBeNull();
  });

  it("shows a failed attachment without a download link", () => {
    const Body = fileAttachRenderer.Body;
    render(<Body args={{}} result={undefined} status="error" error="File missing. Create the file and retry." toolName="file_attach" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("File missing. Create the file and retry.")).toBeTruthy();
  });
});

describe("image results", () => {
  const image = { id: "abc-123", name: "signups.png", mimeType: "image/png", bytes: 5, url: file.url, alt: "Signups rose each week", title: "Weekly signups" };

  it.each(["file_attach", "render_diagram"])("%s shows the image inline with a lightbox and a download", (toolName) => {
    expect(pickRenderer(toolName)).toBe(fileAttachRenderer);
    const Preview = fileAttachRenderer.Preview;
    if (!Preview) throw new Error("missing preview");
    render(<Preview args={{}} result={{ content: [{ type: "text", text: JSON.stringify(image) }] }} status="completed" toolName={toolName} />);
    const thumbnail = screen.getByRole("img", { name: "Signups rose each week" });
    expect(thumbnail.getAttribute("src")).toBe(file.url);
    // Fits a 375px phone column: never wider than its container.
    expect(thumbnail.className).toContain("max-w-full");
    expect(thumbnail.className).toContain("h-auto");
    expect(screen.getByText("Weekly signups")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download signups.png" }).getAttribute("download")).toBe("signups.png");

    fireEvent.click(screen.getByRole("button", { name: "View Weekly signups full size" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img", { name: "Signups rose each week" }).getAttribute("src")).toBe(file.url);
    expect(within(dialog).getByRole("link", { name: "Download signups.png" })).toBeTruthy();
  });

  it("falls back to the filename for alt text, and keeps a non-image file a plain download", () => {
    expect(parseFileDownload({ text: JSON.stringify({ ...image, alt: undefined, title: undefined }) })).toEqual({ name: "signups.png", url: file.url, image: { alt: "signups.png" } });
    expect(parseFileDownload({ text: JSON.stringify({ ...image, mimeType: "application/pdf" }) })).toEqual({ name: "signups.png", url: file.url });
    const Preview = fileAttachRenderer.Preview;
    if (!Preview) throw new Error("missing preview");
    const { container } = render(<Preview args={{}} result={JSON.stringify({ ...image, mimeType: "application/pdf" })} status="completed" toolName="file_attach" />);
    expect(container.innerHTML).toBe("");
  });

  it("does not show an image from an untrusted URL", () => {
    expect(parseFileDownload({ text: JSON.stringify({ ...image, url: "https://other.test/x.png" }) })).toBeNull();
  });

  it("keeps an image call in view so it does not fold into a work line", () => {
    expect(fileAttachRenderer.keepsInView?.({ path: "/workspace/chart.PNG" }, "file_attach")).toBe(true);
    expect(fileAttachRenderer.keepsInView?.({ path: "/workspace/report.docx" }, "file_attach")).toBe(false);
    expect(fileAttachRenderer.keepsInView?.({ source: "flowchart LR" }, "render_diagram")).toBe(true);
  });
});
