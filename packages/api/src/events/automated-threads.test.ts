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

// Delivery threads spec: the thread policy's own keys are delivery threads.
it("marks the thread policy's keys and leaves a pinned thread alone", () => {
  for (const key of ["sub:rule-1", "sub:rule-1:delivery-9", "schedule:rule-2", "schedule:rule-2:1700000000000", "subject:github:acme/api#12"]) {
    expect(isAutomatedDeliveryThread({ key })).toBe(true);
  }
  expect(isAutomatedDeliveryThread({ key: "th-user-pinned" })).toBe(false);
  expect(isAutomatedDeliveryThread({ key: "subscription:rule-1" })).toBe(false);
});
