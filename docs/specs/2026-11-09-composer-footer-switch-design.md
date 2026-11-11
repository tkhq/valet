# Composer footer switch

The Run without asking switch replaces the keyboard hint between Attach and the model picker. There is no separate switch row below the composer.

The switch keeps its permission rules and confirmation dialog. Personal owners and team admins can turn it on. Anyone who sees it on can turn it off. Org-owned threads cannot turn it on. The dock hides it, except in the mobile shared-chrome conversation. Read-only threads keep the switch beside the notice, only while on.

When the switch is unavailable, desktop keeps the keyboard hint. Touch keeps the hint hidden. This fallback is an explicit product assumption.

The label does not wrap or truncate. The switch track and thumb show its state. The control keeps its accessible label, switch role, checked state, and keyboard access. At 1280px and 390px, the label and switch remain visible. The model picker can use the remaining width.

## Validation

Component tests cover footer placement, hint replacement and fallback, permissions, confirmation, keyboard access, and read-only visibility. Real-app Playwright captures compare dev-v2 before and after at desktop and touch widths, including confirmation and enabled state.
