// @vitest-environment jsdom
/**
 * The team delivery preference on a personal line names the per-workspace
 * agent as "your assistant", the Terminology word (presence hub spec).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryPreferences } from "./delivery-preferences";

afterEach(cleanup);

describe("DeliveryPreferences", () => {
  it("offers delivery to your assistant, and never says personal agent", () => {
    render(<DeliveryPreferences value={{ deliveryPolicy: "ignoreIfMyTeamSubscribed", pauseOnOverlap: true }} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Deliver to your assistant too" })).toBeTruthy();
    expect(screen.getByText(/choose ‘Deliver to your assistant too’/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/personal agent/i);
  });
});
