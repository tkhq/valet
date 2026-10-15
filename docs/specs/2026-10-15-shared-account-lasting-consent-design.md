# Lasting consent for a shared account

A member can let teammates use their shared account across conversations and workflow runs. The member must choose this explicitly.

## Scope

A new account approval offers Allow, Deny, and Always allow for this team. Allow keeps its current thread or workflow run scope. Existing pending approvals keep their current actions.

Always allow for this team records consent on the current credential share. Consent covers one member, service, team, and share generation. It permits account borrowing only. Action policies and workflow permissions still apply separately.

Only the account owner can grant consent through a browser session, local stub session, or verified linked Slack callback. Agent credentials, API keys, team principals, and automated turns cannot grant it.

Every borrow checks the current team, organization, actor authorization, and live share. Unattended runtime and workflow runs keep their durable team ownership checks. Disconnecting the account, leaving the team, or stopping the share ends consent. Sharing again requires new consent.

## Storage and resolution

The credential share has a nullable consent timestamp. Existing shares default to no consent. A conditional write checks the share generation, team organization, and current lender membership atomically. Workflow consent, resolution signal, audit, and durable wake flag commit in one transaction. Concurrent resolutions have one winner.

New tool gates store an occurrence ID in their intent checkpoint. Signal and notification IDs include that occurrence ID. Account resolution IDs also include the share generation. Replays use the stored occurrence ID. Fresh gates cannot reuse consumed answers or suppress new notifications. Existing pending gates keep their resolution IDs.

Each tool checkpoint retains the IDs of gate signals it consumed. Recovery accepts these receipts even when account consent advances into another intent checkpoint. It still redelivers a signal whose consumption has no checkpoint proof. The executor, recovery sweep, resolver, and pending-gate projection match answers to the current occurrence.

Preview checkpoints can have an account-consent transition marker without occurrence IDs or receipts. Recovery preserves their consumed consent. Old consent cannot answer a later action gate, including consent that an earlier sweep already redelivered. A changed share still accepts its own account answer. A preview run already waiting on the same account after consent fails explicitly.

New approval cards submit their occurrence ID. The server rejects missing or stale IDs before it writes grants or signals. Thread cards also use the occurrence ID in their resume key. A card for account borrowing cannot resolve a later action gate on the same node. Legacy pending gates accept their existing requests.

A private run's lender exception applies only to the requested account occurrence. Action gates require the run's normal audience authorization, including legacy transitions without occurrence IDs.

Run and inbox cards use the occurrence ID as their component key. Completing one card removes only that occurrence from the inbox.

After lasting consent, the workflow checks account access and action policy again. If the same account and share still require consent, the node fails explicitly. Changed shares can open a fresh account gate. An actor who leaves the team cannot borrow the account.

Lasting account consent keeps the action audit pending without an action approver. A separate audit row records the lender and consent scope. Policy denials and account refusals finalize the action audit before the node settles. A fresh action gate notifies the run's existing audience. Account gates notify the lender.

New gates advertise the lasting option explicitly. Old gates cannot gain this option during replay. Integrations shows whether consent lasts and explains that Stop sharing revokes it. The credential summary exposes consent status without secrets.

## Validation

Production tests cover cross-thread and cross-run reuse, tenant isolation, action policies, owner and human authorization, revocation, stale generations, and concurrent workflow resolutions. Resume tests cover actor removal, repeated account refusals, fresh Allow and Deny answers, terminal audits, and notification replay.
