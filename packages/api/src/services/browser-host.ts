import type { BlobStore, CreateSessionOptions, PluginStore, Sandbox, SandboxProvider, SessionStore } from '@valet/engine';
import type { BrowserAuditEntry, BrowserIdentity } from '@valet/shared';
import { browserRequest } from '@valet/plugin-browser';
import type { AppDb } from '../lib/drizzle.js';
import { BrowserPolicy } from './browser-policy.js';
import { pluginStore } from './plugin-store.js';
import { canAdministerTeam, isTeamMember } from './teams.js';

export function createBrowserPolicy(db: AppDb, sessions: SessionStore, blobs?: BlobStore): BrowserPolicy {
  return new BrowserPolicy({
    store: pluginStore(db, 'browser'), blobs,
    owner: async (id) => (await sessions.getSession(id))?.owner ?? null,
    isMember: (owner, actorId) => owner.type === 'team' ? isTeamMember(db, owner.id, actorId) : Promise.resolve(owner.type === 'user' && owner.id === actorId),
    isAdmin: (owner, actorId) => owner.type === 'team' ? canAdministerTeam(db, owner.id, actorId) : Promise.resolve(owner.type === 'user' && owner.id === actorId),
  });
}

async function hasBrowser(sandbox: Sandbox): Promise<boolean> {
  const probe = await sandbox.exec('test -S /var/lib/valet/browser/browser.sock', { timeout: 5000, privileged: true });
  return probe.exitCode === 0;
}

interface CleanupRecord { identity: BrowserIdentity }
interface AuditCheckpoint { key: string; sessionId: string; sandboxId: string }

async function hasAuditCheckpoint(sessionId: string, sandboxId: string, blobs?: BlobStore, store?: PluginStore): Promise<boolean> {
  const checkpoint = (await store?.session(sessionId).get<AuditCheckpoint>('audit_exports', sandboxId))?.doc;
  if (checkpoint?.sessionId !== sessionId || checkpoint.sandboxId !== sandboxId || !blobs) return false;
  const blob = await blobs.get(checkpoint.key);
  if (!blob) return false;
  await blob.data.cancel();
  return true;
}

async function exportAudit(sessionId: string, sandboxId: string, snapshot: { entries: BrowserAuditEntry[]; total: number; runtimeId?: string }, blobs?: BlobStore, store?: PluginStore): Promise<void> {
  if (!blobs || !store) throw new Error('Browser audit storage is unavailable. Configure the blob store and database before deleting the sandbox.');
  if (snapshot.entries.length !== snapshot.total) throw new Error('Browser audit export is incomplete. Restore the browser runtime and export every audit page before deleting the sandbox.');
  const key = `browser-audit/${encodeURIComponent(sessionId)}/${encodeURIComponent(sandboxId)}-${encodeURIComponent(snapshot.runtimeId ?? 'retained')}.json`;
  await blobs.put(key, new TextEncoder().encode(JSON.stringify({ ...snapshot, exportedAt: Date.now(), truncated: false })), { contentType: 'application/json' });
  await store.session(sessionId).put<AuditCheckpoint>('audit_exports', sandboxId, { key, sessionId, sandboxId });
}

/** Retained state must have a readable audit export before the provider deletes it. */
export async function prepareBrowserSandboxStop(provider: SandboxProvider, sandboxId: string, reason: 'destroy' | 'suspend', sessions: SessionStore, blobs?: BlobStore, store?: PluginStore): Promise<void> {
  const row = (await provider.list?.() ?? []).find((item) => item.id === sandboxId);
  if (!(row?.browserEnabled ?? provider.capabilities().browserAutomation)) return;
  if (!row?.sessionId) throw new Error('Browser sandbox ownership is missing. Restore its inventory before deleting retained state.');
  const state = await provider.status(sandboxId);
  if (state.state === 'idle' || state.state === 'released') {
    if (await hasAuditCheckpoint(row.sessionId, sandboxId, blobs, store)) return;
    if (!provider.readBrowserAudit) throw new Error('The retained browser audit has no verified export. Restore the sandbox or configure a retained-state audit reader before deleting it.');
    await exportAudit(row.sessionId, sandboxId, await provider.readBrowserAudit(sandboxId), blobs, store);
    return;
  }
  const sandbox = await provider.restore(sandboxId);
  await browserSessionHooks(row.sessionId, sessions, blobs, store, provider).sandboxLifecycle?.beforeStop(sandbox, reason);
}

