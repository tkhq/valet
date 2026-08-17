---
name: browser
description: Control the Chromium browser using the agent-browser CLI. Navigate, click, type, fill forms, take snapshots, extract content, and more.
---

# Browser Control via agent-browser CLI

You have `agent-browser` installed globally. It controls a real Chromium browser inside your sandbox.

The browser runs headless. The sandbox has no display and no VNC panel, so do
NOT pass `--headed` — that flag needs a display and fails here. To look at a
page, write an image file and read it back:

```bash
agent-browser screenshot /workspace/shot.png
```

## Core Workflow

1. **Open a URL**: `agent-browser open <url>`
2. **Take a snapshot** to see page structure: `agent-browser snapshot -i -c`
3. **Interact** using element refs from the snapshot: `agent-browser click @e3`
4. **Verify visually**: `agent-browser screenshot /workspace/shot.png`, then read the file.

## Navigation

```bash
agent-browser open <url>          # Navigate to URL
agent-browser back                # Go back
agent-browser forward             # Go forward
agent-browser reload              # Reload page
agent-browser close               # Close browser
```

## Clicking & Focus

```bash
agent-browser click <selector>    # Click element (CSS selector or @ref)
agent-browser dblclick <selector> # Double-click
agent-browser focus <selector>    # Focus element
agent-browser hover <selector>    # Hover over element
```

## Text Input

```bash
agent-browser type <selector> <text>   # Type into element (appends)
agent-browser fill <selector> <text>    # Clear field and fill with text
agent-browser press <key>               # Press key (Enter, Tab, Control+a, etc.)
```

## Form Controls

```bash
agent-browser select <selector> <value> # Select dropdown option
agent-browser check <selector>           # Check checkbox
agent-browser uncheck <selector>         # Uncheck checkbox
agent-browser upload <selector> <files>  # Upload files
```

## Scrolling

```bash
agent-browser scroll down [px]           # Scroll down (default ~page)
agent-browser scroll up [px]             # Scroll up
agent-browser scrollintoview <selector>  # Scroll element into view
```

## Snapshots (Accessibility Tree)

Snapshots give you a structured view of the page with element refs (`@e1`, `@e2`, etc.) you can use in subsequent commands.

```bash
agent-browser snapshot              # Full accessibility tree
agent-browser snapshot -i           # Interactive elements only
agent-browser snapshot -c           # Compact output
agent-browser snapshot -i -c        # Interactive + compact (recommended)
agent-browser snapshot -d 3         # Limit depth to 3
agent-browser snapshot -s "main"    # Scope to a CSS selector
```

After a snapshot, use the `@ref` identifiers to interact:

```bash
agent-browser click @e3
agent-browser fill @e7 "search query"
```

## Getting Page Information

```bash
agent-browser get title             # Page title
agent-browser get url               # Current URL
agent-browser get text <selector>   # Text content of element
agent-browser get html <selector>   # innerHTML of element
agent-browser get value <selector>  # Input value
agent-browser get attr <sel> <attr> # Element attribute
agent-browser get count <selector>  # Count matching elements
```

## Checking Element State

```bash
agent-browser is visible <selector>  # Check visibility
agent-browser is enabled <selector>  # Check if enabled
agent-browser is checked <selector>  # Check if checked
```

## Waiting

```bash
agent-browser wait <selector>         # Wait for element to appear
agent-browser wait 2000               # Wait 2 seconds
agent-browser wait --text "Success"   # Wait for text to appear
agent-browser wait --url "**/dashboard" # Wait for URL pattern
```

**NEVER use `wait --load networkidle`** — many sites never reach network idle (analytics, websockets, polling). It will hang indefinitely and can break the session.

## Semantic Finding

Find elements by role, text, label, etc. and perform actions:

```bash
agent-browser find role button click              # Click first button
agent-browser find text "Submit" click            # Click element with text
agent-browser find label "Email" fill "a@b.com"   # Fill by label
agent-browser find placeholder "Search" fill "q"  # Fill by placeholder
agent-browser find testid "login-btn" click       # Click by data-testid
```

## Tabs

```bash
agent-browser tab                   # List open tabs
agent-browser tab new [url]         # Open new tab
agent-browser tab 2                 # Switch to tab 2
agent-browser tab close [n]         # Close tab
```

## JavaScript Evaluation

```bash
agent-browser eval "document.title"
agent-browser eval "window.scrollTo(0, document.body.scrollHeight)"
```

## Dialogs

```bash
agent-browser dialog accept [text]  # Accept alert/confirm/prompt
agent-browser dialog dismiss        # Dismiss dialog
```

## Cookies & Storage

```bash
agent-browser cookies               # List cookies
agent-browser cookies clear         # Clear cookies
agent-browser storage local         # List localStorage
agent-browser storage local <key>   # Get specific key
```

## Common Workflow Examples

### Navigate and extract content

```bash
timeout 15 agent-browser open "https://example.com"
agent-browser snapshot -i -c
agent-browser get title
```

### Fill a form

```bash
timeout 15 agent-browser open "https://example.com/login"
agent-browser snapshot -i -c
timeout 10 agent-browser fill @e3 "user@example.com"
timeout 10 agent-browser fill @e5 "password123"
timeout 15 agent-browser click @e7
agent-browser wait 2000
agent-browser snapshot -i -c
```

### Using snapshot refs

```bash
agent-browser open "https://news.ycombinator.com"
agent-browser snapshot -i -c
# Output shows refs like @e1, @e2, @e3...
agent-browser click @e5    # Click the 5th interactive element
agent-browser get title    # Verify navigation
```

## Avoiding Hangs

Browser commands can hang if a page never finishes loading or a click triggers an unexpected navigation. **Always wrap browser commands with `timeout`** to prevent blocking the session:

```bash
timeout 15 agent-browser click @e3
timeout 15 agent-browser open "https://example.com"
timeout 15 agent-browser fill @e7 "text"
```

Use `timeout 15` (15 seconds) as a sensible default. If a command times out, take a snapshot to see what happened and adjust your approach.

**Never use `wait --load networkidle`** — it hangs on most real-world sites. Instead, wait for specific elements:

```bash
timeout 10 agent-browser wait "input[name=email]"  # Wait for a specific element
timeout 10 agent-browser wait --text "Welcome"     # Wait for specific text
```

## Tips

- **Take a screenshot** with `agent-browser screenshot <path>` after navigating or clicking, then read the file, so you and the user can see the result.
- Use `snapshot -i -c` as your go-to for understanding page structure.
- Prefer `fill` over `type` for form fields (it clears first).
- The browser persists between commands within a session. No need to reopen it.
- If the browser isn't running, `agent-browser open <url>` will start it.
