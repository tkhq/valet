# Animated browser agent pointer

## Behavior

Show the agent's interaction point in the Browser panel and floating preview. Use a dark arrow, white outline, soft glow, eased movement, and a brief click pulse. The pointer fades after inactivity. Honor reduced-motion preferences. The overlay cannot intercept input. The person's normal contextual cursor remains available.

The transparent keyboard input surface must not draw a border around the whole browser when focused. Remote page controls keep their own focus appearance.

## Data

Track actual pointer and editable-field input events during agent mutation commands. Locator actions, coordinate actions, typing, and child frames use the same tracker. Semantic locators support hover as a mutation. Do not report observations or human input as agent activity. Clear tracking on human interaction, document navigation, and private-mode transitions. Preserve tracking across same-document anchor navigation. Tracking is optional display metadata and must never change action results.

Each inline frame can include `agentCursor`: viewport coordinates `x` and `y`, `kind` (`move`, `click`, or `type`), increasing `sequence`, and `ageMs`. Expire metadata after 15000 ms. This window keeps the pointer visible through normal tool narration. Only numeric coordinates and activity kinds leave the page; do not collect keys or field values. Match the cursor to the frame's document identity. Existing private-view authorization applies to this metadata.

Sample activity before and after image capture. Omit the cursor if its sequence changes during capture. Each frame carries the latest event. Rapid actions between frames can skip intermediate movement or click pulses. Animation does not delay actions to make them visible.

The API validates metadata and forwards it in an optional JPEG response header. Malformed metadata does not break the image feed. The web client maps coordinates through the same image scaling and letterboxing as input. Agent commands select their target tab. The floating preview follows that tab unless the person pins another tab. While the agent works, the preview refreshes tab status twice per second. A new document or page starts a new pointer animation. A repeated sequence must not replay click pulses or extend its lifetime.

Image transfer and decoding count toward the local expiry. Private-mode entry permanently suppresses retained activity until a newer sequence arrives.
Child-frame mapping supports borders and axis-aligned scaling. Rotated or skewed frames can place the pointer incorrectly.

## Research

The official [Browser documentation](https://learn.chatgpt.com/docs/browser) describes shared viewing and computer use. It does not document cursor artwork or animation constants. The user's screenshot shows a dark pointer, white outline, and glow. Valet reproduces this observed behavior with its own SVG and CSS transitions.

## Validation

Use real Chromium to verify tracking for locator clicks, typing, coordinates, and frames. Check that human input and navigation clear the pointer. Verify metadata validation, privacy boundaries, scaling, click sequences, and reduced motion. Dogfood both viewer sizes and confirm the focus border is absent. Run the full end-to-end suite before pushing.

Live dogfooding used three form rounds in the existing Browser Control Lab session. The agent filled Name and Notes, then submitted each round.
The mini preview showed typing activity. The full Browser view showed the pointer on Submit form after the final submission.
The final status read `Saved Cursor round 3; count 10; checked false; color Blue`.
Human input hid the agent pointer. The focused input surface had no box shadow and a transparent outline; text fields retained the text cursor.

The full `make e2e` run passed 31 suites, failed two infrastructure suites, and skipped four opt-in or credential-dependent suites.
The Docker recovery suite passed an isolated retry after the cluster workload ended. The Kubernetes failure reported a missing workspace PVC during startup.
That Kubernetes conformance case passed its isolated retry. Neither retry required code changes.