export function browserSessionHooks(sessionId: string, sessions: SessionStore, blobs?: BlobStore, store?: PluginStore, provider?: SandboxProvider): Pick<CreateSessionOptions, 'sandboxLifecycle' | 'onTurnComplete'> {
  const scoped = store?.session(sessionId);
  async function drainCleanup(sandbox: Sandbox) {
    if (!scoped) throw new Error('Browser cleanup storage is unavailable. Configure the database before continuing.');
    let cursor: string | undefined;
    do {
      const page = await scoped.list<CleanupRecord>('turn_cleanup', { limit: 1000, cursor });
      if (!page.items.length) return;
      const running = await hasBrowser(sandbox);
      for (const item of page.items) {
        if (running) await browserRequest(sandbox, { ...item.doc.identity, command: 'turn_end' });
        await scoped.delete('turn_cleanup', item.key);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  async function readCompleteAudit(sandbox: Sandbox, identity: BrowserIdentity) {
    const entries: BrowserAuditEntry[] = [];
    let total: number | undefined;
    let runtimeId: string | undefined;
    do {
      const page = await browserRequest(sandbox, { ...identity, command: 'audit', offset: entries.length });
      runtimeId ??= page.runtimeId;
      if (runtimeId !== page.runtimeId) throw new Error('Browser runtime changed during audit export. Suspend the browser and retry deletion.');
      total ??= page.auditTotal ?? page.audit?.length ?? 0;
      if (total !== (page.auditTotal ?? page.audit?.length ?? 0)) throw new Error('Browser audit changed during export. Suspend the browser and retry deletion.');
      const batch = page.audit ?? [];
      if (batch.length === 0 && entries.length < total) throw new Error('Browser audit pagination stopped early. Restore the browser runtime and retry deletion.');
      entries.push(...batch);
    } while (entries.length < (total ?? 0));
    return { runtimeId, entries, total: total ?? 0 };
  }
  return {
    onTurnComplete: async ({ submissionId, sandbox, threadId, actorId, owner }) => {
      if (!scoped) throw new Error('Browser cleanup storage is unavailable. Configure the database before settling this turn.');
      if (!sandbox && provider) {
        const rows = await provider.list?.() ?? [];
        const retained = rows.some((row) =>
          row.sessionId === sessionId &&
          (row.browserEnabled ?? provider.capabilities().browserAutomation),
        );
        if (!retained) return;
      }
      await scoped.put<CleanupRecord>('turn_cleanup', submissionId, { identity: { protocolVersion: '1.0', sessionId, threadId, actorId, ownerId: owner.id } });
      if (sandbox) {
        try { await drainCleanup(sandbox); }
        catch (error) { console.error('Browser cleanup is retained for the next attachment. Restore the browser connection before continuing.', error); }
      }
    },
    sandboxLifecycle: {
      afterReady: async (sandbox) => {
        await scoped?.delete('audit_exports', sandbox.id);
        await drainCleanup(sandbox);
      },
      beforeStop: async (sandbox, reason, context) => {
        // A successful stop checkpoint stays valid until afterReady invalidates it.
        if (reason === 'destroy' && context?.suspended && await hasAuditCheckpoint(sessionId, sandbox.id, blobs, store)) return;
        if (!(await hasBrowser(sandbox)) && (await sandbox.exec('test -f /var/lib/valet/browser/journal.sqlite', { timeout: 5000, privileged: true })).exitCode !== 0) {
          await exportAudit(sessionId, sandbox.id, { entries: [], total: 0 }, blobs, store);
          return;
        }
        const session = await sessions.getSession(sessionId);
        if (!session) throw new Error('Browser session ownership is missing. Restore the session record before deleting its sandbox.');
        const identity: BrowserIdentity = { protocolVersion: '1.0', audience: 'lifecycle', sessionId, threadId: 'lifecycle', actorId: session.userId, ownerId: session.owner.id };
        await browserRequest(sandbox, { ...identity, command: 'suspend' });
        const audit = await readCompleteAudit(sandbox, identity);
        await exportAudit(sessionId, sandbox.id, audit, blobs, store);
      },
    },
  };
}
