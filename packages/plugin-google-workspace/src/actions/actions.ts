import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from '@valet/engine';
import { driveActions } from './drive-actions.js';
import { docsActions } from './docs-actions.js';
import { sheetsActions } from './sheets-actions.js';
import {
  classifyAction,
  buildLabelFilterClause,
  checkFileLabel,
  applyLabel,
  deleteFile,
  extractFileId,
  extractCreatedFileId,
  type DriveLabelsGuardConfig,
} from './labels-guard.js';
import {
  FolderContainment,
  filterListResult,
  resolveFolderScope,
  SCOPE_DENIAL,
} from './folder-scope.js';

/**
 * V2-GAP: the legacy dispatcher (see git history / labels-guard.ts) wrapped
 * every action execution with an org-level Drive-labels access guard read
 * from `ctx.guardConfig`. `PluginActionContext` (engine-native, v2) has no
 * `guardConfig` field yet — org policy plumbing hasn't landed for v2 hosts.
 * This resolver hard-codes the "absent" case (always null == guard
 * disabled) so every action below runs unguarded, matching what the legacy
 * dispatcher did whenever `ctx.guardConfig` was unset. The rest of
 * `withLabelsGuard` below is a straight port of the legacy dispatch's
 * guard-branch logic (labels-guard.ts is untouched and fully retained) so
 * that wiring a real `guardConfig` back onto `PluginActionContext` in the
 * future only requires changing this one function.
 */
function resolveGuardV2(_ctx: PluginActionContext): DriveLabelsGuardConfig | null {
  return null;
}

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? '';
}

/**
 * Wraps one ported action's `execute` with the (currently inert, see
 * V2-GAP above) Drive-labels guard. Structurally mirrors the legacy
 * dispatcher's `executeAction` in the pre-port `actions.ts`, but operates
 * per-action (v2 has no central switch-based dispatch to hang a wrapper
 * off) instead of per-request.
 */
