import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from '@valet/engine';
import { driveActions } from './drive-actions.js';
import { docsActions } from './docs-actions.js';
import { sheetsActions } from './sheets-actions.js';
import { slidesActions } from './slides-actions.js';
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

const allActions: PluginAction[] = [...driveActions, ...docsActions, ...sheetsActions, ...slidesActions].map(withLabelsGuard);

// Service id preserved verbatim from the legacy provider (see provider.ts /
// worker resolvers) — this is the credential lookup key.
export const googleWorkspacePlugin: ActionPlugin = {
  service: 'google_workspace',
  description: 'Google Workspace integration — Drive, Docs, and Sheets with unified OAuth and labels-based access guard',
  actions: allActions,
};
