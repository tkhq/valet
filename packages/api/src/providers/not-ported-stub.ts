/**
 * Task 7 (THE CUTOVER) of the postgres-backend plan flips `AppDb` from
 * better-sqlite3 to Postgres, but `SqliteCredentialStore` and
 * `SqliteWorkflowStore` are hard-typed against the raw better-sqlite3
 * `Database.Database` handle (`AppDb["$client"]`) that no longer exists —
 * they're ported to pg-native implementations in Task 8
 * (`docs/specs/2026-07-15-postgres-backend-design.md`).
 *
 * Rather than fabricate a fake `$client` bridge (a type lie the no-`any`/
 * no-double-cast rules forbid), every construction site in this package
 * swaps to this stub for the duration of the cutover wave: a
 * correctly-typed implementation of the target port whose every method
 * throws at call time. Nothing on the boot path (stub-mode dev boot, the
 * scoped Task 7 test gates) calls a credential-store or workflow-store
 * method, so this is inert in practice until Task 8 replaces it.
 */
export function notPortedStub<T extends object>(portName: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return () => {
          throw new Error(
            `${portName}.${prop}() is not yet ported to Postgres — Task 8 of the postgres-backend plan ` +
              `(docs/specs/2026-07-15-postgres-backend-design.md) replaces this stub.`,
          );
        };
      },
    },
    // The Proxy above implements every property access of `T` as a
    // throwing function; the empty object literal has no properties of its
    // own to type-check against `T`; this cast documents that gap rather
    // than hiding it (see doc comment above for why a real bridge isn't
    // possible here).
  ) as T;
}
