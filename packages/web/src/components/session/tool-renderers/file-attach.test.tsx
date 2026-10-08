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

  it.each(["javascript:alert(1)", "https://other.test/file", "//other.test/file", "/api/artifacts/share"])('does not turn %s into a download', (url) => {
    expect(parseFileDownload({ text: JSON.stringify({ ...file, url }) })).toBeNull();
  });

  it("shows a failed attachment without a download link", () => {
    const Body = fileAttachRenderer.Body;
    render(<Body args={{}} result={undefined} status="error" error="File missing. Create the file and retry." toolName="file_attach" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("File missing. Create the file and retry.")).toBeTruthy();
  });
});
