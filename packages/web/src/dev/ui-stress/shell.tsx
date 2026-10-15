import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { uiStressClient } from "./client";

/** Runs the app shell on the gallery's frozen client. Loaded by the root
 * layout through `./gate`, in development only. */
export default function UiStressShell({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={uiStressClient}>{children}</QueryClientProvider>;
}
