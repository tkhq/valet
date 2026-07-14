/**
 * Engine-native plugin export. The `googleWorkspacePlugin: ActionPlugin` is
 * the canonical entry point for the engine's plugin catalog. Currently
 * covers Drive + Docs (Task 10); Sheets lands in Task 11.
 */
export { googleWorkspacePlugin } from './actions.js';
