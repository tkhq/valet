/**
 * Free disk space on the filesystem that holds the API data directory.
 *
 * On a single-host deployment the API data directory, the Docker sandboxes
 * and PostgreSQL share one disk. When that disk fills, PostgreSQL stops with
 * "No space left on device" and every request fails. This monitor makes low
 * free space visible before that happens. It never deletes anything
 * ("Invariants: alert, don't auto-repair" in CLAUDE.md): an operator finds
 * what filled the disk.
 *
 * Exported names (Prometheus renders dots as underscores):
 *  - `valet.host.disk.available` bytes: space an unprivileged process can
 *    still write;
 *  - `valet.host.disk.size` bytes: size of the filesystem.
 *
 * With `VALET_DISK_ALERT_FREE_GB` set, available space under that value
 * reports `valet.errors{area="api", reason="disk_space_low"}` with a log
 * line. It reports when space first drops under the threshold, then again
 * every `DISK_ALERT_REPEAT_MS` while it stays low.
 */
import { statfsSync } from "node:fs";
import { metrics } from "@opentelemetry/api";
import { detachedFromTrace, log, reportError } from "@valet/engine";

export const DISK_SAMPLE_INTERVAL_MS = 60_000;
export const DISK_ALERT_REPEAT_MS = 30 * 60_000;
const GB = 1024 ** 3;

export interface DiskSample {
  availableBytes: number;
  sizeBytes: number;
}

export function readDisk(path: string): DiskSample {
  const stats = statfsSync(path);
  return { availableBytes: stats.bavail * stats.bsize, sizeBytes: stats.blocks * stats.bsize };
}

/** Free-space threshold in bytes from `VALET_DISK_ALERT_FREE_GB`. Undefined
 * when unset or empty. A value that is not a positive number stops boot. */
export function resolveDiskAlertBytes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.VALET_DISK_ALERT_FREE_GB?.trim();
  if (raw === undefined || raw === "") return undefined;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb <= 0) {
    throw new Error(`VALET_DISK_ALERT_FREE_GB="${env.VALET_DISK_ALERT_FREE_GB}" is not a positive number. Set it to a value such as "15", or unset it.`);
  }
  return gb * GB;
}

/** Decides when a sample reports. Pure, so the edge and repeat rules are
 * testable without a timer or a real filesystem. */
export class DiskAlertState {
  private lowSince?: number;
  private lastReport = Number.NEGATIVE_INFINITY;
  constructor(private readonly thresholdBytes: number, private readonly repeatMs = DISK_ALERT_REPEAT_MS) {}

  /** `report` when this sample must alert, `recovered` when space came back
   * above the threshold after an alert, otherwise `none`. */
  next(availableBytes: number, now: number): "report" | "recovered" | "none" {
    if (availableBytes >= this.thresholdBytes) {
      if (this.lowSince === undefined) return "none";
      this.lowSince = undefined;
      return "recovered";
    }
    if (this.lowSince === undefined) this.lowSince = now;
    if (now - this.lastReport < this.repeatMs && this.lastReport >= this.lowSince) return "none";
    this.lastReport = now;
    return "report";
  }
}

/** Starts the monitor for the filesystem that holds `path`. Returns the stop
 * function for shutdown. The timer is unref'd and runs outside any trace. */
export function startDiskHealthMonitor(opts: { path: string; alertBelowBytes?: number; intervalMs?: number }): () => void {
  let latest: DiskSample | undefined;
  let unreadableReported = false;
  const alert = opts.alertBelowBytes === undefined ? undefined : new DiskAlertState(opts.alertBelowBytes);
  const gb = (bytes: number) => Math.round((bytes / GB) * 10) / 10;
  const sample = () => {
    try {
      latest = readDisk(opts.path);
    } catch (err) {
      if (unreadableReported) return;
      unreadableReported = true;
      reportError({ area: "api", reason: "disk_space_unreadable", level: "warn", fields: { path: opts.path } }, "Cannot read free disk space. Check that the API data directory exists.", err);
      return;
    }
    unreadableReported = false;
    if (!alert || opts.alertBelowBytes === undefined) return;
    const fields = { path: opts.path, availableGb: gb(latest.availableBytes), thresholdGb: gb(opts.alertBelowBytes) };
    const outcome = alert.next(latest.availableBytes, Date.now());
    if (outcome === "report") {
      reportError({ area: "api", reason: "disk_space_low", fields },
        `Free disk space is ${fields.availableGb} GB, under the ${fields.thresholdGb} GB alert threshold. PostgreSQL stops when the disk is full. Find what uses the disk (docker ps -s, docker system df) and free space.`);
    } else if (outcome === "recovered") {
      log.info(`Free disk space is ${fields.availableGb} GB, above the ${fields.thresholdGb} GB alert threshold again.`, fields);
    }
  };
  const meter = metrics.getMeter("@valet/api");
  meter.createObservableGauge("valet.host.disk.available", {
    unit: "By", description: "Free space an unprivileged process can write on the filesystem of the API data directory",
  }).addCallback((result) => { if (latest) result.observe(latest.availableBytes); });
  meter.createObservableGauge("valet.host.disk.size", {
    unit: "By", description: "Size of the filesystem of the API data directory",
  }).addCallback((result) => { if (latest) result.observe(latest.sizeBytes); });
  sample();
  const timer = detachedFromTrace(() => setInterval(sample, opts.intervalMs ?? DISK_SAMPLE_INTERVAL_MS));
  timer.unref();
  return () => clearInterval(timer);
}
