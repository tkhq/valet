import type {
  ActionPlugin,
  BlobStore,
  CredentialStore,
  EventStream,
  SandboxProvider,
  SessionStore,
  ValetPlugin,
} from "@valet/engine";
import type { RunHost, WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import type { ChildWatcher } from "../orchestrator/children.js";
import type { ChannelHost } from "../channels/host.js";

/**
 * The full set of capabilities the API needs at runtime. Built once at boot,
 * injected per-request via `providersMiddleware`. Routes touch
 * `c.var.providers.X`; services accept `Pick<Providers, ...>` to declare the
 * exact subset they need.
 */
export interface Providers {
  db: AppDb;
  blobs: BlobStore;
  encryptionKey: string;

  // Engine-side providers — same family that @valet/engine consumes.
  engineStore: SessionStore;
  sandboxProvider: SandboxProvider;
  eventStream: EventStream;
  engineCredentials: CredentialStore;

  // Per-process Engine cache. Lives only on the server, not in engine.
  engineHost: EngineHost;
  /** Durable child-settlement watcher (Phase 4 decision 11); `rearm()` is called at boot. */
  childWatcher: ChildWatcher;
  /** Inbound/outbound channel transport routing (Task 8); `start()`/`stop()` called from main.ts. */
  channelHost: ChannelHost;

  // Workflow run host (Phase 5 plan Task 10) — leased worker loop over the
  // sqlite-backed WorkflowStore. `workflowRunHost.startHost()`/`stopHost()`
  // are called from main.ts alongside the server lifecycle.
  workflowStore: WorkflowStore;
  workflowRunHost: RunHost;

  // Assembled plugin set (plugin-system-v2 plan Task 4) — bundled registry +
  // node_modules scan (or a test override), deduped and service-indexed.
  plugins: ValetPlugin[];
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
}
