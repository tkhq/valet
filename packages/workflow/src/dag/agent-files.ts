import type { WorkflowDefinition } from './shape.js';
import { collectUnresolvedTemplatePaths, renderTemplate, type TemplateContext } from './expression.js';

/** A definition or sandbox input failure that must settle the node, not retry the drive. */
export class AgentInputFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInputFileError';
  }
}

export const MAX_AGENT_INPUT_FILES = 100;
export const MAX_AGENT_INPUT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_AGENT_INPUT_TOTAL_BYTES = 25 * 1024 * 1024;

/** Host-only dispatch payload. Contents do not belong in checkpoint effects. */
export interface RenderedAgentFile {
  path: string;
  content: string;
}

function pathError(path: string): string | undefined {
  const segments = path.split('/');
  if (!segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')) {
    return `files path ${JSON.stringify(path)} is invalid. Use normalized relative paths with letters, digits, dots, underscores, and hyphens; omit dot segments.`;
  }
  const encoder = new TextEncoder();
  if (segments.some(segment => encoder.encode(segment).byteLength > 255)) {
    return `files path ${JSON.stringify(path)} has a segment over the 255-byte cap. Shorten the segment.`;
  }
  if (encoder.encode(path).byteLength > 1024) {
    return `files path ${JSON.stringify(path)} exceeds the 1024-byte relative path cap. Shorten the path.`;
  }
  return undefined;
}

function pathCollision(path: string, paths: Iterable<string>): string | undefined {
  const folded = path.toLowerCase();
  for (const other of paths) {
    const otherFolded = other.toLowerCase();
    if (folded === otherFolded) {
      return `files paths ${JSON.stringify(path)} and ${JSON.stringify(other)} collide case-insensitively. Rename one file.`;
    }
    if (folded.startsWith(`${otherFolded}/`) || otherFolded.startsWith(`${folded}/`)) {
      return `files paths ${JSON.stringify(path)} and ${JSON.stringify(other)} collide as file and directory. Rename one file.`;
    }
  }
  return undefined;
}

/** Accepted paths are already normalized. No two accepted spellings can alias. */
export function validateAgentFiles(files: unknown): string[] {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return ['files must be an object mapping relative paths to template strings. Use { "data.json": "{{trigger.data}}" }.'];
  }
  const entries = Object.entries(files);
  const errors: string[] = [];
  if (entries.length > MAX_AGENT_INPUT_FILES) {
    errors.push(`files has ${entries.length} entries, over the ${MAX_AGENT_INPUT_FILES} file cap. Remove files from this node.`);
  }
  const paths = new Set<string>();
  for (const [path, source] of entries) {
    const collision = pathCollision(path, paths);
    if (collision) errors.push(collision);
    paths.add(path);
    const invalid = pathError(path);
    if (invalid) errors.push(invalid);
    if (typeof source !== 'string') {
      errors.push(`files[${JSON.stringify(path)}] must be a template string. Use a single expression to pass structured data.`);
    }
  }
  return errors;
}

/** Recheck the rendered dispatch boundary, including duplicate paths and UTF-8 byte caps. */
export function validateRenderedAgentFiles(files: RenderedAgentFile[]): void {
  if (files.length > MAX_AGENT_INPUT_FILES) {
    throw new AgentInputFileError(`files has ${files.length} entries, over the ${MAX_AGENT_INPUT_FILES} file cap. Remove files from this node.`);
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) total = checkRenderedFile(file, paths, total);
}

function checkRenderedFile(file: RenderedAgentFile, paths: Set<string>, total: number): number {
  const invalid = pathError(file.path);
  if (invalid) throw new AgentInputFileError(invalid);
  if (paths.has(file.path)) {
    throw new AgentInputFileError(`files path ${JSON.stringify(file.path)} is invalid or duplicated. Use unique normalized relative paths.`);
  }
  const collision = pathCollision(file.path, paths);
  if (collision) throw new AgentInputFileError(collision);
  paths.add(file.path);
  const bytes = new TextEncoder().encode(file.content).byteLength;
  if (bytes > MAX_AGENT_INPUT_FILE_BYTES) {
    throw new AgentInputFileError(`Input file ${JSON.stringify(file.path)} has ${bytes} bytes, over the ${MAX_AGENT_INPUT_FILE_BYTES} byte cap. Reduce this file's data.`);
  }
  total += bytes;
  if (total > MAX_AGENT_INPUT_TOTAL_BYTES) {
    throw new AgentInputFileError(`Input file ${JSON.stringify(file.path)} has ${bytes} bytes and raises the node total to ${total} bytes, over the ${MAX_AGENT_INPUT_TOTAL_BYTES} byte cap. Reduce this node's data.`);
  }
  return total;
}

export function agentFileWaitError(files: Record<string, string> | undefined, wait: { mode?: string } | undefined): string | undefined {
  return files && Object.keys(files).length && wait?.mode === 'none'
    ? 'files require wait.mode until_idle so inputs survive the consuming turn. Remove wait.mode none.' : undefined;
}

export function renderAgentFiles(
  files: Record<string, string> | undefined,
  ctx: TemplateContext,
  definition: Pick<WorkflowDefinition, 'policy'>,
): RenderedAgentFile[] {
  if (files === undefined) return [];
  const errors = validateAgentFiles(files);
  if (errors.length) throw new AgentInputFileError(errors.join('\n'));
  const strict = definition.policy?.onUnresolvedPath === 'fail';
  const rendered: RenderedAgentFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const [path, source] of Object.entries(files)) {
    const value = renderTemplate(source, ctx);
    // The interpreter audits top-level nodes. This also guards foreach bodies
    // before dispatch, with their item/index aliases in scope.
    if (strict) {
      const missing = collectUnresolvedTemplatePaths(source, ctx);
      if (missing.length) {
        throw new AgentInputFileError(`files[${JSON.stringify(path)}] has unresolved template paths: ${missing.join(', ')}. Correct the paths or use policy.onUnresolvedPath: "empty".`);
      }
    }
    const file = { path, content: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
    // Bound accumulated output before rendering the next file.
    total = checkRenderedFile(file, paths, total);
    rendered.push(file);
  }
  return rendered;
}
