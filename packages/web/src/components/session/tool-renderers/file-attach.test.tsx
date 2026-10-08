// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
