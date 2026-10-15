import { createContext } from "react";
import type { SendPromptRequest } from "@valet/api/wire";

/** Only Ask Valet supplies a hint; ordinary chat composers send none. */
export const AppPageHintContext = createContext<SendPromptRequest["appPageHint"]>(undefined);
