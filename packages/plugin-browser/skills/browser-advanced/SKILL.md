---
name: browser-advanced
description: Use when sandbox browser work involves locator composition, frames, multiple tabs, asynchronous pages, virtualized content, dialogs, file transfer, diagnostics, or stale-reference recovery.
---

# Advanced sandbox browser

Apply the authorization, privacy, shared-input, and uncertain-effect rules from
the `browser` skill. Call `browser.describe` before the first browser cell because
the installed runtime is authoritative.

## Reliable interaction loop

For each meaningful page transition:

1. Observe the current page.
2. Select the narrowest stable semantic locator.
3. Perform one logical effect.
4. Wait for the resulting state, URL, or document.
5. Observe or capture a screenshot to verify the result.

Keep an observation and its reference action in one cell when possible. Bindings
persist across cells, but document and element handles do not survive every page
change. Use fresh top-level variable names when you need new bindings.

```js
const settingsTab = await browser.tabs.new({url: "http://localhost:5173/settings"});
const settingsBefore = await settingsTab.getAXState();
await settingsTab.playwright
  .getByRole("button", {name: "Save", exact: true})
  .click();
await settingsTab.getAXState();
```

## Locator strategy

Prefer locators in this order:

1. `getByRole` with an accessible name
2. `getByLabel` for form controls
3. `getByPlaceholder` when no label exists
4. `getByText` for stable visible text
5. `getByTestId` for application-owned test contracts
6. `locator` with CSS when semantic data is unavailable

Use `{exact: true}` when nearby controls have similar names. Locators are strict:
an action fails when zero or multiple elements match. Use `count()` to inspect an
ambiguous locator. Narrow it with `filter`, `and`, or `or`. Use `first`, `last`,
or `nth` only when position is the intended identity.

```js
const row = settingsTab.playwright
  .getByRole("row")
  .filter({hasText: "Production"});
const enable = row.getByRole("button", {name: "Enable", exact: true});
output.write({matches: await enable.count()});
await enable.click();
```

Use returned snapshot references for controls that have no stable locator. Take a
new observation if a reference becomes stale. Never retarget a stale reference to
an element that merely looks similar.

## Frames and nested content

Use `frameLocator` before the locator inside an inline frame. Continue to use
semantic locators inside the frame. Frame navigation can invalidate references
from the whole observation.

```js
const paymentFrame = settingsTab.playwright.frameLocator("iframe[title='Payment']");
await paymentFrame
  .getByLabel("Postal code", {exact: true})
  .fill("10001");
```

Open shadow roots participate in semantic locators. Closed shadow roots do not.
If a capability is unavailable, follow the corrective action from the runtime.

## Navigation, popups, and multiple tabs

Use `waitForURL` or `waitForLoadState` when the next action depends on navigation.
This facade applies strict matching before `locator.waitFor()`, so it cannot wait
for a missing element to appear. For a single-page application, use a bounded
loop that checks `count()`, then observe the resulting state. Do not use an
unbounded loop.

```js
const savedNotice = settingsTab.playwright
  .getByText("Settings saved", {exact: true});
let saved = false;
for (let attempt = 0; attempt < 10; attempt++) {
  if (await savedNotice.count() === 1) {
    saved = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!saved) throw new Error("The saved state did not appear.");
await settingsTab.getAXState();
```

List tabs before and after an action that can open a popup. Retrieve the new tab
with `browser.tabs.get(id)`. Any operation on a tab also makes it the active tab
for the shared viewer.

```js
const tabsBefore = await browser.tabs.list();
await settingsTab.playwright
  .getByRole("link", {name: "Open report", exact: true})
  .click();
const tabsAfter = await browser.tabs.list();
const popupInfo = tabsAfter.find((candidate) =>
  !tabsBefore.some((before) => before.id === candidate.id));
if (!popupInfo) throw new Error("The report tab did not open.");
const reportTab = await browser.tabs.get(popupInfo.id);
await reportTab.waitForLoadState("domcontentloaded");
await reportTab.getAXState();
```

Use `markDeliverable()` when the user needs a result tab after the turn. Use
`markHandoff()` when the next turn must continue the tab. Temporary agent tabs
close when their owning turn ends.

## Forms and editable controls

Use `fill` to replace an editable value. Use `type` or `pressSequentially` only
when the application depends on key-by-key input. Use `press` for named keys,
`selectOption` for native selects, and `check`, `uncheck`, or `setChecked` for
checkboxes.

