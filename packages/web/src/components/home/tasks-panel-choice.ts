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
    // Without storage the next visit opens the panel by default again.
  }
}
