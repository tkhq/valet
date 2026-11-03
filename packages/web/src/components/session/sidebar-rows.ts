/**
 * The sidebar's type tiers, Linear style (see "Sidebar hierarchy" in
 * docs/specs/2026-08-17-team-workspace-ui-design.md):
 *
 * - Section labels (Spaces, Projects, Recents) are small, muted text.
 * - Top-level rows (Home, a space, a project) are primary text with 16px icons.
 * - Nested rows (a space's pages, a project's threads, Recents) are secondary
 *   text with 14px icons, indented 24px with no guide line.
 *
 * One row at a time takes the neutral selected fill. Row chrome (chevrons,
 * "+", "…") shows on hover or focus where a pointer can hover, and always on
 * a touch screen.
 *
 * A phone (below 768px) keeps the tiers at touch size: 44px rows, 15px row
 * text, and 12px labels.
 */

/** A section label: Spaces, Projects, Pinned, Recents. */
export const SIDEBAR_LABEL = "px-4 pb-1 pt-4 text-[11px] font-medium text-muted max-md:pt-5 max-md:text-xs";

/** The frame of a top-level row: 28px tall, inset 8px, rounded. Its own content pads `pl-2`. */
export const TOP_ROW = "mx-2 flex h-7 items-center rounded-md text-[13px] text-ink max-md:h-auto max-md:min-h-11 max-md:text-[15px]";

/** The frame of a nested row: 26px tall. Content pads `pl-8`, 24px past a top-level row's icon. */
export const NESTED_ROW = "mx-2 flex h-[26px] items-center rounded-md text-[13px] max-md:h-auto max-md:min-h-11 max-md:text-[15px]";

/** A nested row that is neither selected nor current. */
export const NESTED_IDLE = "text-ink/70 hover:bg-ink-wash hover:text-ink";

/** The one selected row: the open thread, Home, or the open page. */
export const SELECTED_ROW = "bg-ink-wash-strong font-medium text-ink";

/** A row's chevron, "+" or "…": hidden until the row (`group`) is hovered or focused, unless the screen cannot hover. */
export const HOVER_CHROME = "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100";

/** A small square button for row chrome. */
export const CHROME_BUTTON = "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:opacity-50 max-md:min-h-11 max-md:min-w-11";
