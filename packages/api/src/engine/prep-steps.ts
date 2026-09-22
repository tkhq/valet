/**
 * Maps `StepSpec` ids from `computeSpec` to live `PrepStep` objects with
 * `apply` closures (sandbox-reconciliation plan, Task 6).
 *
 * Recognized ids:
 *  - `credential-scripts` → `installCredentialHelper` + git safe.directory/
 *    useHttpPath config (already part of that function).
 *  - `git-identity` → `configureGitIdentity`.
 *  - `clone:<fullName>` → `prepBinding` (normal clone) or `prepPrebuiltBinding`
 *    for the position-0 binding when `snap.repoBake` is non-null.
 *
 * Start-ref capture follows the same best-effort pattern as the old
 * `buildWorkspacePrep`: after the position-0 clone step applies successfully,
 * `resolveStartRef` is called and the result forwarded to `onStartRef` (if
 * set). A failure here is logged and never thrown.
 */
import type { PrepStep } from "@valet/engine";
import type { ResolveSnapshot, StepSpec } from "./sandbox-spec.js";
import {
  installCredentialHelper,
  configureGitIdentity,
  dirHasGit,
  prepBinding,
  prepPrebuiltBinding,
  resolveStartRef,
  installGitAttributionHook,
} from "./workspace-prep.js";

/**
 * Pairs each `StepSpec` in `specs` with an `apply` closure drawn from the
 * workspace-prep internals.
 *
 * `snap` supplies the session context (apiUrl, user identity, repo bindings,
 * repoBake). `specs` MUST come from `computeSpec(snap).steps` — every id in
 * `specs` must be either `"credential-scripts"`, `"git-identity"`, or
 * `"clone:<fullName>"` matching a binding in `snap.repos`. An unrecognized id
 * throws immediately (programmer error — spec and snapshot are out of sync).
 *
 * `onStartRef` is called best-effort after the position-0 clone step succeeds,
 * mirroring the old `buildWorkspacePrep` tail.
 */
export function buildPrepSteps(
  snap: ResolveSnapshot,
  specs: StepSpec[],
  onStartRef?: (ref: import("@valet/engine").SessionStartRef) => void | Promise<void>,
): PrepStep[] {
  const steps: PrepStep[] = [];

  for (const spec of specs) {
    if (spec.id === "credential-scripts") {
      steps.push({
        id: spec.id,
        hash: spec.hash,
        critical: spec.critical,
        afterResume: (sandbox) => installCredentialHelper(sandbox, snap.apiUrl, snap.credentialCommands ?? [], snap.gitAttribution?.mode === "valet_app_signed"),
        async apply(sandbox) {
          await installCredentialHelper(sandbox, snap.apiUrl, snap.credentialCommands ?? [], snap.gitAttribution?.mode === "valet_app_signed");
        },
      });
      continue;
    }

    if (spec.id === "git-identity") {
      const valetIdentity = snap.gitAttribution?.mode.startsWith("valet_");
      const name = valetIdentity ? snap.gitAttribution?.valetName : snap.userName;
      const email = valetIdentity ? snap.gitAttribution?.valetEmail : snap.userEmail;
      steps.push({
        id: spec.id,
        hash: spec.hash,
        critical: spec.critical,
        afterResume: (sandbox) => configureGitIdentity(sandbox, name, email),
        async apply(sandbox) {
          await configureGitIdentity(sandbox, name, email);
        },
      });
      continue;
    }

    if (spec.id.startsWith("clone:")) {
      const fullName = spec.id.slice("clone:".length);
      const bindingIndex = snap.repos.findIndex((r) => r.fullName === fullName);
      if (bindingIndex === -1) {
        throw new Error(
          `prep-steps: unknown clone step id "${spec.id}" — no matching binding in snapshot (programmer error)`,
        );
      }
      const binding = snap.repos[bindingIndex];
      const targetDir = binding.targetDir;
      const isPrimary = bindingIndex === 0;
      const prebuild = isPrimary && snap.repoBake ? snap.repoBake : null;

      steps.push({
        id: spec.id,
        hash: spec.hash,
        critical: spec.critical,
        async apply(sandbox) {
          // Container markers can disappear on resume or API restart. Existing
          // repositories belong to the session: preserve their HEAD and files.
          if (!await dirHasGit(sandbox, targetDir)) {
            if (prebuild) {
              await prepPrebuiltBinding(sandbox, targetDir, binding, {
                bakedSha: prebuild.bakedSha,
                recipe: prebuild.recipe,
              });
            } else {
              await prepBinding(sandbox, targetDir, binding);
            }
          }

          if (snap.gitAttribution) {
            const userMode = snap.gitAttribution.mode.startsWith("user_");
            const counterpart = userMode
              ? { name: snap.gitAttribution.valetName, email: snap.gitAttribution.valetEmail }
              : snap.gitAttribution.counterpartName && snap.gitAttribution.counterpartEmail
                ? { name: snap.gitAttribution.counterpartName, email: snap.gitAttribution.counterpartEmail } : undefined;
            await installGitAttributionHook(sandbox, targetDir, { coAuthor: snap.gitAttribution.coAuthoredBy ? counterpart : undefined, correlationTrailers: snap.gitAttribution.correlationTrailers });
          }

          // Start-ref capture for the primary binding — best-effort.
          if (isPrimary && onStartRef) {
            try {
              const ref = await resolveStartRef(sandbox, targetDir);
              if (ref) await onStartRef(ref);
              else console.error("prep-steps: start-ref unresolvable for primary binding — continuing");
            } catch (err) {
              console.error(
                "prep-steps: start-ref capture failed — continuing:",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        },
      });
      continue;
    }

    throw new Error(`prep-steps: unrecognized step id "${spec.id}" (programmer error)`);
  }

  return steps;
}
