// @vitest-environment jsdom
/**
 * The report section (M-P3, spec §Report generation): it renders the report
 * cell's markdown artifact with a .md and a .json download, shows a
 * "generating…" note while a report cell runs, and a "not yet generated" note
 * before the report exists.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SecurityReportWire } from "@valet/api/wire";

const downloadSecurityReport = vi.fn<
  (sessionId: string, format: "md" | "json") => Promise<string>
>();

vi.mock("~/api/security", () => ({
  downloadSecurityReport: (sessionId: string, format: "md" | "json") =>
    downloadSecurityReport(sessionId, format),
}));

import { ReportSection } from "./report-section";

const REPORT: SecurityReportWire = {
  markdown: "# Valet Security report\n\n## Executive summary\n\nOne confirmed high finding.",
  json: { executiveSummary: "one high" },
  generatedAt: 1_700_000_000_000,
};

describe("ReportSection", () => {
  beforeEach(() => {
    downloadSecurityReport.mockReset();
    downloadSecurityReport.mockResolvedValue("valet-security-report-s1.md");
  });

  it("renders the markdown report and the two download buttons", () => {
    render(<ReportSection sessionId="s1" report={REPORT} generating={false} />);
    // The markdown headings render (react-markdown), not the raw source.
    expect(screen.getByRole("heading", { name: "Valet Security report" })).toBeTruthy();
    expect(screen.getByText("Executive summary")).toBeTruthy();
    expect(screen.getByText(/One confirmed high finding\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download .md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download .json" })).toBeTruthy();
  });

  it("downloads the .md and .json artifacts through the authenticated path", async () => {
    render(<ReportSection sessionId="s1" report={REPORT} generating={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Download .md" }));
    await waitFor(() => expect(downloadSecurityReport).toHaveBeenCalledWith("s1", "md"));
    fireEvent.click(screen.getByRole("button", { name: "Download .json" }));
    await waitFor(() => expect(downloadSecurityReport).toHaveBeenCalledWith("s1", "json"));
  });

  it("shows a download failure inline and names it", async () => {
    downloadSecurityReport.mockRejectedValueOnce(new Error("Report download failed (500). Try again."));
    render(<ReportSection sessionId="s1" report={REPORT} generating={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Download .md" }));
    await waitFor(() =>
      expect(screen.getByText(/Report download failed \(500\)\. Try again\./)).toBeTruthy(),
    );
  });

  it("shows a generating note while a report cell runs (no report yet)", () => {
    render(<ReportSection sessionId="s1" report={null} generating={true} />);
    expect(screen.getByText(/Generating the report…/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download .md" })).toBeNull();
  });

  it("shows the empty state before the report is generated", () => {
    render(<ReportSection sessionId="s1" report={null} generating={false} />);
    expect(screen.getByText(/The report is not yet generated\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download .md" })).toBeNull();
  });
});
