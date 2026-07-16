// @vitest-environment jsdom
/**
 * `NewSessionDialog` (sandbox auth gateway plan, Task 7): the web dialog is
 * the interactive session entry point, so it must request the "full"
 * profile (ttyd + code-server behind the gateway) rather than the
 * "headless" server-side default.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

const mutateAsync = vi.fn().mockResolvedValue({ id: "sess-new" });
vi.mock("~/api/queries", () => ({
  useCreateSession: () => ({ mutateAsync, isPending: false, error: null }),
}));

import { NewSessionDialog } from "./new-session-dialog";

describe("NewSessionDialog", () => {
  it("submits with profile: full", async () => {
    render(<NewSessionDialog open onOpenChange={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "full" }),
    );
  });
});
