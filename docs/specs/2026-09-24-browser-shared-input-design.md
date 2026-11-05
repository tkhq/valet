# Shared browser interaction

## Behavior

Normal browser use is shared between people and the agent. Opening the viewer, typing, clicking, and navigation do not acquire exclusive control.
The Browser panel enables input when its runtime is ready and session access permits it.
Human and agent mutations use the existing ordered effect queue. Shared input never leaves a control lease behind.
The agent can continue using the browser after each human interaction without a release step.

An explicit Pause agent action or Private sign-in keeps exclusive control until the owner resumes shared use.
Private sign-in continues to suppress agent observations and the floating preview. Expiration must not silently end private mode.
The UI names these explicit states. It does not label a live image feed merely Paused.
Existing explicit control commands remain compatible. Normal UI input no longer calls them.

## Protocol and runtime

Make the input and tab request lease ID optional. Continue requiring viewer identity, runtime ID, and current document identity for page input.
An omitted lease means shared input. It is accepted only when no explicit exclusive control is held or being acquired.
An explicit lease must pass the existing actor, runtime, state, and expiry checks.
Check authorization before queue admission and again when the operation runs.
Takeover reserves one owner before awaiting effects. Concurrent take requests cannot overwrite that reservation.
Dialog responses retain a separate path so a blocked browser operation cannot prevent its dialog from being answered.
During takeover, only its authorized owner can answer the pending dialog. Explicit control blocks agent dialog mutations.
Human input invalidates affected agent observations. Generations reject captures that cross an invalidation. Frames continue to update independently.
Agent effects must not inherit keys or mouse buttons left held by human input. Release held input before validating the next agent mutation, since key or button release can run page handlers.
This coordination orders individual effects; it does not give either actor an isolated page or independent focus.

## Web interface

Remove Take control from normal use. Enable navigation, page creation, closing, and input without a lease.
Use Pause agent for explicit exclusivity and Resume agent to release it. Keep Private sign-in and its explicit exit.
The preview explains when a person has explicitly paused agent actions. The owner can resume from chat outside private mode.
Keep the preview image read-only. Opening the Browser panel enables shared page input without an extra handoff.
A fresh document or explicit retry restores input after an error without replaying the failed mutation.
Disposed input queues suppress late errors from a previous document.
The keyboard input overlay uses remote cursor feedback, with the normal arrow as its fallback.

## Credentials

The current valet-secrets command resolves references into a child process environment without printing secret values.
A future browser credential operation should accept references, resolve them through the authorized broker, and keep values out of transcripts and evidence.
No credential retrieval or login is added in this change. Manual private sign-in remains an optional fallback.

## Validation

Reproduce shared human input followed by agent actions without any take or release command.
Test stale runtime and document rejection, invalid explicit leases, explicit pause, private mode, and dialog responses.
Test input ordering and cleanup of held human keys before agent mutations.
Test web controls in shared mode and ownership checks for explicit pause and private mode.
Dogfood alternating human and real-agent input while watching the preview. Run the full make e2e scorecard.

## Native dropdowns and cursor feedback

Chromium's external select popup does not appear in page screenshots. The runtime uses Chromium's in-page select picker for native single-select dropdowns. Chromium still handles option clicks, disabled options, keyboard input, and change events. The picker can change the platform-default appearance of these controls. Custom dropdowns and listboxes keep their own rendering. The hook applies to documents, child frames, and open shadow roots before a dropdown opens.

Human pointer replies include the cursor at the remote point. Hit testing follows frames and open shadow roots. Closed shadow roots retain the host cursor and external native picker limitation. The viewer accepts standard cursor keywords only. It does not fetch custom cursor URLs. Automatic cursors resolve to text over editable fields or rendered text and to a pointer over links. The viewer discards feedback after a document change or pointer exit.
