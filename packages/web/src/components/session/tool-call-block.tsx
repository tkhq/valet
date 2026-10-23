import type { MessagePart } from "@valet/api/wire";
import { pickRenderer, ToolShell } from "./tool-renderers";
import { ToolBody } from "./tool-renderers/tool-shell";
import { showsLiveBody } from "./tool-renderers/types";
import { fallbackRenderer } from "./tool-renderers/fallback";

export type ToolCallPart = Extract<MessagePart, { kind: "tool_call" }>;

/**
 * One tool call as its card: the renderer's header and body, and its
 * `Preview` below when it has one. A `bare` renderer shows only its
 * preview once the call completes.
 */
export function ToolCallBlock({ part, readOnly = false }: { part: ToolCallPart; readOnly?: boolean }) {
  const renderer = readOnly ? fallbackRenderer : pickRenderer(part.toolName, part.args);
  // A held renderer (streaming, no streamsArgs opt-in) gets a bare header:
  // formatTarget/formatSummary would compute from partial, jagged args
  // (truncated paths, churning line counts) the renderer never opted to see.
  const live = showsLiveBody(renderer, part.status);
  const target = live ? renderer.formatTarget(part.args, part.toolName) : undefined;
  const summary = live
    ? renderer.formatSummary?.(part.args, part.result, part.status, part.toolName)
    : undefined;
  const Body = renderer.Body;
  const Preview = renderer.Preview;
  if (renderer.bare && Preview && part.status === "completed") {
    return <Preview args={part.args} result={part.result} status={part.status} error={part.error} toolName={part.toolName} />;
  }

  return (
    <>
      <ToolShell
        toolName={part.toolName}
        category={renderer.category}
        Icon={renderer.Icon}
        target={target}
        summary={summary}
        status={part.status}
      >
        {live ? (
          <Body
            args={part.args}
            result={part.result}
            status={part.status}
            error={part.error}
            toolName={part.toolName}
          />
        ) : (
          // Args are still streaming and this renderer didn't opt in — hold
          // the body until the call is complete, like before streaming existed.
          <ToolBody className="text-[11px] text-muted italic font-mono">
            receiving arguments…
          </ToolBody>
        )}
      </ToolShell>
      {Preview ? (
        <Preview args={part.args} result={part.result} status={part.status} error={part.error} toolName={part.toolName} />
      ) : null}
    </>
  );
}
