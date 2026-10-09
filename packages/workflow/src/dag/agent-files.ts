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

function validPath(path: string): boolean {
  return path.split('/').every((segment) =>
    /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..');
}

function pathCollision(path: string, paths: Iterable<string>): string | undefined {
  for (const other of paths) {
    if (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) {
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
    if (!validPath(path)) {
      errors.push(`files path ${JSON.stringify(path)} is invalid. Use normalized relative paths with letters, digits, dots, underscores, and hyphens; omit dot segments.`);
    }
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
  if (!validPath(file.path) || paths.has(file.path)) {
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

export function renderAgentFiles(
  files: Record<string, string> | undefined,
  ctx: TemplateContext,
  definition: unknown,
): RenderedAgentFile[] {
  if (files === undefined) return [];
  const errors = validateAgentFiles(files);
  if (errors.length) throw new AgentInputFileError(errors.join('\n'));
  const strict = definition !== null && typeof definition === 'object' && 'policy' in definition &&
    definition.policy !== null && typeof definition.policy === 'object' &&
    'onUnresolvedPath' in definition.policy && definition.policy.onUnresolvedPath === 'fail';
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
