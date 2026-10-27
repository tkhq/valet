// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, search, children, ...rest }: { to: string; search: { source: string }; children: React.ReactNode }) => (
    <a href={`${to}?source=${search.source}`} {...rest}>{children}</a>
  ),
}));
import { ImageFallbackBanner } from "./image-fallback-banner";

const fallback = { source: "stock" as const, repoFullName: "acme/widgets", builtAt: null, fallback: { reason: "contract" as const, sourceId: "src1", bakeId: "pb", at: 1 } };

describe("ImageFallbackBanner", () => {
  it("renders nothing without a fallback", () => {
    const { container } = render(<ImageFallbackBanner image={{ source: "repo", repoFullName: "acme/widgets", builtAt: 1, fallback: null }} isOrgAdmin />);
    expect(container.innerHTML).toBe("");
  });
  it("explains the fallback with the guidance line and links admins to the source", () => {
    render(<ImageFallbackBanner image={fallback} isOrgAdmin />);
    expect(screen.getByRole("status").textContent).toContain("Running on the stock image. The `acme/widgets` image failed its compatibility check and is being rebuilt.");
    expect(screen.getByRole("status").textContent).toContain("The image was built before a runtime change. A rebuild is already queued.");
    expect(screen.getByRole("link", { name: "Manage images" }).getAttribute("href")).toBe("/settings/organization/sandbox-images?source=src1");
  });
  it("hides the link for non-admins", () => {
    render(<ImageFallbackBanner image={fallback} isOrgAdmin={false} />);
    expect(screen.queryByRole("link", { name: "Manage images" })).toBeNull();
  });
});
