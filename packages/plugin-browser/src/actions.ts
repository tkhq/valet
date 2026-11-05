import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  ActionPlugin,
  PluginActionContext,
  PluginActionResult,
  ToolAttachment,
} from "@valet/engine";
import type {
  BrowserArtifact,
  BrowserIdentity,
  BrowserPolicyRequest,
  BrowserResponse,
} from "@valet/shared";
import { browserRequest, readBrowserExport } from "./client.js";

export function browserIdentity(
  ctx: Pick<PluginActionContext, "owner" | "userId" | "sessionId" | "threadId">,
): BrowserIdentity {
  if (!ctx.owner)
    throw new Error(
      "Browser ownership is unavailable. Reopen the session before using the browser.",
    );
  return {
    protocolVersion: "1.0",
    sessionId: ctx.sessionId,
    threadId: ctx.threadId,
    actorId: ctx.userId,
    ownerId: ctx.owner.id,
  };
}

async function authorize(ctx: PluginActionContext) {
  if (!ctx.browserPolicy)
    throw new Error(
      "Browser policy is unavailable. Enable the browser service on the Valet host.",
    );
  const identity = browserIdentity(ctx);
  const access = await ctx.browserPolicy.authorize(identity);
  return { identity, policy: ctx.browserPolicy, ...access };
}

function verifyApproval(
  request: BrowserPolicyRequest,
  identity: BrowserIdentity,
  invocationId: string,
) {
  if (
    request.sessionId !== identity.sessionId ||
    request.threadId !== identity.threadId ||
    request.actorId !== identity.actorId ||
    request.ownerId !== identity.ownerId ||
    request.invocationId !== invocationId
  ) {
    throw new Error(
      "The browser operation has a different owner. Reset the browser runtime before continuing.",
    );
  }
}

export async function executeBrowser(
  args: { code: string; title: string; timeout_ms?: number },
  ctx: PluginActionContext,
): Promise<PluginActionResult> {
  try {
    return await executeCell(args, ctx);
  } catch (error) {
    // An engine decision suspension does not abort the tool signal. Keep that
    // cell paused. A user abort must reach the daemon even when polling threw.
    if (ctx.signal.aborted && ctx.invocationId && ctx.owner) {
      await browserRequest(ctx.sandbox, {
        ...browserIdentity(ctx),
        command: "cancel",
        invocationId: ctx.invocationId,
      }).catch(() => {});
    }
    throw error;
  }
}

