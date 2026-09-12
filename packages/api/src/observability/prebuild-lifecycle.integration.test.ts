import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { SourceService } from "../bakes/source-service.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { bakes, imageSources, orgs } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";

const NOW = 1_700_000_000_000;

afterEach(() => metrics.disable());

describe("prebuild lifecycle boot integration", () => {
  it("exports a restart failure after SourceService imports before provider registration", async () => {
    const { appDb: db, pgdb } = await freshTestPgDb();
    await db.insert(orgs).values({ id: "org", name: "Org", createdAt: NOW });
    await db.insert(imageSources).values({
      id: "source",
      orgId: "org",
      kind: "base",
      parentId: null,
      name: "Base",
      externalRef: null,
      pullSecretName: null,
      setupCommands: [],
      profile: "full",
      repoHost: null,
      repoFullName: null,
      cloneUrl: null,
      schedule: "nightly",
      enabled: true,
      lastBoundAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(bakes).values({
      id: "interrupted",
      sourceId: "source",
      commitSha: null,
      imageRef: "image:tag",
      status: "building",
      identityHash: "identity",
      builderBackend: "kubernetes",
      recipe: { recipe: [], setup: [] },
      error: null,
      logTail: null,
      startedAt: NOW,
      finishedAt: null,
      createdAt: NOW,
    });

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    const service = new SourceService({
      db,
      builder: null,
      githubTokenDeps: {
        db,
        credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")),
        key: deriveSecretKey("test-key"),
      },
      now: () => NOW,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await service.start();
    await provider.forceFlush();

    const buildMetric = exporter.getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "valet.prebuild.builds");
    expect(buildMetric?.dataPointType).toBe(DataPointType.SUM);
    if (!buildMetric || buildMetric.dataPointType !== DataPointType.SUM) throw new Error("expected build counter");
    expect(buildMetric.dataPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributes: expect.objectContaining({ outcome: "failed" }), value: 1 }),
    ]));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"bake_failed"'));

    log.mockRestore();
    service.stop();
    await provider.shutdown();
  });
});
