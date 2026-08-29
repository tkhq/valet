// @vitest-environment jsdom
/**
 * Export dialog (valet-security M8, spec §Export): the authenticated fetch
 * carries the picked format + the active filters, the blob download path
 * runs (object URL + anchor click), and a server failure surfaces inline —
 * never a navigation to raw JSON.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportDialog } from "./export-dialog";
import { exportUrl } from "~/api/security";

const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;
const createObjectURL = vi.fn(() => "blob:mock-url");
const revokeObjectURL = vi.fn();
const anchorClick = vi.fn();
const realAnchorClick = HTMLAnchorElement.prototype.click;

beforeEach(() => {
  fetchMock.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  anchorClick.mockClear();
  globalThis.fetch = fetchMock;
  // jsdom has no object-URL implementation, and a real anchor click on a
  // blob: href hits its not-implemented navigation path.
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  HTMLAnchorElement.prototype.click = anchorClick;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  HTMLAnchorElement.prototype.click = realAnchorClick;
});

function renderDialog(over?: Partial<Parameters<typeof ExportDialog>[0]>) {
  return render(
    <ExportDialog
      sessionId="s-1"
      open
      onOpenChange={vi.fn()}
      currentFilters={{ severity: "high", status: "open" }}
      filterActive
      {...over}
    />,
  );
}

describe("exportUrl", () => {
  it("carries format and the route's filters, never the path filter", () => {
    expect(exportUrl("s-1", "sarif", { severity: "high", path: "src/" })).toBe(
      "/api/sessions/s-1/security/export?format=sarif&severity=high",
    );
  });
});

describe("ExportDialog", () => {
  it("downloads the picked format with the current filters via fetch → blob", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/sarif+json",
          "Content-Disposition": 'attachment; filename="valet-security-eng-1.sarif"',
        },
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.click(screen.getByLabelText("SARIF 2.1.0"));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/s-1/security/export?format=sarif&severity=high&status=open",
      ),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    await waitFor(() => expect(anchorClick).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("exports everything when the scope is all findings", async () => {
    fetchMock.mockResolvedValue(new Response("# report", { status: 200 }));
    renderDialog();
    fireEvent.click(screen.getByLabelText("All findings"));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-1/security/export?format=md"),
    );
  });

  it("surfaces a server failure inline, naming the route's error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "format must be md, sarif, or json." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("format must be md, sarif, or json.")).toBeTruthy();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
