/** Session browser control and evidence. See 2026-09-23-sandbox-browser-design.md. */
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { browserRequest, readBrowserExport } from "@valet/plugin-browser";
import type {
  BrowserIdentity,
  BrowserRequest,
  BrowserSettings,
} from "@valet/shared";
import type { AppEnv } from "../env.js";
import type {
  SessionBrowserResponse,
  BrowserAnnotation,
} from "../wire/types.js";
import {
  renderBrowserAnnotation,
  validateAnnotationMarks,
} from "../services/browser-annotations.js";
import { loadOwnedSession } from "./messages.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { canAdministerSession } from "../services/session-access.js";
import {
  mintBrowserTicket,
  verifyBrowserTicket,
} from "../services/browser-ticket.js";
import { decodeBrowserFrame } from "../services/browser-frame.js";
import { pluginStore } from "../services/plugin-store.js";
import type { BrowserArtifact } from "@valet/shared";

export const browserRouter = new Hono<AppEnv>();
const id = Type.String({ minLength: 1, maxLength: 256 });
const controlSchema = Type.Object({
  action: Type.Union(
    ["take", "release", "pause", "resume"].map((v) => Type.Literal(v)),
  ),
  leaseId: Type.Optional(id),
  privateMode: Type.Optional(Type.Boolean()),
});
const tabSchema = Type.Object({
  action: Type.Union(["new", "close", "select"].map((v) => Type.Literal(v))),
  leaseId: Type.Optional(id),
  runtimeId: id,
  tabId: Type.Optional(id),
  url: Type.Optional(Type.String({ maxLength: 8192 })),
});
const keySchema = Type.Object({
  type: Type.Literal("key"),
  key: Type.String({ minLength: 1, maxLength: 100 }),
  phase: Type.Optional(
    Type.Union([
      Type.Literal("down"),
      Type.Literal("up"),
      Type.Literal("press"),
    ]),
  ),
});
const point = {
  x: Type.Number({ minimum: 0, maximum: 20_000 }),
  y: Type.Number({ minimum: 0, maximum: 20_000 }),
};
const button = Type.Optional(
  Type.Union([
    Type.Literal("left"),
    Type.Literal("middle"),
    Type.Literal("right"),
  ]),
);
const inputSchema = Type.Object({
  leaseId: Type.Optional(id),
  runtimeId: id,
  tabId: id,
  documentId: id,
  input: Type.Union([
    Type.Object({ type: Type.Literal("click"), ...point, button }),
    Type.Object({ type: Type.Literal("move"), ...point }),
    Type.Object({
      type: Type.Literal("pointer"),
      ...point,
      button,
      phase: Type.Union([
        Type.Literal("down"),
        Type.Literal("up"),
        Type.Literal("move"),
      ]),
    }),
    Type.Object({
      type: Type.Literal("wheel"),
      deltaX: Type.Number(),
      deltaY: Type.Number(),
    }),
    Type.Object({
      type: Type.Literal("text"),
      text: Type.String({ maxLength: 100_000 }),
    }),
    keySchema,
    Type.Object({
      type: Type.Union([
        Type.Literal("back"),
        Type.Literal("forward"),
        Type.Literal("reload"),
      ]),
    }),
    Type.Object({
      type: Type.Literal("navigate"),
      url: Type.String({ maxLength: 8192 }),
    }),
    Type.Object({
      type: Type.Literal("dialog"),
      dialogId: id,
      accept: Type.Boolean(),
      text: Type.Optional(Type.String({ maxLength: 10_000 })),
    }),
  ]),
});
const settingsSchema = Type.Object({
  enabled: Type.Boolean(),
  audience: Type.Union([Type.Literal("owner"), Type.Literal("team")]),
  grants: Type.Array(
    Type.Object({
      id,
      origin: Type.String({ maxLength: 8192 }),
      expiresAt: Type.Number(),
      operations: Type.Array(
        Type.Union(
          [
            "observation",
            "navigation",
            "mutation",
            "upload",
            "page_tool",
            "export",
            "history",
            "diagnostic",
          ].map((v) => Type.Literal(v)),
        ),
      ),
    }),
    { maxItems: 100 },
  ),
});

