# Floating browser preview

## Purpose

Users can watch browser work without leaving the session chat. A floating preview shows the existing browser frame feed.

## Interface

The preview opens when the active thread runs a browser execution tool. Completed history and browser documentation calls do not open it.
A Watch browser button in the chat tab strip also opens it. Viewing does not start a sandbox or acquire browser control.
The preview stays open after browser work ends. Close suppresses automatic opening for that session and thread until the user restores it.
Minimize keeps the header and selected page. A chat area shorter than 200 pixels also shows only the header. Watch browser restores a closed or minimized preview.
Visibility choices last for the mounted session view. Switching threads keeps their choices separate. Reload resets the choices.

The window starts near the upper right of the chat. Users can drag its header and resize its lower corner.
Arrow keys move or resize the focused handle. Shift increases the step. Home resets the position and size.
Container resize clamps the window inside the available area. The preview leaves room for the composer below it.
A compact layout fits narrow session panels. All controls remain reachable without horizontal scrolling.

The header has minimize, restore, open full Browser view, and close controls. Opening the full view suspends the overlay.
Returning to Chat restores its prior visibility. These controls do not move focus during automatic opening.
Close returns focus to Watch browser. Expanding focuses the Browser tab.
The preview image is read-only. Users open the full Browser view for shared navigation, input, dialogs, or sign-in.

A page selector chooses among visible runtime tabs. Its initial selection prefers the runtime selection when owned by this thread.
Otherwise it prefers a tab owned by this thread, then the runtime selection, then the first tab.
The viewer follows this selection until the user selects a page. It does not claim to follow every agent locator operation.
A status label distinguishes browser work, a live feed, loading, agent pause, and unavailable states.
An explicit nonprivate pause keeps frames live. Its owner can select Resume agent from the preview, including after lease expiry.
Other viewers cannot release the lease. Private sign-in requires exit from the full Browser view.

## Data and access

Use the existing browser status query, view tickets, and bounded JPEG frame polling. No new transport or package is needed.
Mount the preview feed only while expanded in Chat. Unmount it when closed, minimized, or replaced by the full Browser pane.
The existing frame hook stops capture while the document is hidden and aborts requests on unmount.
Key the feed by session and thread to prevent stale images during navigation.

Suppress images and page metadata during private sign-in. Suppress images during dialogs, disabled access, status errors, or unavailable viewers.
Never render a cached frame after a permission error. Existing server authorization remains authoritative.
HTTP errors and status responses with an error field both suppress cached images.
Status and frame errors offer retry and access to the full Browser view. Viewing alone never mutates browser state. Resume agent explicitly releases an owned nonprivate lease.

## Validation

Component tests cover automatic opening, history exclusion, thread separation, close persistence, restore, minimize, and full-view transitions.
Feed tests cover tab selection, read-only behavior, private sign-in, dialogs, disabled access, unavailable runtime, and retry.
Geometry tests cover narrow bounds, container resize, keyboard and pointer gestures, pointer cancellation, and unmount cleanup.
Local dogfooding exercises each new control and a real agent browser turn. The full make e2e scorecard must pass before delivery.
