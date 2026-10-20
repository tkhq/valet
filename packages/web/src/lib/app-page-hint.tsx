import { createContext } from "react";
import type { SendPromptRequest } from "@valet/api/wire";

/** Only Ask Valet supplies a hint; ordinary chat composers send none. */
export const AppPageHintContext = createContext<SendPromptRequest["appPageHint"]>(undefined);

/** Whether a node sits inside the Ask Valet dock (`data-ask-valet-dock`). The
 * dock can sit beside a page composer, and page requests belong to that one. */
export function inAskValetDock(node: EventTarget | null | undefined): boolean {
  return node instanceof Element && node.closest("[data-ask-valet-dock]") !== null;
}