async function body<T extends TSchema>(
  c: Context<AppEnv>,
  schema: T,
): Promise<Static<T>> {
  const parsed: unknown = await c.req.json().catch(() => null);
  if (!Value.Check(schema, parsed))
    throw new HTTPException(400, {
      message:
        "Invalid browser request. Check the browser API fields and retry.",
    });
  const properties: unknown = Reflect.get(schema, "properties");
  if (
    properties &&
    typeof properties === "object" &&
    parsed &&
    typeof parsed === "object" &&
    Object.keys(parsed).some((key) => !Object.hasOwn(properties, key))
  ) {
    throw new HTTPException(400, {
      message:
        "Unknown browser request field. Send only the documented fields.",
    });
  }
  return parsed;
}

browserRouter.use("/:id/browser/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("origin");
  if (origin) {
    const allowed = [
      new URL(c.req.url).origin,
      ...(process.env.AUTH_TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim()),
    ];
    if (process.env.VALET_LOCAL_AUTH === "1")
      allowed.push("http://localhost:5173");
    if (!allowed.includes(origin))
      return c.json(
        {
          error:
            "Browser origin is not trusted. Open the browser from the Valet app.",
        },
        403,
      );
  }
  await next();
});
browserRouter.onError((error, c) =>
  c.json(
    { error: error.message },
    error instanceof HTTPException ? error.status : 409,
  ),
);

async function context(
  c: Context<AppEnv>,
  mode: "status" | "active" | "start" | "settings" = "active",
) {
  const session = await loadOwnedSession(c);
  if (!session)
    throw new HTTPException(404, {
      message: "Session not found. Open a session you can access.",
    });
  if (c.var.principal.type !== "user")
    throw new HTTPException(403, {
      message: "Browser access requires a user identity. Sign in to Valet.",
    });
  const { engineHost, engineStore, sandboxProvider, db } = c.var.providers;
  const policy = engineHost.browserPolicy();
  if (!policy)
    throw new HTTPException(409, {
      message: "Browser policy is unavailable. Configure the Valet database.",
    });
  const identity: BrowserIdentity = {
    protocolVersion: "1.0",
    audience: "viewer",
    sessionId: session.id,
    threadId: `viewer:${c.var.user.id}`,
    actorId: c.var.user.id,
    ownerId: session.ownerId,
  };
  const enabled =
    sandboxProvider.capabilities().browserAutomation === true &&
    !session.docker &&
    !session.kubernetes;
  const settings = await policy.settings(session.id);
  const canAdminister = await canAdministerSession(
    db,
    session,
    c.var.principal,
  );
  let engineSession = engineHost.liveSession(session.id);
  if (mode === "start" || mode === "settings") {
    engineSession = await engineHost.sessionFor(
      session.id,
      await loadSessionMeta(db, session),
    );
  }
  // Metadata reads do not create a session or wake compute.
  if (mode !== "status" && mode !== "settings") {
    if (!enabled)
      throw new HTTPException(409, {
        message:
          "This sandbox provider has no browser. Select Docker or Kubernetes with a browser image.",
      });
    if (!(await engineStore.getSession(session.id)))
      throw new HTTPException(409, {
        message: "The browser is not running. Start it from the Browser tab.",
      });
    await policy.authorize(identity);
  }
  if (mode === "start" && engineSession) {
    await engineSession.attachment.ensureReady({
      timeoutMs: 120_000,
      signal: c.req.raw.signal,
    });
    await engineHost.markSessionUsed(session.id);
  }
  const attached = engineSession?.attachment.current() ?? null;
  const sandbox = attached && engineSession ? engineSession.sandbox : null;
  if (mode === "active" && !sandbox)
    throw new HTTPException(409, {
      message: "The browser is sleeping. Start it from the Browser tab.",
    });
  return {
    session,
    identity,
    policy,
    settings,
    enabled,
    canAdminister,
    sandbox,
    attached,
  };
}

