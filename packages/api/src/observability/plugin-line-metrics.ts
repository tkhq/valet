/**
 * Enabled event lines whose target is a plugin handler this process did not
 * load. A deploy that drops a plugin leaves such lines behind: every
 * delivery to them fails with "handler is not loaded" until it goes dead.
 * Exported as `valet_plugin_lines_unloaded_handler` and reported once at
 * boot. Alert on it; no code repairs it, because the fix is a deploy that
 * loads the plugin again or a person deleting the line.
 */
import { metrics } from "@opentelemetry/api";
import { and, eq, sql } from "drizzle-orm";
import { reportError, type ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions } from "../schema/index.js";

export interface UnloadedPluginLine {
  id: string;
  name: string;
  plugin: string;
  handler: string;
}

/** Enabled plugin lines whose `plugin/handler` is not in `plugins`. */
export async function unloadedPluginLines(db: AppDb, plugins: readonly ValetPlugin[]): Promise<UnloadedPluginLine[]> {
  const loaded = new Set(plugins.flatMap((p) => (p.eventHandlers ?? []).map((h) => `${p.name}/${h.id}`)));
  const rows = await db
    .select({ id: eventSubscriptions.id, name: eventSubscriptions.name, target: eventSubscriptions.target })
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.enabled, true), sql`${eventSubscriptions.target}->>'kind' = 'plugin'`));
  const out: UnloadedPluginLine[] = [];
  for (const row of rows) {
    const target = row.target as { plugin?: unknown; handler?: unknown }; // jsonb; narrowed below
    if (typeof target.plugin !== "string" || typeof target.handler !== "string") continue;
    if (!loaded.has(`${target.plugin}/${target.handler}`)) out.push({ id: row.id, name: row.name, plugin: target.plugin, handler: target.handler });
  }
  return out;
}

const registered = new WeakSet<AppDb>();

/** Sample the count of enabled lines whose handler is not loaded. */
export function registerPluginLineMetrics(db: AppDb, plugins: readonly ValetPlugin[]): void {
  if (registered.has(db)) return;
  registered.add(db);
  const gauge = metrics.getMeter("@valet/api").createObservableGauge("valet_plugin_lines_unloaded_handler", {
    description: "Enabled event lines whose target plugin handler is not loaded in this process",
  });
  gauge.addCallback(async (result) => {
    result.observe((await unloadedPluginLines(db, plugins)).length);
  });
}

/** Log every enabled line whose handler is not loaded, once at boot. */
export async function reportUnloadedPluginLines(db: AppDb, plugins: readonly ValetPlugin[]): Promise<UnloadedPluginLine[]> {
  const lines = await unloadedPluginLines(db, plugins);
  if (lines.length > 0) {
    const list = lines.map((l) => `${l.plugin}/${l.handler} (line ${l.id} "${l.name}")`).join(", ");
    reportError(
      { area: "boot", reason: "plugin_handler_not_loaded", level: "error" },
      `${lines.length} enabled event line(s) target a plugin handler this build did not load: ${list}. Deliveries to them fail until a deploy loads the plugin again or a person deletes the lines.`,
    );
  }
  return lines;
}