function withLabelsGuard(action: PluginAction): PluginAction {
  return {
    ...action,
    execute: async (args, ctx: PluginActionContext): Promise<PluginActionResult> => {
      const actionId = action.id;

      // Strip any agent-supplied __labelFilter — only the guard may set this.
      const params = (args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {}) as Record<
        string,
        unknown
      >;
      delete params.__labelFilter;

      const guard = resolveGuardV2(ctx);
      if (!guard) return action.execute(params, ctx);

      const token = await getAccessToken(ctx);
      const category = classifyAction(actionId);

      // Fail-closed: unclassified actions are denied when the guard is active.
      if (category === 'unknown') {
        return { success: false, error: `Unknown action: ${actionId}` };
      }

      const p = params;

      // ── Pre-dispatch guards ──

      if (category === 'list_search') {
        // When the guard is enabled with no required labels, deny all results
        if (guard.driveRequiredLabelIds.length === 0) {
          return { success: true, data: { files: [] } };
        }
        // Inject label filter clause into params for search/list actions
        const clause = buildLabelFilterClause(guard.driveRequiredLabelIds);
        if (clause) {
          p.__labelFilter = clause;
        }
        return action.execute(p, ctx);
      }

      // ── drive.copy_file: source-file label check + dispatch + auto-label copy ──

      if (actionId === 'drive.copy_file') {
        const fileId = extractFileId(actionId, p);
        if (!fileId) {
          if (guard.driveLabelsFailMode === 'allow') return action.execute(params, ctx);
          return { success: false, error: 'File not found or access denied' };
        }
        const denial = await checkFileLabel(fileId, token, guard);
        if (denial) return denial;

        const result = await action.execute(params, ctx);
        if (result.success && guard.driveRequiredLabelIds.length > 0) {
          const createdId = extractCreatedFileId(actionId, result);
          if (createdId) {
            const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
            if (!labeled) {
              await deleteFile(createdId, token);
              return {
                success: false,
                error: 'Failed to create file: could not apply required Drive label',
              };
            }
          }
        }
        return result;
      }

      // ── drive.create_from_template: template label check + dispatch + auto-label ──

      if (actionId === 'drive.create_from_template') {
        const templateId = typeof p.templateId === 'string' ? p.templateId : null;
        if (!templateId) {
          if (guard.driveLabelsFailMode === 'allow') return action.execute(params, ctx);
          return { success: false, error: 'File not found or access denied' };
        }
        const denial = await checkFileLabel(templateId, token, guard);
        if (denial) return denial;

        const result = await action.execute(params, ctx);
        if (result.success && guard.driveRequiredLabelIds.length > 0) {
          const createdId = extractCreatedFileId(actionId, result);
          if (createdId) {
            const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
            if (!labeled) {
              await deleteFile(createdId, token);
              return {
                success: false,
                error: 'Failed to create file: could not apply required Drive label',
              };
            }
          }
        }
        return result;
      }

      // ── sheets.copy_sheet_to: check both source and destination spreadsheets ──

      if (actionId === 'sheets.copy_sheet_to') {
        const sourceId = typeof p.sourceSpreadsheetId === 'string' ? p.sourceSpreadsheetId : null;
        const destId = typeof p.destinationSpreadsheetId === 'string' ? p.destinationSpreadsheetId : null;
        if (!sourceId || !destId) {
          if (guard.driveLabelsFailMode === 'allow') return action.execute(params, ctx);
          return { success: false, error: 'File not found or access denied' };
        }
        const sourceDenial = await checkFileLabel(sourceId, token, guard);
        if (sourceDenial) return sourceDenial;
        const destDenial = await checkFileLabel(destId, token, guard);
        if (destDenial) return destDenial;
        return action.execute(params, ctx);
      }

      if (category === 'read_get' || category === 'write_modify') {
        const fileId = extractFileId(actionId, p);
        if (!fileId) {
          if (guard.driveLabelsFailMode === 'allow') return action.execute(params, ctx);
          return { success: false, error: 'File not found or access denied' };
        }
        const denial = await checkFileLabel(fileId, token, guard);
        if (denial) return denial;
        return action.execute(params, ctx);
      }

      // ── Dispatch for create actions ──

      if (category === 'create') {
        // Guard active + no required labels: deny creates to prevent orphaned files
        if (guard.driveRequiredLabelIds.length === 0) {
          return { success: false, error: 'File not found or access denied' };
        }
      }

      const result = await action.execute(params, ctx);

      // ── Post-dispatch: cleanup partial creates + auto-label ──

      if (category === 'create') {
        // If dispatch failed but a file was partially created, clean it up
        if (!result.success) {
          const partialId = extractCreatedFileId(actionId, result);
          if (partialId) {
            await deleteFile(partialId, token);
          }
          return result;
        }

        if (guard.driveRequiredLabelIds.length > 0) {
          const createdId = extractCreatedFileId(actionId, result);
          if (createdId) {
            const labeled = await applyLabel(createdId, token, guard.driveRequiredLabelIds[0]);
            if (!labeled) {
              // Roll back the created file
              await deleteFile(createdId, token);
              return {
                success: false,
                error: 'Failed to create file: could not apply required Drive label',
              };
            }
          }
        }
      }

      return result;
    },
  };
}

/**
 * Where a create action names the folder its new file goes into. An action
 * missing from this map creates in the caller's Drive root, which no folder
 * scope can contain.
 */
const CREATE_PARENT_PARAM: Record<string, string> = {
  'drive.create_document': 'folderId',
  'drive.create_folder': 'parentFolderId',
  'drive.create_from_template': 'folderId',
};

/** Creates that act inside a file that already exists, not on a new one. */
const CREATE_INSIDE_EXISTING_FILE = new Set(['sheets.create_table']);

/**
 * Where an action names a second folder: the one the file ends up in. The
 * file itself is checked as the action's target; the destination has to be
 * inside the scope too, or scoped content can be copied or moved out of it.
 */
const DESTINATION_PARAM: Record<string, string> = {
  'drive.copy_file': 'folderId',
  'drive.move_file': 'folderId',
};

function scopeDenied(): PluginActionResult {
  return { success: false, error: SCOPE_DENIAL };
}

/**
 * Wraps one action with the person's Drive folder scope.
 *
 * No scope leaves the action untouched, so an unscoped integration behaves
 * exactly as before. A scope routes every category through the one
 * containment check in folder-scope.ts:
 *
 * - list and search: the result is filtered, because Drive v3 cannot express
 *   a subtree in a query.
 * - read and write: the target file has to sit inside the scope.
 * - create: the new file's folder has to sit inside the scope, and an action
 *   that cannot name a folder is refused.
 *
 * Anything unclassified is refused. A new action is therefore unreachable
 * under a scope until it is classified, which fails toward the scope holder.
 */