async function status(c: Context<AppEnv>, start = false) {
  const ctx = await context(c, start ? "start" : "status");
  const result: SessionBrowserResponse = {
    enabled: ctx.enabled,
    actorId: ctx.identity.actorId,
    canAdminister: ctx.canAdminister,
    settings: ctx.settings,
    status: null,
  };
  if (ctx.enabled && ctx.sandbox && ctx.attached) {
    try {
      await ctx.policy.authorize(ctx.identity);
      if (
        start ||
        (
          await ctx.attached.exec(
            "test -S /var/lib/valet/browser/browser.sock",
            { timeout: 5000, privileged: true },
          )
        ).exitCode === 0
      ) {
        result.status =
          (
            await browserRequest(
              ctx.sandbox,
              { ...ctx.identity, command: "status" },
              c.req.raw.signal,
            )
          ).status ?? null;
      }
    } catch (error) {
      result.error =
        error instanceof Error
          ? error.message
          : "The browser is unavailable. Restart the browser.";
    }
  }
  return c.json(result);
}
browserRouter.get("/:id/browser", (c) => status(c));
browserRouter.post("/:id/browser/start", (c) => status(c, true));
browserRouter.patch("/:id/browser/settings", async (c) => {
  const ctx = await context(c, "settings");
  const update = await body(c, Type.Partial(settingsSchema));
  // TypeBox's mapped literal arrays are checked at runtime; persist the shared shape.
  await ctx.policy.updateSettings(ctx.identity, {
    ...ctx.settings,
    ...update,
  } as Omit<BrowserSettings, "policyVersion">);
  if (
    ctx.sandbox &&
    (
      await ctx.sandbox.exec("test -S /var/lib/valet/browser/browser.sock", {
        timeout: 5000,
        privileged: true,
      })
    ).exitCode === 0
  ) {
    await browserRequest(ctx.sandbox, {
      ...ctx.identity,
      audience: "lifecycle",
      command: "revoke",
    });
  }
  return c.json({
    enabled: ctx.enabled,
    actorId: ctx.identity.actorId,
    canAdminister: ctx.canAdminister,
    settings: await ctx.policy.settings(ctx.session.id),
    status: null,
  } satisfies SessionBrowserResponse);
});

async function send(
  c: Context<AppEnv>,
  request: (identity: BrowserIdentity) => BrowserRequest,
) {
  const ctx = await context(c);
  if (!ctx.sandbox)
    throw new HTTPException(409, {
      message: "Start the browser before sending input.",
    });
  const response = await browserRequest(
    ctx.sandbox,
    request(ctx.identity),
    c.req.raw.signal,
  );
  c.var.providers.engineHost.touchGatewayActivity(ctx.session.id);
  return c.json(response);
}
browserRouter.post("/:id/browser/control", async (c) => {
  const data = await body(c, controlSchema);
  return send(c, (identity) => ({
    ...data,
    ...identity,
    command: "control",
    action: data.action as "take" | "release" | "pause" | "resume",
  }));
});
browserRouter.post("/:id/browser/tab", async (c) => {
  const data = await body(c, tabSchema);
  return send(c, (identity) => ({
    ...data,
    ...identity,
    command: "tab",
    action: data.action as "new" | "close" | "select",
  }));
});
browserRouter.post("/:id/browser/input", async (c) => {
  const data = await body(c, inputSchema);
  return send(c, (identity) => ({ ...data, ...identity, command: "input" }));
});
browserRouter.post("/:id/browser/ticket", async (c) => {
  const ctx = await context(c);
  const data = await body(
    c,
    Type.Object({
      scope: Type.Union([Type.Literal("view"), Type.Literal("control")]),
    }),
  );
  if (!ctx.sandbox)
    throw new HTTPException(409, {
      message: "Start the browser before opening its viewer.",
    });
  const response = await browserRequest(ctx.sandbox, {
    ...ctx.identity,
    command: "status",
  });
  return c.json(
    mintBrowserTicket(c.var.providers.encryptionKey, {
      sessionId: ctx.session.id,
      actorId: ctx.identity.actorId,
      runtimeId: response.runtimeId,
      policyVersion: ctx.settings.policyVersion,
      scope: data.scope,
    }),
  );
});
browserRouter.get("/:id/browser/frame", async (c) => {
  const ctx = await context(c);
  const runtimeId = c.req.query("runtimeId") ?? "";
  const tabId = c.req.query("tabId") ?? "";
  if (
    !verifyBrowserTicket(
      c.var.providers.encryptionKey,
      c.req.header("x-browser-ticket") ?? "",
      {
        sessionId: ctx.session.id,
        actorId: ctx.identity.actorId,
        runtimeId,
        policyVersion: ctx.settings.policyVersion,
        scope: "view",
      },
    )
  ) {
    throw new HTTPException(403, {
      message: "The browser viewer ticket expired. Reopen the Browser tab.",
    });
  }
  if (!ctx.sandbox)
    throw new HTTPException(409, {
      message: "Start the browser before opening its viewer.",
    });
  const response = await browserRequest(
    ctx.sandbox,
    { ...ctx.identity, command: "frame", runtimeId, tabId, inline: true },
    c.req.raw.signal,
  );
  if (response.runtimeId !== runtimeId)
    throw new HTTPException(409, {
      message: "The browser runtime changed. Reopen the browser viewer.",
    });
  const frame = decodeBrowserFrame(response.frame, tabId);
  return new Response(frame.data, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(frame.data.length),
      "cache-control": "no-store",
      "x-browser-document-id": frame.documentId,
      "x-browser-runtime-id": response.runtimeId,
      "x-browser-viewport-width": String(frame.viewport.width),
      "x-browser-viewport-height": String(frame.viewport.height),
    },
  });
});
browserRouter.get("/:id/browser/evidence/:artifactId", async (c) => {
  const ctx = await context(c, "status");
  await ctx.policy.authorize(ctx.identity);
  const artifactId = c.req.param("artifactId");
  const saved = await pluginStore(c.var.providers.db, "browser")
    .session(ctx.session.id)
    .get<BrowserArtifact>("evidence", artifactId);
  if (!saved)
    throw new HTTPException(404, {
      message: "Browser evidence was not retained. Capture new evidence.",
    });
  const blob = await c.var.providers.blobs.get(
    ctx.policy.evidenceKey(ctx.session.id, artifactId),
  );
  if (!blob)
    throw new HTTPException(404, {
      message: "Browser evidence is missing. Capture new evidence.",
    });
  return new Response(blob.data, { headers: artifactHeaders(saved.doc) });
});

