import { describe, it, expect } from "vitest";
import type { Sandbox } from "@valet/engine";
import {
  MAX_INLINE_BYTES,
  buildRepoInstructionsExec,
  makeRepoInstructionsProvider,
  parseRepoInstructionsOutput,
} from "./repo-instructions.js";

const DELIM = "===VALET-AGENTS";

function makeStubSandbox(exec: Sandbox["exec"]): Sandbox {
  return {
    id: "stub",
    readFile: async () => "",
    readBinary: async () => new Uint8Array(),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec,
  };
}

describe("buildRepoInstructionsExec", () => {
  it("scans /workspace and dumps the binding root's AGENTS.md with a CLAUDE.md fallback", () => {
    const exec = buildRepoInstructionsExec("/workspace/valet");
    expect(exec).toContain("find /workspace");
    expect(exec).toContain("'/workspace/valet/AGENTS.md'");
    expect(exec).toContain("'/workspace/valet/CLAUDE.md'");
    expect(exec).toContain(DELIM);
  });

  it("shell-quotes a repo dir containing a single quote", () => {
    const exec = buildRepoInstructionsExec("/workspace/o'brien");
    // The naive interpolation `-f '/workspace/o'brien/...'` would end the
    // quoted string at the apostrophe; the double-escaped exec never
    // contains that fragment.
    expect(exec).not.toContain("-f '/workspace/o'brien");
    expect(exec).toContain("brien/AGENTS.md");
  });
});

describe("parseRepoInstructionsOutput", () => {
  it("splits found paths from the root content and excludes the root's own path", () => {
    const stdout = [
      "/workspace/valet/AGENTS.md",
      "/workspace/valet/packages/web/AGENTS.md",
      `${DELIM} /workspace/valet/AGENTS.md`,
      "# Rules",
      "Run make test.",
    ].join("\n");
    const parsed = parseRepoInstructionsOutput(stdout);
    expect(parsed).toEqual({
      content: "# Rules\nRun make test.",
      nestedPaths: ["/workspace/valet/packages/web/AGENTS.md"],
    });
  });

  it("returns null for a workspace with no instructions at all", () => {
    expect(parseRepoInstructionsOutput(`${DELIM} none\n`)).toBeNull();
  });

  it("keeps the nested list when only subprojects carry AGENTS.md", () => {
    const stdout = [
      "/workspace/valet/packages/api/AGENTS.md",
      "/workspace/valet/packages/web/AGENTS.md",
      `${DELIM} none`,
      "",
    ].join("\n");
    const parsed = parseRepoInstructionsOutput(stdout);
    expect(parsed).toEqual({
      content: "",
      nestedPaths: [
        "/workspace/valet/packages/api/AGENTS.md",
        "/workspace/valet/packages/web/AGENTS.md",
      ],
    });
  });

  it("handles a CLAUDE.md fallback root, which never appears in the found list", () => {
    const stdout = [
      "/workspace/valet/sub/AGENTS.md",
      `${DELIM} /workspace/valet/CLAUDE.md`,
      "CLAUDE-RULES",
    ].join("\n");
    const parsed = parseRepoInstructionsOutput(stdout);
    expect(parsed).toEqual({
      content: "CLAUDE-RULES",
      nestedPaths: ["/workspace/valet/sub/AGENTS.md"],
    });
  });

  it("marks over-cap content as truncated with a pointer to the full file", () => {
    // The exec dumps MAX_INLINE_BYTES + 1 bytes when the file is larger.
    const raw = "a".repeat(MAX_INLINE_BYTES + 1);
    const stdout = `${DELIM} /workspace/valet/AGENTS.md\n${raw}`;
    const parsed = parseRepoInstructionsOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.content.startsWith("a".repeat(100))).toBe(true);
    expect(parsed!.content).toContain("[truncated — read /workspace/valet/AGENTS.md for the full file]");
    expect(parsed!.content.length).toBeLessThanOrEqual(MAX_INLINE_BYTES + 200);
  });

  it("keeps at-cap content untouched", () => {
    const raw = "b".repeat(MAX_INLINE_BYTES);
    const stdout = `${DELIM} /workspace/valet/AGENTS.md\n${raw}`;
    const parsed = parseRepoInstructionsOutput(stdout);
    expect(parsed!.content).toBe(raw);
  });

  it("tolerates a delimiter-lookalike inside the content", () => {
    const stdout = [
      `${DELIM} /workspace/valet/AGENTS.md`,
      "before",
      `${DELIM} /tricky/path`,
      "after",
    ].join("\n");
    const parsed = parseRepoInstructionsOutput(stdout);
    // Only the FIRST marker splits; everything after it is content verbatim.
    expect(parsed!.content).toBe(`before\n${DELIM} /tricky/path\nafter`);
  });

  it("throws on output with no marker (malformed scan)", () => {
    expect(() => parseRepoInstructionsOutput("just some text\n")).toThrow(/marker/);
  });
});

describe("makeRepoInstructionsProvider", () => {
  it("parses a successful scan against the normalized binding root", async () => {
    let seenCommand = "";
    const sandbox = makeStubSandbox(async (command) => {
      seenCommand = command;
      return {
        stdout: `/workspace/valet/AGENTS.md\n${DELIM} /workspace/valet/AGENTS.md\nRULES`,
        stderr: "",
        exitCode: 0,
      };
    });
    const provider = makeRepoInstructionsProvider(() => sandbox, "valet");
    const result = await provider();
    expect(result).toEqual({ content: "RULES", nestedPaths: [] });
    expect(seenCommand).toContain("'/workspace/valet/AGENTS.md'");
  });

  it('normalizes the legacy "." target dir to the workspace root', async () => {
    let seenCommand = "";
    const sandbox = makeStubSandbox(async (command) => {
      seenCommand = command;
      return { stdout: `${DELIM} none\n`, stderr: "", exitCode: 0 };
    });
    const provider = makeRepoInstructionsProvider(() => sandbox, ".");
    await provider();
    expect(seenCommand).toContain("'/workspace/AGENTS.md'");
    expect(seenCommand).not.toContain("'/workspace//AGENTS.md'");
  });

  it("throws when the sandbox is not ready, leaving previous instructions serving", async () => {
    const provider = makeRepoInstructionsProvider(() => undefined, "valet");
    await expect(provider()).rejects.toThrow(/not ready/);
  });

  it("throws on a failed exec", async () => {
    const sandbox = makeStubSandbox(async () => ({ stdout: "", stderr: "sh: boom", exitCode: 1 }));
    const provider = makeRepoInstructionsProvider(() => sandbox, "valet");
    await expect(provider()).rejects.toThrow(/exited 1/);
  });
});
