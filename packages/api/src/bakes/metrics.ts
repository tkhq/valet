import { metrics } from "@opentelemetry/api";
import type { SourceService } from "./source-service.js";

type Health = Awaited<ReturnType<SourceService["health"]>>;
let instruments: ReturnType<typeof createInstruments> | undefined;
function createInstruments() {
  const meter = metrics.getMeter("@valet/api");
  return {
    cacheBytes: meter.createGauge("valet.bake.cache.bytes"),
    budgetBytes: meter.createGauge("valet.bake.cache.budget.bytes"),
    protected: meter.createGauge("valet.bake.cache.over_budget_all_protected"),
    pushFailures: meter.createGauge("valet.bake.push_failures.recent"),
    capacity: meter.createGauge("valet.registry.capacity.bytes"),
    available: meter.createGauge("valet.registry.available.bytes"),
    reserve: meter.createGauge("valet.registry.reserve.bytes"),
    full: meter.createGauge("valet.registry.full"),
    unknown: meter.createGauge("valet.registry.capacity_unknown"),
  };
}
export function recordBakeHealth(orgId: string, health: Health): void {
  const inst = instruments ??= createInstruments();
  const attrs = { orgId };
  inst.cacheBytes.record(health.cache.bytesUsed, attrs);
  inst.budgetBytes.record(health.cache.budgetBytes, attrs);
  inst.protected.record(Number(health.cache.over_budget_all_protected), attrs);
  inst.pushFailures.record(health.recentPushFailures.count, attrs);
  inst.full.record(Number(health.registry.status === "full"));
  inst.unknown.record(Number(health.registry.status === "unknown" || health.registry.status === "unconfigured"));
  if (health.registry.capacityBytes !== null) {
    inst.capacity.record(health.registry.capacityBytes);
    inst.available.record(health.registry.availableBytes!);
    inst.reserve.record(health.registry.reserveBytes!);
  }
}

let builtInRepairs: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | undefined;
/** Counts boot repairs of a built-in image source that drifted from the code
 * values. Any non-zero value means tampering or a legacy edit: alert on it. */
export function recordBuiltInSourceRepair(orgId: string, source: string, field: string): void {
  builtInRepairs ??= metrics.getMeter("@valet/api").createCounter("valet.image_source.builtin_repaired", {
    description: "Built-in image source fields put back to code values at boot",
  });
  builtInRepairs.add(1, { orgId, source, field });
}