async function executeCell(
  args: { code: string; title: string; timeout_ms?: number },
  ctx: PluginActionContext,
): Promise<PluginActionResult> {
  const invocationId = ctx.invocationId;
  if (!invocationId)
    throw new Error(
      "A durable browser invocation ID is required. Run this action through an agent tool call.",
    );
  const { identity, policy, policyVersion } = await authorize(ctx);
  let response = await browserRequest(
    ctx.sandbox,
    {
      ...identity,
      command: "submit",
      invocationId,
      code: args.code,
      title: args.title,
      timeoutMs: args.timeout_ms,
      policyVersion,
    },
    ctx.signal,
  );
  const text: string[] = [];
  const attachments: ToolAttachment[] = [];
  const artifacts: BrowserArtifact[] = [];
  const seenArtifacts = new Set<string>();
  let inlineBytes = 0;
  let cursor = 0;
  let processedCursor = 0;
  let textCharacters = 0;
  // Resolve replies can carry the final events. Process them before polling again.
  const pending: BrowserResponse[] = [];
  let drainEvents = false;
  for (;;) {
    if (response.gap)
      throw new Error(
        "Browser output exceeded the retained event window. Inspect browser status; do not repeat the cell.",
      );
    cursor = Math.max(cursor, response.cursor);
    for (const event of response.events) {
      if (event.cursor <= processedCursor) continue;
      processedCursor = event.cursor;
      if (event.type === "text" && textCharacters < 100_000) {
        const bounded = event.text.slice(0, 100_000 - textCharacters);
        text.push(bounded);
        textCharacters += bounded.length;
      }
      if (event.type === "operation")
        await policy.audit(identity, event.receipt);
      if (event.type === "approval") {
        const request = event.request;
        verifyApproval(request, identity, invocationId);
        const receipt = response.cell?.operations.find(
          (entry) => entry.operationId === request.operationId,
        );
        if (receipt && receipt.status !== "awaiting_approval") continue;
        const resolved = await policy.decide(request);
        let decision: "allow" | "deny" =
          resolved.decision === "allow" ? "allow" : "deny";
        let version = resolved.policyVersion;
        if (resolved.decision === "ask") {
          // A suspension propagates untouched. The daemon keeps the cell and operation paused.
          const answer = await ctx.requestDecision({
            type: "approval",
            title: `Browser: ${request.method}`,
            body: `${request.operationClass} on ${request.origin || "the current page"}: ${request.target}`,
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
            expiresAt: request.expiresAt,
            resumeKey: `browser:${invocationId}:${request.operationId}:${request.hash}`,
            context: { browser: request },
          });
          if (answer.actionId === "allow") {
            const approved = await policy.approve(request, answer.resolvedBy);
            version = approved.policyVersion;
            decision = "allow";
          }
        }
        pending.push(
          await browserRequest(
            ctx.sandbox,
            {
              ...identity,
              command: "resolve",
              invocationId,
              operationId: request.operationId,
              hash: request.hash,
              runtimeId: request.runtimeId,
              decision,
              policyVersion: version,
              expiresAt: request.expiresAt,
            },
            ctx.signal,
          ),
        );
        drainEvents = true;
      }
      if (event.type === "artifact" && !seenArtifacts.has(event.artifact.id)) {
        seenArtifacts.add(event.artifact.id);
        const exported = await browserRequest(
          ctx.sandbox,
          { ...identity, command: "export", artifactId: event.artifact.id },
          ctx.signal,
        );
        if (!exported.artifact)
          throw new Error(
            "The browser export is missing. Capture new browser evidence.",
          );
        try {
          const bytes = await readBrowserExport(ctx.sandbox, exported.artifact);
          artifacts.push(
            await policy.persistArtifact(identity, event.artifact, bytes),
          );
          if (
            ["image/png", "image/jpeg", "image/webp"].includes(
              event.artifact.mimeType,
            ) &&
            attachments.length < 2 &&
            inlineBytes + bytes.byteLength <= 8 * 1024 * 1024
          ) {
            attachments.push({
              type: "image",
              data: bytes,
              mimeType: event.artifact.mimeType,
              name: event.artifact.filename,
            });
            inlineBytes += bytes.byteLength;
          } else if (event.artifact.mimeType.startsWith("image/")) {
            text.push(
              `Saved ${event.artifact.filename} as durable evidence. Open its artifact link to inspect images beyond this result's inline limit.`,
            );
          }
        } finally {
          await browserRequest(ctx.sandbox, {
            ...identity,
            command: "ack",
            transferId: exported.artifact.transferId,
          });
        }
      }
    }
    const queued = pending.shift();
    if (queued) {
      response = queued;
      continue;
    }
    if (drainEvents) {
      drainEvents = false;
      response = await browserRequest(
        ctx.sandbox,
        {
          ...identity,
          command: "events",
          invocationId,
          after: cursor,
          waitMs: 0,
        },
        ctx.signal,
      );
      continue;
    }
    const cell = response.cell;
    if (cell && !["running", "awaiting_approval"].includes(cell.status)) {
      // A terminal receipt can precede the last page of retained events.
      // Drain until an empty batch so screenshots and receipts are not lost.
      if (response.events.length > 0) {
        response = await browserRequest(
          ctx.sandbox,
          {
            ...identity,
            command: "events",
            invocationId,
            after: cursor,
            waitMs: 0,
          },
          ctx.signal,
        );
        continue;
      }
      const success = cell.status === "completed";
      return {
        success,
        data: {
          sessionId: ctx.sessionId,
          text: text.join("\n"),
          artifacts,
          cell,
        },
        attachments,
        ...(success
          ? {}
          : {
              error: `${cell.error?.message ?? `Browser cell ${cell.status}.`} ${cell.error?.correctiveAction ?? "Inspect browser status before starting another cell."}`,
            }),
      };
    }
    if (ctx.signal.aborted) {
      await browserRequest(ctx.sandbox, {
        ...identity,
        command: "cancel",
        invocationId,
      });
      ctx.signal.throwIfAborted();
    }
    // Recheck live membership and grants during long-running cells.
    try {
      await policy.authorize(identity);
    } catch (error) {
      await browserRequest(ctx.sandbox, {
        ...identity,
        audience: "lifecycle",
        command: "revoke",
      }).catch(() => {});
      throw error;
    }
    response = await browserRequest(
      ctx.sandbox,
      {
        ...identity,
        command: "events",
        invocationId,
        after: cursor,
        waitMs: 1000,
      },
      ctx.signal,
    );
  }
}

const executeSchema = Type.Object({
  code: Type.String({ maxLength: 100_000 }),
  title: Type.String({ maxLength: 200 }),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000 })),
});
const describeSchema = Type.Object({
  topic: Type.Optional(Type.String({ maxLength: 100 })),
});
const resetSchema = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 200 })),
});

export const browserPlugin: ActionPlugin = {
  service: "browser",
  description:
    "Persistent sandbox browser cells, page observations, screenshots and human control.",
  actions: [
    {
      id: "browser.execute",
      name: "Browser",
      riskLevel: "low",
      description:
        "Run JavaScript in the persistent browser REPL. Call browser.describe first for the API. Browser operations are authorized individually.",
      parameters: executeSchema,
      execute: async (args, ctx) => {
        if (!Value.Check(executeSchema, args))
          throw new Error("Invalid browser cell. Supply code and a title.");
        return executeBrowser(args, ctx);
      },
    },
    {
      id: "browser.describe",
      name: "Browser API",
      riskLevel: "low",
      description:
        "Read the installed browser API, limits, and capabilities before controlling a page.",
      parameters: describeSchema,
      execute: async (args, ctx) => {
        if (!Value.Check(describeSchema, args))
          throw new Error("Invalid browser topic. Supply a string.");
        const { identity } = await authorize(ctx);
        const response = await browserRequest(
          ctx.sandbox,
          { ...identity, command: "describe", topic: args.topic },
          ctx.signal,
        );
        return {
          success: true,
          data: {
            sessionId: ctx.sessionId,
            text: response.description,
            status: response.status,
          },
        };
      },
    },
    {
      id: "browser.reset",
      name: "Reset Browser REPL",
      riskLevel: "low",
      description:
        "Reset this thread’s JavaScript bindings. Browser tabs and the signed-in profile remain available.",
      parameters: resetSchema,
      execute: async (args, ctx) => {
        if (!Value.Check(resetSchema, args))
          throw new Error("Invalid browser reset reason. Supply a string.");
        const { identity } = await authorize(ctx);
        const response = await browserRequest(
          ctx.sandbox,
          { ...identity, command: "reset", reason: args.reason },
          ctx.signal,
        );
        return {
          success: true,
          data: response.status ?? { text: "Browser REPL reset." },
        };
      },
    },
  ],
};
