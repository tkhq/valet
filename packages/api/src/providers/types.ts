import type {
  BlobStore,
  CredentialStore,
  EventStream,
  SandboxProvider,
  SessionStore,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import type { ChildWatcher } from "../orchestrator/children.js";

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
}
