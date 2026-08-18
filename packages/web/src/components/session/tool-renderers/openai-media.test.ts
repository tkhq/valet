import { describe, expect, it } from "vitest";
import { pickRenderer } from "./index";
import {
  imageDataUrl,
  isOpenaiCallTool,
  openaiActionId,
  openaiMediaRenderer,
  openaiResultData,
} from "./openai-media";

/**
 * The persisted result shape for an openai.generate_image call, byte-built
 * the way the stack actually produces it (the four-hop round trip):
 *
 *  1. plugin-openai returns `{ success, data, attachments: [image] }`;
 *     the catalog flattens it (`actionResultToToolResult`) to
 *     `{ text: JSON(data), attachments }`.
 *  2. The tool bridge (`toAgentToolResult`) converts to pi-agent-core
 *     content blocks: `[{ type: "text", text }, { type: "image", data:
 *     base64, mimeType }]`.
 *  3. thread.ts `tool_execution_end` persists
 *     `{ ...agentToolResult, text: flattenedText }`.
 *  4. The wire bridge (`engineToWireParts`) and REST (`entryToMessage`)
 *     ship `result` verbatim.
 *
 * If any hop starts reshaping image blocks, this fixture is the contract
 * that must be updated IN THE SAME CHANGE as the renderer.
 */
const B64 = "aGVsbG8="; // "hello"
const dataJson = JSON.stringify({ path: "/workspace/generated-images/1-fox.png", bytes: 5 });
const persistedImageResult = {
  content: [
    { type: "text", text: dataJson },
    { type: "image", data: B64, mimeType: "image/png" },
  ],
  details: undefined,
  text: dataJson,
};

const callArgs = {
  tool_id: "openai.generate_image",
  params: { prompt: "a red fox" },
  summary: "generate a fox image",
};

describe("openai-media renderer", () => {
  it("claims call_tool invocations with an openai.* tool_id, and nothing else", () => {
    expect(isOpenaiCallTool("call_tool", callArgs)).toBe(true);
    expect(isOpenaiCallTool("call_tool", { tool_id: "github.get_repository" })).toBe(false);
    expect(isOpenaiCallTool("bash", { command: "openai." })).toBe(false);
    expect(pickRenderer("call_tool", callArgs)).toBe(openaiMediaRenderer);
  });

  it("recovers the inline image from the persisted result shape", () => {
    expect(imageDataUrl(persistedImageResult)).toBe(`data:image/png;base64,${B64}`);
  });

  it("parses the structured data (saved path) from the flattened text", () => {
    expect(openaiResultData(persistedImageResult)).toEqual({
      path: "/workspace/generated-images/1-fox.png",
      bytes: 5,
    });
  });

  it("returns no image for text-only results (transcription, tts)", () => {
    const ttsJson = JSON.stringify({ path: "/workspace/generated-audio/1-hi.mp3", bytes: 9 });
    const persisted = { content: [{ type: "text", text: ttsJson }], details: undefined, text: ttsJson };
    expect(imageDataUrl(persisted)).toBeUndefined();
    expect(openaiResultData(persisted).path).toBe("/workspace/generated-audio/1-hi.mp3");
  });

  it("summarizes with the saved file name and targets with the prompt", () => {
    expect(openaiMediaRenderer.formatTarget(callArgs, "call_tool")).toBe("a red fox");
    expect(openaiMediaRenderer.formatSummary?.(callArgs, persistedImageResult, "completed", "call_tool")).toBe(
      "1-fox.png",
    );
  });

  it("survives streaming/partial args without throwing", () => {
    expect(openaiActionId(undefined)).toBe("");
    expect(imageDataUrl(undefined)).toBeUndefined();
    expect(openaiMediaRenderer.formatTarget({ tool_id: "openai.generate_image" }, "call_tool")).toBeUndefined();
  });
});
