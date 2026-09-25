import type { SandboxProvider } from "@valet/engine";
export type RetainedBrowserAudit = Awaited<
  ReturnType<NonNullable<SandboxProvider["readBrowserAudit"]>>
>;

export const READ_RETAINED_BROWSER_AUDIT = `const fs=require('node:fs');const Database=require('/opt/valet/browser/node_modules/better-sqlite3');const source='/var/lib/valet/browser';const destination=fs.mkdtempSync('/tmp/valet-browser-audit-');for(const name of ['journal.sqlite','journal.sqlite-wal','journal.sqlite-shm']){try{const p=source+'/'+name;if(!fs.lstatSync(p).isFile())throw Error('Invalid journal file');fs.copyFileSync(p,destination+'/'+name);}catch(error){if(error.code!=='ENOENT'||name==='journal.sqlite')throw error;}}const db=new Database(destination+'/journal.sqlite',{readonly:true,fileMustExist:true});try{const entries=db.prepare('SELECT cells.invocation AS invocationId,cells.id AS cellId,operations.id AS operationId,cells.session AS sessionId,cells.thread AS threadId,cells.actor AS actorId,cells.runtime AS runtimeId,operations.method,operations.hash,operations.status FROM operations JOIN cells ON cells.id=operations.cell ORDER BY operations.rowid DESC').all();process.stdout.write(JSON.stringify({entries,total:entries.length}));}finally{db.close();fs.rmSync(destination,{recursive:true,force:true});}`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRetainedBrowserAudit(
  value: unknown,
  sessionId: string,
): RetainedBrowserAudit {
  if (
    !value ||
    typeof value !== "object" ||
    !("entries" in value) ||
    !Array.isArray(value.entries) ||
    !("total" in value) ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total !== value.entries.length
  ) {
    throw new Error(
      "The retained browser audit is invalid. Restore the matching runtime image before deleting this session.",
    );
  }
  const entries: RetainedBrowserAudit["entries"] = [];
  for (const candidate of value.entries) {
    const row: unknown = candidate;
    if (
      !record(row) ||
      typeof row.invocationId !== "string" ||
      typeof row.cellId !== "string" ||
      typeof row.operationId !== "string" ||
      row.sessionId !== sessionId ||
      typeof row.threadId !== "string" ||
      typeof row.actorId !== "string" ||
      typeof row.runtimeId !== "string" ||
      typeof row.method !== "string" ||
      typeof row.hash !== "string" ||
      (row.status !== "prepared" &&
        row.status !== "awaiting_approval" &&
        row.status !== "in_flight" &&
        row.status !== "completed" &&
        row.status !== "failed" &&
        row.status !== "cancelled" &&
        row.status !== "outcome_unknown")
    ) {
      throw new Error(
        "The retained browser audit has another owner or an invalid entry. Inspect the journal before deleting this session.",
      );
    }
    entries.push({
      invocationId: row.invocationId,
      cellId: row.cellId,
      operationId: row.operationId,
      sessionId,
      threadId: row.threadId,
      actorId: row.actorId,
      runtimeId: row.runtimeId,
      method: row.method,
      hash: row.hash,
      status: row.status,
    });
  }
  return { entries, total: value.total };
}
