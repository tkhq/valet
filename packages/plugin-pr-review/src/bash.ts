import { bashTool, type ToolDef } from "@valet/engine";
import { Type } from "typebox";

/** Longest a reviewer command may run. Searches in a checked-out repo finish well under this. */
export const REVIEW_BASH_TIMEOUT_S = 60;

const ALLOWED_ABSOLUTE = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);

/**
 * Why a command leaves the checkout, or undefined when it stays inside.
 * Each call starts in the workspace, so relative paths are fine. This keeps
 * the reviewer on task; it is not a security boundary.
 */
export function outsideRepoReason(command: string, workspace: string): string | undefined {
  const root = workspace.replace(/\/+$/, "");
  // Quoted text is a pattern or message (`grep "/api/"`, `sed -n '/a/,/b/p'`), not a path.
  const unquoted = command.replace(/'[^']*'|"[^"]*"/g, " ");
  for (const token of unquoted.split(/[\s;&|()<>`=]+/)) {
    if (token === "~" || token.startsWith("~/")) return `\`${token}\` is outside the repository`;
    if (!token.startsWith("/")) continue;
    if (ALLOWED_ABSOLUTE.has(token) || token === root || token.startsWith(`${root}/`)) continue;
    return `\`${token}\` is outside the repository`;
  }
  return undefined;
}

/**
 * The engine's `bash`, held to the checkout and to REVIEW_BASH_TIMEOUT_S per
 * command, with no background processes.
 */
export function reviewerBashTool(workspace: string): ToolDef {
  const parameters = Type.Object({
    command: Type.String(),
    timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: REVIEW_BASH_TIMEOUT_S })),
  });
  const tool: ToolDef<typeof parameters> = {
    name: "bash",
    sideEffect: "none",
    intent: "exempt",
    // The engine bash cap and preview, which a new ToolDef does not inherit.
    maxResultChars: bashTool.maxResultChars,
    resultPreview: bashTool.resultPreview,
    description:
      `Run a read-only shell command in the repository checkout (grep, rg, git log/show/diff, find, ls, sed -n). ` +
      `Paths must stay inside the repository; relative paths resolve from its root. ` +
      `Each command stops after ${REVIEW_BASH_TIMEOUT_S}s.`,
    parameters,
    execute: async (args, ctx) => {
      const outside = outsideRepoReason(args.command, workspace);
      if (outside !== undefined) {
        return { text: `Command refused: ${outside}. Search the repository with relative paths, e.g. \`rg -n name .\`.` };
      }
      const timeout = Math.min(args.timeout ?? REVIEW_BASH_TIMEOUT_S, REVIEW_BASH_TIMEOUT_S);
      return bashTool.execute({ command: args.command, timeout }, ctx);
    },
  };
  return tool;
}
