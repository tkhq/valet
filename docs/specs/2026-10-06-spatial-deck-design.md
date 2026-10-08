# Spatial page deck

An opt-in `/deck` page holds live Valet pages in persistent cards. The deck supports
focus, two-card comparison, and overview. Each card has its own workspace,
navigation, composer drafts, sidebar state, and scroll position. Switching views
never unmounts a card. Each card uses a same-origin frame, preserving the existing
router, portals, query cache, and live connections without a second page renderer.

The deck stores card IDs and latest page URLs in session storage. Text drafts use
card-specific storage keys. Ordinary browser tabs keep their current storage keys.
Closing a card discards access to its unsent drafts, attachments, and open forms.
A reload restores pages and saved text; pending uploads and transient dialogs do
not survive a reload. Closing a card asks for confirmation and never deletes a
thread or stops a workflow. The deck is limited to six live cards to bound cost.

Frame messages must have the same origin and match a mounted frame's window.
Only internal page URLs are restored; a card cannot recursively open the deck.
The interface respects reduced motion and supports keyboard-accessible controls.
No server schema, permission, or user-material changes are required.

Validation covers storage isolation, URL validation, restoration, stable frame
identity through view changes, and real browser navigation/draft preservation.

The normal page remains the default. Its Tabs button opens the deck as an overlay.
Back to page hides the deck without unmounting it. The underlying normal page also
stays mounted, so its drafts and scroll state survive opening and closing Tabs.

Hidden pages disable global keyboard shortcuts while retaining mounted state. Escape cannot interrupt a hidden chat or close its child panel.


## Review branch behavior

The normal page is the default entry point. Tabs remains a separate draft PR for
hands-on review. The current prototype retains its spatial CSS during that review.
A card retains the mounted page when switching layouts or returning to the normal
page. Navigating within a card uses the existing router and its state rules.

Text drafts retain account isolation in addition to their card and thread keys.
The frame and overlay inert state disables embedded chat shortcuts. Opening Tabs
moves keyboard focus to its Back button. Returning restores the previous focus.
Mobile controls fit at 320 pixels. Compare stacks two cards on narrow screens.

Reload restores card URLs and saved text drafts. It does not restore scroll
positions, unsent attachments, or unsaved forms. Cards keep their live connections
while hidden; six cards is the maximum. Independent cards can show stale server
state until their existing query or live update mechanism refreshes it.
