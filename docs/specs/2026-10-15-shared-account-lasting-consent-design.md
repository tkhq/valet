# Lasting consent for a shared account

A member can let teammates use their shared account across conversations and workflow runs. The member must choose this explicitly.

## Scope

A new account approval offers Allow, Deny, and Always allow for this team. Allow keeps its current thread or workflow run scope. Existing pending approvals keep their current actions.

Always allow for this team records consent on the current credential share. Consent covers one member, service, team, and share generation. It permits account borrowing only. Action policies and workflow permissions still apply separately.

Only the account owner can grant consent through a browser session, local stub session, or verified linked Slack callback. Agent credentials, API keys, team principals, and automated turns cannot grant it.

Every borrow checks the current team, organization, actor authorization, and live share. Unattended runtime and workflow runs keep their durable team ownership checks. Disconnecting the account, leaving the team, or stopping the share ends consent. Sharing again requires new consent.

## Storage and resolution

The credential share has a nullable consent timestamp. Existing shares default to no consent. A conditional write checks the share generation, team organization, and current lender membership atomically. Workflow consent, resolution signal, audit, and durable wake flag commit in one transaction. Concurrent resolutions have one winner. Account resolution IDs include the share generation, so a new share cannot reuse a consumed consent signal.

Lasting account consent keeps the action audit pending until the action policy permits execution. A separate audit row records the lender and consent scope.

New gates advertise the lasting option explicitly. Old gates cannot gain this option during replay. Integrations shows whether consent lasts and explains that Stop sharing revokes it. The credential summary exposes consent status without secrets.

## Validation

Production tests cover cross-thread and cross-run reuse, tenant isolation, action policies, owner and human authorization, revocation, stale generations, and concurrent workflow resolutions.
