import type { McpToolPort, McpToolResult } from "@valet/engine";
import { MEMORY_MCP_ORIGIN } from "@valet/plugin-memory/mcp-tools";
import type { AppDb } from "../lib/drizzle.js";
import { readFile, searchFiles, writeFile, type MemoryScope } from "./memory.js";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provide a non-empty ${key} value and try again.`);
  }
  return value;
}

export function captureSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "capture";
}

export class MemoryMcpPort implements McpToolPort {
  constructor(
    private readonly db: AppDb,
    private readonly userId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async call(operation: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const scope: MemoryScope = {
      owner: { type: "user", id: this.userId },
      actorUserId: this.userId,
    };
    try {
      if (operation === "capture") {
        const title = stringArg(args, "title");
        const content = stringArg(args, "content");
        const day = this.clock().toISOString().slice(0, 10);
        const path = `90-inbox/${day}-${captureSlug(title)}.md`;
        const result = await writeFile(this.db, scope, {
          path,
          content,
          origin: MEMORY_MCP_ORIGIN,
          createOnly: true,
        });
        return { text: JSON.stringify({ path: result.file.path, warnings: result.warnings }) };
      }
      if (operation === "search") {
        const query = stringArg(args, "query");
        const rawLimit = args.limit;
        const limit = typeof rawLimit === "number" ? rawLimit : undefined;
        return { text: JSON.stringify(await searchFiles(this.db, scope, { query, limit })) };
      }
      if (operation === "read") {
        const path = stringArg(args, "path");
        const result = await readFile(this.db, scope, path);
        return { text: result.rendered };
      }
      throw new Error(`Unknown memory operation "${operation}". Update the memory plugin and API together.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (operation === "read") {
        throw new Error(`${message} Use mem_search to find a path you can access.`);
      }
      if (operation === "search") {
        throw new Error(`${message} Change the search query and try again.`);
      }
      throw new Error(`${message} Change the capture title or content and try again.`);
    }
  }
}
