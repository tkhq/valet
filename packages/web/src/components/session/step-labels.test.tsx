// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "./tool-call-block";
import { stepView, summaryPhrase } from "./work-group";

const root = resolve(__dirname, "../../../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
  });
}

/** Constants a tool def uses for its name, found next to the def. */
const CONSTANT_NAMES: Record<string, string> = { SKILL_TOOL_NAME: "skill", SKILL_SCRIPT_TOOL_NAME: "skill_script", WIDGET_TOOL_NAME: "show_widget" };
/** Native tools with no `defineTool` call: the engine builds them in place. */
const EXTRA = ["list_tools", "search_tools", "describe_tool", "find_replace", "call_tool", "file_attach"];

function nativeToolNames(): string[] {
  const names = new Set<string>(EXTRA);
  const dirs = ["engine", "api"].map((pkg) => join(root, "packages", pkg, "src"));
  for (const file of dirs.flatMap(sources)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/defineTool(?:<[^>]*>)?\(\s*\{\s*name:\s*(?:"([a-z_]+)"|([A-Z_]+))/g)) {
      const name = match[1] ?? CONSTANT_NAMES[match[2] ?? ""];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

function call(toolName: string, args: Record<string, unknown> = {}, status: ToolCallPart["status"] = "completed"): ToolCallPart {
  return { kind: "tool_call", callId: `c-${toolName}`, toolName, args, status };
}

describe("native tool steps", () => {
  const names = nativeToolNames();

  it("finds the native tools", () => {
    expect(names.length).toBeGreaterThan(50);
    expect(names).toEqual(expect.arrayContaining(["bash", "mem_read", "sec_start", "show_brief", "wake_at", "skill"]));
  });

  it.each(names)("%s has a specific step line", (name) => {
    for (const status of ["running", "completed"] as const) {
      const part = call(name, name === "skill" ? { name: "review" } : {}, status);
      const title = stepView(part, new Map()).title;
      expect(title, `${name} (${status}) shows the generic line "${title}". Add it to BUILTIN in work-group.tsx.`).not.toMatch(name === "skill" ? /^Used a skill/ : /^Used /);
      if (name !== "skill") expect(summaryPhrase(part).text(1)).not.toMatch(/^used /);
    }
  });
});