browserRouter.post("/:id/browser/evidence", async (c) => {
  const data = await body(c, Type.Object({ tabId: id, runtimeId: id }));
  const ctx = await context(c);
  if (!ctx.sandbox)
    throw new HTTPException(409, {
      message: "Start the browser before capturing evidence.",
    });
  const response = await browserRequest(
    ctx.sandbox,
    { ...ctx.identity, command: "evidence", ...data },
    c.req.raw.signal,
  );
  if (!response.artifact)
    throw new HTTPException(409, {
      message: "The page has no screenshot. Select a browser tab.",
    });
  try {
    const bytes = await readBrowserExport(ctx.sandbox, response.artifact);
    return c.json(
      await ctx.policy.persistArtifact(ctx.identity, response.artifact, bytes),
    );
  } finally {
    await browserRequest(ctx.sandbox, {
      ...ctx.identity,
      command: "ack",
      transferId: response.artifact.transferId,
    });
  }
});

function artifactHeaders(artifact: BrowserArtifact): Record<string, string> {
  const disposition = ["image/png", "image/jpeg", "image/webp"].includes(
    artifact.mimeType,
  )
    ? "inline"
    : "attachment";
  return {
    "content-type": artifact.mimeType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": `${disposition}; filename="${artifact.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
  };
}

browserRouter.get("/:id/browser/downloads/:artifactId", async (c) => {
  const ctx = await context(c);
  if (!ctx.sandbox)
    throw new HTTPException(409, {
      message: "Start the browser before downloading a file.",
    });
  const exported = await browserRequest(
    ctx.sandbox,
    {
      ...ctx.identity,
      command: "export",
      artifactId: c.req.param("artifactId"),
    },
    c.req.raw.signal,
  );
  if (!exported.artifact)
    throw new HTTPException(404, {
      message: "The browser download is missing. Download the file again.",
    });
  try {
    const data = await readBrowserExport(ctx.sandbox, exported.artifact);
    await ctx.policy.persistArtifact(ctx.identity, exported.artifact, data);
    return new Response(Buffer.from(data), {
      headers: artifactHeaders(exported.artifact),
    });
  } finally {
    await browserRequest(ctx.sandbox, {
      ...ctx.identity,
      command: "ack",
      transferId: exported.artifact.transferId,
    });
  }
});

browserRouter.post(
  "/:id/browser/evidence/:artifactId/annotations",
  async (c) => {
    const ctx = await context(c, "status");
    await ctx.policy.authorize(ctx.identity);
    const data = await body(
      c,
      Type.Object({
        documentId: id,
        marks: Type.Array(
          Type.Object({
            x: Type.Number(),
            y: Type.Number(),
            label: Type.String({ maxLength: 200 }),
          }),
          { minItems: 1, maxItems: 50 },
        ),
      }),
    );
    const artifactId = c.req.param("artifactId");
    const store = pluginStore(c.var.providers.db, "browser").session(
      ctx.session.id,
    );
    const artifact = (await store.get<BrowserArtifact>("evidence", artifactId))
      ?.doc;
    if (!artifact || artifact.documentId !== data.documentId)
      throw new HTTPException(409, {
        message:
          "The screenshot document changed. Reopen the original evidence before adding annotations.",
      });
    validateAnnotationMarks(artifact, data.marks);
    let stale = true;
    if (ctx.sandbox) {
      const live = await browserRequest(ctx.sandbox, {
        ...ctx.identity,
        command: "status",
      });
      stale =
        live.runtimeId !== artifact.runtimeId ||
        !live.status?.tabs.some(
          (tab) =>
            tab.id === artifact.tabId && tab.documentId === artifact.documentId,
        );
    }
    const annotation: BrowserAnnotation = {
      id: randomUUID(),
      artifactId,
      documentId: data.documentId,
      marks: data.marks,
      createdAt: Date.now(),
      stale,
    };
    await store.put(
      "annotations",
      `${artifactId}:${annotation.id}`,
      annotation,
    );
    return c.json(annotation);
  },
);
browserRouter.get(
  "/:id/browser/evidence/:artifactId/annotations",
  async (c) => {
    const ctx = await context(c, "status");
    await ctx.policy.authorize(ctx.identity);
    const store = pluginStore(c.var.providers.db, "browser").session(
      ctx.session.id,
    );
    const artifactId = c.req.param("artifactId");
    const artifact = (await store.get<BrowserArtifact>("evidence", artifactId))
      ?.doc;
    const page = await store.list<BrowserAnnotation>("annotations", {
      prefix: `${artifactId}:`,
      limit: 1000,
    });
    let stale = true;
    if (
      ctx.sandbox &&
      artifact &&
      (
        await ctx.sandbox.exec("test -S /var/lib/valet/browser/browser.sock", {
          timeout: 5000,
          privileged: true,
        })
      ).exitCode === 0
    ) {
      const live = await browserRequest(ctx.sandbox, {
        ...ctx.identity,
        command: "status",
      });
      stale =
        live.runtimeId !== artifact.runtimeId ||
        !live.status?.tabs.some(
          (tab) =>
            tab.id === artifact.tabId && tab.documentId === artifact.documentId,
        );
    }
    return c.json({
      annotations: page.items.map((item) => ({ ...item.doc, stale })),
    });
  },
);
browserRouter.get(
  "/:id/browser/evidence/:artifactId/annotations/:annotationId/export",
  async (c) => {
    const ctx = await context(c, "status");
    await ctx.policy.authorize(ctx.identity);
    const artifactId = c.req.param("artifactId");
    const store = pluginStore(c.var.providers.db, "browser").session(
      ctx.session.id,
    );
    const annotation = (
      await store.get<BrowserAnnotation>(
        "annotations",
        `${artifactId}:${c.req.param("annotationId")}`,
      )
    )?.doc;
    const artifact = (await store.get<BrowserArtifact>("evidence", artifactId))
      ?.doc;
    if (!annotation || !artifact)
      throw new HTTPException(404, {
        message:
          "The annotation is missing. Open a saved screenshot annotation.",
      });
    const blob = await c.var.providers.blobs.get(
      ctx.policy.evidenceKey(ctx.session.id, artifactId),
    );
    if (!blob)
      throw new HTTPException(404, {
        message: "The screenshot is missing. Capture new evidence.",
      });
    const bytes = new Uint8Array(await new Response(blob.data).arrayBuffer());
    return new Response(
      renderBrowserAnnotation(artifact, bytes, annotation.marks),
      {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "private, no-store",
          "content-disposition":
            'attachment; filename="browser-annotation.svg"',
          "content-security-policy": "sandbox; default-src 'none'",
        },
      },
    );
  },
);