function withFolderScope(action: PluginAction): PluginAction {
  return {
    ...action,
    execute: async (args, ctx: PluginActionContext): Promise<PluginActionResult> => {
      const actionId = action.id;
      const cred = await ctx.credentials.get();
      const scope = resolveFolderScope(cred);
      if (!scope) return action.execute(args, ctx);

      const params = (args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {}) as Record<
        string,
        unknown
      >;
      const containment = new FolderContainment(cred?.accessToken ?? '', new Set(scope.folderIds));
      const category = classifyAction(actionId);
      if (category === 'unknown') return scopeDenied();

      try {
        const destinationParam = DESTINATION_PARAM[actionId];
        if (destinationParam) {
          const destination = params[destinationParam];
          if (typeof destination === 'string' && destination.length > 0) {
            if (!(await containment.isInside(destination))) return scopeDenied();
          }
        }

        if (category === 'list_search') {
          const result = await action.execute(params, ctx);
          if (!result.success) return result;
          return { ...result, data: await filterListResult(result.data, containment) };
        }

        if (actionId === 'sheets.copy_sheet_to') {
          const source = typeof params.sourceSpreadsheetId === 'string' ? params.sourceSpreadsheetId : null;
          const dest =
            typeof params.destinationSpreadsheetId === 'string' ? params.destinationSpreadsheetId : null;
          if (!source || !dest) return scopeDenied();
          if (!(await containment.isInside(source))) return scopeDenied();
          if (!(await containment.isInside(dest))) return scopeDenied();
          return action.execute(params, ctx);
        }

        if (category === 'read_get' || category === 'write_modify') {
          const fileId = extractFileId(actionId, params);
          if (!fileId) return scopeDenied();
          if (!(await containment.isInside(fileId))) return scopeDenied();
          return action.execute(params, ctx);
        }

        if (category === 'create') {
          if (CREATE_INSIDE_EXISTING_FILE.has(actionId)) {
            const fileId = extractFileId(actionId, params);
            if (!fileId) return scopeDenied();
            if (!(await containment.isInside(fileId))) return scopeDenied();
            return action.execute(params, ctx);
          }

          // A template is read before it is copied, so it has to be in scope too.
          if (actionId === 'drive.create_from_template') {
            const templateId = typeof params.templateId === 'string' ? params.templateId : null;
            if (!templateId) return scopeDenied();
            if (!(await containment.isInside(templateId))) return scopeDenied();
          }

          const parentParam = CREATE_PARENT_PARAM[actionId];
          if (!parentParam) {
            return {
              success: false,
              error:
                `${actionId} always creates in the top level of Drive, which is outside the allowed folders. ` +
                'Create the file in an allowed folder with drive.create_document or drive.create_folder, ' +
                'or widen the allowed folders in Settings → Integrations → Google Workspace.',
            };
          }

          const requested = params[parentParam];
          if (typeof requested === 'string' && requested.length > 0) {
            if (!(await containment.isInside(requested))) return scopeDenied();
          } else if (scope.folderIds.length === 1) {
            // No folder asked for. Put it in the scope rather than in the
            // Drive root, which the scope could not contain.
            params[parentParam] = scope.folderIds[0];
          } else {
            return {
              success: false,
              error:
                `Name the destination folder in "${parentParam}". This integration is limited to ` +
                `${scope.folderIds.length} folders, so there is no single default.`,
            };
          }
          return action.execute(params, ctx);
        }

        return scopeDenied();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A 401 has to reach session-tools so it can refresh the token and
        // retry. Every other failure denies: an outage is not a verdict.
        if (message.includes('401')) return { success: false, error: message };
        return scopeDenied();
      }
    },
  };
}

const allActions: PluginAction[] = [...driveActions, ...docsActions, ...sheetsActions]
  .map(withLabelsGuard)
  .map(withFolderScope);

// Service id preserved verbatim from the legacy provider (see provider.ts /
// worker resolvers) — this is the credential lookup key.
export const googleWorkspacePlugin: ActionPlugin = {
  service: 'google_workspace',
  description: 'Google Workspace integration — Drive, Docs, and Sheets with unified OAuth and labels-based access guard',
  actions: allActions,
};
