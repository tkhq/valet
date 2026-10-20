import { expect, it } from "vitest";
import { isAutomatedDeliveryThread, isAutomatedThreadKey } from "./automated-threads.js";

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

// A conversation on a policy thread is attended: a person answers its questions.
it("leaves a policy thread that a conversation marked to the person in it", () => {
  const metadata = { conversational: true };
  expect(isAutomatedDeliveryThread({ key: "sub:rule-1:delivery-9", metadata })).toBe(false);
  expect(isAutomatedDeliveryThread({ key: "subject:slack:T1/C1", metadata })).toBe(false);
  expect(isAutomatedDeliveryThread({ key: "sub:rule-1", metadata: {} })).toBe(true);
  // The legacy firehose threads stay automated.
  expect(isAutomatedDeliveryThread({ key: "events", metadata })).toBe(true);
  expect(isAutomatedDeliveryThread({ key: "slack-events:C1", metadata })).toBe(true);
});

// The conversational flag is written only where the rule reads it.
it("names the keys the automated-thread rule covers", () => {
  for (const key of ["events", "slack-events:C1", "sub:rule-1", "sub:rule-1:delivery-9", "schedule:rule-2", "schedule:rule-2:1700000000000", "subject:github:acme/api#12"]) {
    expect(isAutomatedThreadKey(key)).toBe(true);
  }
  for (const key of ["th-user-pinned", "web:abc", "slack:C1:1.2", "slack-events:C1:workflow:wf_1", "subscription:rule-1"]) {
    expect(isAutomatedThreadKey(key)).toBe(false);
  }
});
