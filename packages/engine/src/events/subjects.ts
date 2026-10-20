/**
 * Pure helpers over the canonical subject grammar (spec:
 * docs/specs/2026-10-15-event-wakeups-design.md, Part A1). A subject is a
 * string naming one object an event concerns, e.g. "github:acme/x#1" or
 * "slack:T001/C001/1712345678.000100". No node imports here — this module
 * is part of the engine barrel's browser-safe chain.
 */

/** Returns the service prefix of a subject: the text before its first ":". */
export function subjectService(subject: string): string {
  const i = subject.indexOf(":");
  return i === -1 ? subject : subject.slice(0, i);
}
