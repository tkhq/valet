---
name: browser
description: Use a persistent sandbox Chromium browser with semantic page observations, screenshots, JavaScript cells, and human control.
---

# Sandbox browser

1. Call `browser.describe` before the first browser cell. Read the installed API and capabilities.
2. Call `browser.execute` with a short title and JavaScript source.
3. Inspect the page snapshot before an action. Capture a screenshot when visual evidence helps.
4. Verify the result after each consequential action.

Each thread has a persistent Node REPL. Top-level bindings and top-level await survive across cells.
Use fresh variable names or reuse existing bindings. Call `browser.reset` to discard this thread's bindings.
Reset keeps the profile and tabs. Browser restart invalidates runtime, document, and element handles.

The browser methods use structured RPC. Read-only evaluation operates on a captured DOM observation.
It cannot access live page globals. Use the supported locator and input methods for page actions.
A snapshot reference can expire after navigation or human control. Capture a new snapshot when that happens.

Browser operations have separate approvals. A paused cell stays in the runtime while the host waits for a decision.
Do not repeat a cell after an uncertain effect. Read its receipt and inspect the page first.
A failed operation can have an unknown outcome. A second click can submit the same form twice.

Use the Browser panel for private sign-in, human takeover, dialogs, and downloads.
Private sign-in pauses agent observations. Let the user release control before continuing.
A team browser requires an explicit shared audience. Its screenshots and page text appear in the team transcript.

Mark a tab as a deliverable or handoff when the user needs it after the turn.
The runtime closes unmarked tabs owned by the completed thread. Human tabs and another thread's tabs remain open.

Screenshots returned by the browser tool become image evidence in the conversation.
The viewer's continuous frames are temporary. They do not enter the model transcript.

If the runtime reports an unsupported capability, follow its corrective action.
Do not bypass the browser broker with shell automation or direct debugging connections.
