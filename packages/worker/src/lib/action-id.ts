/**
 * Qualify a bare action id with its service, unless it already carries the
 * `<service>.` prefix. dag/v1 action ids are stored service-prefixed
 * ("github.create_comment"); only hand-typed custom actions lack it. Guards
 * against the `github.github.*` double-prefix bug.
 */
export function qualifyActionId(service: string, action: string): string {
  return action.startsWith(`${service}.`) ? action : `${service}.${action}`;
}
