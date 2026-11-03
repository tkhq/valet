/** The desktop Tasks panel's last open or closed choice, for this browser. */
const KEY = "valet:home-tasks-panel";

/** The stored choice, or `undefined` when there is none or storage fails. */
export function loadTasksPanelChoice(): boolean | undefined {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "open" ? true : value === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function storeTasksPanelChoice(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "open" : "closed");
  } catch {
    // Without storage the next visit uses the first-visit rule again.
  }
}

/** Width at which the panel fits beside the conversation without crowding it. */
export const TASKS_PANEL_AUTO_OPEN_MIN_WIDTH = 1280;

/** Pure: with no stored choice, the panel starts open only when something
 * needs the person and the window is wide enough. */
export function firstVisitTasksOpen(needsYou: number, width: number): boolean {
  return needsYou > 0 && width >= TASKS_PANEL_AUTO_OPEN_MIN_WIDTH;
}
