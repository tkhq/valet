import { IdentityFields, type IdentityFieldsProps } from "./identity-fields";

/**
 * "Meet your assistant" identity step (assistant-centered web UI, decision
 * 11). Shown full-page-centered on `/` on first visit (`info.name ===
 * null`) and reopened inline, prefilled, from the identity header's edit
 * affordance — same component, `variant` only changes copy/chrome, not
 * behavior.
 *
 * The actual name/personality fields + save mechanics live in
 * `identity-fields.tsx` (extracted for `/settings/assistant`'s reuse); this
 * module re-exports the pure helpers for the existing test suite and keeps
 * `IdentityStep` as a thin alias so the dashboard's call sites (and its
 * `variant="onboarding"|"edit"` contract) don't change.
 */
export {
  NAME_POOL,
  TRAIT_CHIPS,
  pickRandomName,
  appendTraitSentence,
  identitySubmitBody,
} from "./identity-fields";

export type IdentityStepProps = IdentityFieldsProps;

export function IdentityStep(props: IdentityStepProps) {
  return <IdentityFields {...props} />;
}