Do not place secret values in browser code, screenshots, or evidence. Use private
sign-in for human credential entry. Uploads require an approved broker path and
must use `tab.upload(target, paths)`. The target must be a reference from the most
recent `getAXState()` result. The paths name files in the sandbox working
directory.

```js
await settingsTab.getAXState();
const fileInputRef = "REF_ID_FROM_LATEST_OBSERVATION";
await settingsTab.upload(fileInputRef, ["artifacts/report.pdf"]);
await settingsTab.getAXState();
```

JavaScript dialogs stop page progress. Read `tab.getJsDialog()` and respond with
`tab.dialog.respond(id, accept, text)`. Inspect the page after the response.

## Scrolling and virtualized pages

Locator actions scroll their target into view. For viewport exploration, observe
first and call `tab.scroll({x, y, deltaY})`. Direction and page-count arguments
also work.

```js
await settingsTab.getAXState();
await settingsTab.scroll({x: 640, y: 400, deltaY: 800});
await settingsTab.getAXState();
await settingsTab.scroll(null, "down", 2);
await settingsTab.getAXState();
```

Virtualized lists replace elements while scrolling. Re-observe after each scroll
and rebuild locators or references. Stop when the target appears, the scroll
position stops changing, or a reasonable task-specific bound is reached.

Use coordinate input only when semantic locators and snapshot references cannot
express the action. Coordinates use viewport CSS pixels and require a current
observation. Verify coordinate actions with a new observation or screenshot.

## Diagnostics and detached evaluation

Use these tools to answer different questions:

| Tool | Use |
| --- | --- |
| `getAXState()` | Accessible names, roles, state, and snapshot references |
| `getScreenshot()` | Layout, visual state, canvas, and image evidence |
| `getAXStateAndScreenshot()` | A combined semantic capture followed by a visual capture |
| `domSnapshot()` | Sanitized markup from the current document and frames |
| `playwright.evaluate()` | Read-only queries against an immutable DOM snapshot |
| `dev.logs()` | Recent console messages and page errors |
| `dev.network()` | Recent completed requests and resource types |

Snapshot evaluation cannot access live globals or mutate the page. It ignores the
locator chain and reads only the main-frame snapshot, even when called from a
chained locator or `frameLocator`. Use `domSnapshot()` to inspect other frames.
Use supported locators and tab methods for live effects. Diagnostics are bounded
observations; they are not a complete browser trace.

## Downloads, exports, and evidence

Use `browser.downloads()` to list brokered downloads. Use
`tab.content.export(format)` for rendered content. Use `tab.content.assets()`
before `bundleAssets(inventoryId)` when the task needs page assets. These effects
retain their grant or approval requirements.

Download import finishes asynchronously after the page click. If an export grant
authorizes repeated reads, poll for a new download ID with a bounded loop. Emit
the result because `browser.downloads()` does not emit automatically.

```js
const downloadsBefore = await browser.downloads();
await settingsTab.playwright
  .getByRole("button", {name: "Download", exact: true})
  .click();
let downloaded;
for (let attempt = 0; attempt < 10; attempt++) {
  const downloadsNow = await browser.downloads();
  downloaded = downloadsNow.find((item) =>
    !downloadsBefore.some((before) => before.id === item.id));
  if (downloaded) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!downloaded) throw new Error("The download did not reach the broker.");
output.write(downloaded);
```

Reliable download completion requires repeated `browser.downloads()` reads under
an applicable grant. If authorization permits one export read only, report that
the agent cannot reliably confirm broker completion from the page alone.

Screenshots emitted by browser cells become conversation evidence. Viewer frames
remain temporary. Capture explicit screenshot evidence for a result that must be
reviewed after the live frame changes.

## Recovery

Follow the runtime error and its corrective action. Common recovery paths are:

| Condition | Response |
| --- | --- |
| A locator matches nothing | Observe again and verify the page state. |
| A locator is ambiguous | Count matches and add semantic constraints. |
| A reference is stale | Take a fresh observation and rebuild the action. |
| The runtime changed | List tabs and obtain new tab handles. |
| The document changed during capture | Capture a new observation or screenshot. |
| A capability is unsupported | Use the documented supported method. |
| An effect has an unknown outcome | Inspect its receipt and page state. Do not replay it. |

Do not use shell browser automation or a direct debugging connection as a
recovery path. The broker owns confinement, authorization, evidence, and shared
human input.
