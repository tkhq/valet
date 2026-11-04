/**
 * Plugin thread keys and child ids, kept apart from plugin-threads.ts so list
 * queries can recognise them without importing the plugin runtime.
 */

/** Every plugin thread key starts with this (`plugin:<plugin>:<key>`). */
export const PLUGIN_THREAD_KEY_PREFIX = "plugin:";

/** Every plugin child session id starts with this. */
export const PLUGIN_CHILD_SESSION_PREFIX = "child_plg_";

/** The thread key a plugin key maps to: namespaced so plugins cannot collide with each other or with core keys. */
export function pluginThreadKey(plugin: string, key: string): string {
  return `${PLUGIN_THREAD_KEY_PREFIX}${plugin}:${key}`;
}

/** Plugin threads are a plugin's working space, not rows in a person's thread
 * list or Home. A link to one still opens it. */
export function isPluginThreadKey(key: string | null | undefined): boolean {
  return Boolean(key?.startsWith(PLUGIN_THREAD_KEY_PREFIX));
}
