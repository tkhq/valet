import { useEffect, useState } from "react";
import type { Message } from "@valet/api/wire";

type WatchMode = "auto" | "open" | "minimized" | "closed";

function isExecution(toolName: string, args: unknown): boolean {
  if (/^(?:tool_)?browser[._]+execute$/.test(toolName)) return true;
  return (
    toolName === "call_tool" &&
    typeof args === "object" &&
    args !== null &&
    "tool_id" in args &&
    args.tool_id === "browser.execute"
  );
}

export function useBrowserWatch({
  sessionId,
  threadId,
  messages,
  agentBusy,
}: {
  sessionId: string;
  threadId: string | undefined;
  messages: Message[];
  agentBusy: boolean;
}) {
  const scope = JSON.stringify([sessionId, threadId]);
  const [choices, setChoices] = useState<Record<string, WatchMode>>({});
  const mode = choices[scope] ?? "auto";
  const working =
    agentBusy &&
    !!threadId &&
    messages.some(
      (message) =>
        message.sessionId === sessionId &&
        message.threadId === threadId &&
        message.parts.some(
          (part) =>
            part.kind === "tool_call" &&
            part.status === "running" &&
            isExecution(part.toolName, part.args),
        ),
    );
  useEffect(() => {
    if (working && mode === "auto") {
      setChoices((previous) => ({ ...previous, [scope]: "open" }));
    }
  }, [scope, mode, working]);
  const choose = (next: WatchMode) =>
    setChoices((previous) => ({ ...previous, [scope]: next }));
  return {
    mode,
    working,
    open: () => choose("open"),
    close: () => choose("closed"),
    minimize: () => choose("minimized"),
  };
}
