import { expect, it } from "vitest";
import { isAutomatedDeliveryThread } from "./automated-threads.js";

it("marks only the threads that automated deliveries write to", () => {
  expect(isAutomatedDeliveryThread({ key: "events" })).toBe(true);
  expect(isAutomatedDeliveryThread({ key: "slack-events:C0C0R9DQ1QS" })).toBe(true);
  // A mention's own Slack thread, a web conversation, and a workflow run thread are not delivery threads.
  expect(isAutomatedDeliveryThread({ key: "slack:C1:1.2" })).toBe(false);
  expect(isAutomatedDeliveryThread({ key: "web:abc" })).toBe(false);
  expect(isAutomatedDeliveryThread({ key: "slack-events:C1:workflow:wf_1" })).toBe(false);
});
