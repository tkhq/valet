import { constants } from 'node:fs';
import {
  mkdir,
  open,
  copyFile,
  readFile,
  readdir,
  rm,
  lstat,
  realpath,
} from 'node:fs/promises';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BrowserArtifact, BrowserExportDescriptor } from '@valet/shared';
import { BrowserFault } from './protocol.js';
export class FileBroker {
  private artifacts = new Map<string, BrowserArtifact>();
  private transfers = new Map<string, { path: string; bytes: number }>();
  private transferBytes = 0;
  private frameQueues = new Map<string, string[]>();
  private total = 0;
  constructor(
    readonly root: string,
    private readonly sessionId: string,
    private readonly runtimeId: string,
    private readonly workingDirectory: string,
    private readonly maxFile = 100 * 1024 * 1024,
    private readonly maxSession = 500 * 1024 * 1024,
  ) {}
  async initialize() {
    for (const name of ['artifacts', 'transfers', 'downloads'])
      await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
    // Transfers are ephemeral. A daemon restart is an explicit recovery boundary.
    for (const filename of await readdir(join(this.root, 'transfers')))
      if (/^[a-f0-9-]+$/.test(filename))
        await rm(join(this.root, 'transfers', filename), { force: true });
    for (const filename of await readdir(join(this.root, 'artifacts'))) {
      if (!filename.endsWith('.json')) continue;
      const info: BrowserArtifact = JSON.parse(
        await readFile(join(this.root, 'artifacts', filename), 'utf8'),
      );
      if (info.sessionId !== this.sessionId || !/^[a-f0-9-]+$/.test(info.id))
        throw new BrowserFault(
          'IDENTITY_MISMATCH',
          'Artifact state belongs to another session.',
          'Restore the correct session volume.',
        );
      this.artifacts.set(info.id, info);
      this.total += info.bytes;
    }
  }
  async create(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    metadata: Partial<BrowserArtifact> = {},
  ): Promise<BrowserArtifact> {
    if (
      bytes.length > this.maxFile ||
      this.total + bytes.length > this.maxSession
    )
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Browser file quota exceeded.',
        'Remove unneeded browser files or request a larger quota.',
      );
    const id = randomUUID();
    const safeName =
      basename(filename)
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 128) || 'download';
    const artifact: BrowserArtifact = {
      ...metadata,
      id,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      mimeType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filename: safeName,
      createdAt: Date.now(),
    };
    this.total += bytes.length;
    try {
      const file = await open(join(this.root, 'artifacts', id), 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const meta = await open(
        join(this.root, 'artifacts', `${id}.json`),
        'wx',
        0o600,
      );
      try {
        await meta.writeFile(JSON.stringify(artifact));
        await meta.sync();
      } finally {
        await meta.close();
      }
      this.artifacts.set(id, artifact);
      return artifact;
    } catch (error) {
      this.total -= bytes.length;
      await Promise.all([
        rm(join(this.root, 'artifacts', id), { force: true }),
        rm(join(this.root, 'artifacts', `${id}.json`), { force: true }),
      ]);
      throw error;
    }
  }
  get(id: string): BrowserArtifact {
    const info = this.artifacts.get(id);
    if (!info)
      throw new BrowserFault(
        'STALE_REFERENCE',
        'The artifact ID is unknown.',
        'Select an artifact from this browser session.',
      );
    return info;
  }
  list() {
    return [...this.artifacts.values()];
  }
  async export(id: string): Promise<BrowserExportDescriptor> {
    const info = this.get(id);
    const transferId = randomUUID();
    const path = join(this.root, 'transfers', transferId);
    this.reserveTransfer(transferId, path, info.bytes);
    try {
      await copyFile(
        join(this.root, 'artifacts', id),
        path,
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      await this.ack(transferId);
      throw error;
    }
    return { ...info, transferId, path };
  }
  async frame(
    bytes: Buffer,
    metadata: Partial<BrowserArtifact>,
    viewer = 'default',
  ): Promise<BrowserExportDescriptor> {
    if (bytes.length > this.maxFile)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Viewer frame exceeds the limit.',
        'Use a smaller viewport.',
      );
    const queue = this.frameQueues.get(viewer) ?? [];
    while (queue.length >= 2) {
      const old = queue.shift();
      if (old) await this.ack(old);
    }
    const transferId = randomUUID();
    const path = join(this.root, 'transfers', transferId);
    this.reserveTransfer(transferId, path, bytes.length);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      await this.ack(transferId);
      throw error;
    }
    queue.push(transferId);
    this.frameQueues.set(viewer, queue);
    return {
      ...metadata,
      id: transferId,
      transferId,
      path,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      mimeType: 'image/jpeg',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filename: 'frame.jpg',
      createdAt: Date.now(),
    };
  }
  private reserveTransfer(id: string, path: string, bytes: number) {
    if (
      this.transfers.size >= 32 ||
      this.transferBytes + bytes > this.maxSession
    )
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'The transfer queue is full.',
        'Acknowledge completed transfers before exporting more files.',
      );
    this.transfers.set(id, { path, bytes });
    this.transferBytes += bytes;
  }
  async ack(transferId: string) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    await rm(transfer.path, { force: true });
    this.transfers.delete(transferId);
    this.transferBytes -= transfer.bytes;
    for (const [owner, queue] of this.frameQueues) {
      const next = queue.filter((id) => id !== transferId);
      if (next.length) this.frameQueues.set(owner, next);
      else this.frameQueues.delete(owner);
    }
  }
  async read(id: string) {
    this.get(id);
    return readFile(join(this.root, 'artifacts', id));
  }
  async upload(
    paths: string[],
  ): Promise<{ name: string; mimeType: string; buffer: Buffer }[]> {
    if (!paths.length || paths.length > 16)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'Invalid upload file count.',
        'Select between one and sixteen files.',
      );
    const root = await realpath(this.workingDirectory);
    const result: { name: string; mimeType: string; buffer: Buffer }[] = [];
    let uploadBytes = 0;
    for (const input of paths) {
      const path = resolve(root, input);
      const rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new BrowserFault(
          'ORIGIN_DENIED',
          'Upload path is outside the working directory.',
          'Select a file inside the session working directory.',
        );
      let current = root;
      for (const part of rel.split('/')) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new BrowserFault(
            'ORIGIN_DENIED',
            'Upload paths cannot contain a symlink.',
            'Select the original file inside the working directory.',
          );
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.maxFile)
          throw new BrowserFault(
            'QUOTA_EXCEEDED',
            'Upload file is invalid or too large.',
            'Select a regular file within the transfer limit.',
          );
        // Compare the opened descriptor with the current path. Bytes come from this same descriptor.
        const actual = await realpath(
          process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path,
        );
        const currentStat = await lstat(path);
        if (
          actual !== path ||
          currentStat.dev !== stat.dev ||
          currentStat.ino !== stat.ino
        )
          throw new BrowserFault(
            'STALE_REFERENCE',
            'The upload file changed during validation.',
            'Select the file again.',
          );
        uploadBytes += stat.size;
        if (uploadBytes > this.maxFile)
          throw new BrowserFault(
            'QUOTA_EXCEEDED',
            'The upload batch exceeds the memory limit.',
            'Upload fewer or smaller files.',
          );
        const buffer = await handle.readFile();
        if (buffer.length !== stat.size)
          throw new BrowserFault(
            'STALE_REFERENCE',
            'The upload file changed during reading.',
            'Stop editing the file and select it again.',
          );
        result.push({ name: basename(path), mimeType: mime(path), buffer });
      } finally {
        await handle.close();
      }
    }
    return result;
  }
}
function mime(path: string) {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        txt: 'text/plain',
        md: 'text/markdown',
        html: 'text/html',
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        pdf: 'application/pdf',
        csv: 'text/csv',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  );
}
