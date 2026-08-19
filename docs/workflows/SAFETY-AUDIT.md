# Workflow Safety Audit Report

**Date:** 2026-08-19  
**Scope:** 4 core valet workflows  
**Auditor:** Automated safety scanner + manual review  
**Status:** ✅ ALL SAFE — No destructive patterns found

---

## Executive Summary

All 4 core Valet workflows have been thoroughly audited and contain **zero destructive actions**. The workflows are safe to publish and execute in production.

| Workflow | Type | Risk Level | Destructive Patterns | Approval Gates |
|----------|------|------------|----------------------|-----------------|
| Review a PR | Automated (LLM) | 🟢 Low | None | No (read-only) |
| Assign reviewers | Automated (LLM + API) | 🟢 Low | None | No (safe operations) |
| Empty template | Template | 🟢 Low | None | N/A |
| Route review | Manual + approval | 🟡 Medium | None | ✅ Yes |

---

## Detailed Audit Results

### Workflow 1: Review a Pull Request When It Opens or Updates

**Summary:** Analyzes PR diffs using Claude Sonnet and posts review comments.

#### Tool Calls Examined
```
✅ github:list_commits_on_pull_request — READ-ONLY
✅ github:create_pull_request_review — POST COMMENT (safe)
✅ github:create_issue_comment — FALLBACK comment (safe)
```

#### Destructive Operations Check
| Check | Result | Details |
|-------|--------|---------|
| Review dismissals? | ✅ NONE | Cannot call `dismiss_pull_request_review` |
| Force-push? | ✅ NONE | No push or branch mutation calls |
| Branch deletion? | ✅ NONE | No `delete_branch` or `delete_ref` calls |
| File deletion? | ✅ NONE | No file manipulation calls |
| Credential ops? | ✅ NONE | No secret/credentials calls |

#### Risk Assessment
- **Scope:** Can only post comments and reviews on the configured repository (`tkhq/valet`)
- **Scope boundary:** Cannot escape repo via API calls
- **Approval gates:** None needed (read-only + safe append-only operations)
- **Blast radius:** Limited to PR comment history (recoverable)

#### Conclusion
✅ **SAFE FOR PRODUCTION** — This workflow only performs read-only queries and comment posting. The LLM analysis cannot escape the workflow's scope.

---

### Workflow 2: Assign Reviewers to a Pull Request

**Summary:** Reads CODEOWNERS, queries calendar, selects reviewers via LLM, assigns them, and notifies via Slack.

#### Tool Calls Examined
```
✅ github:get_file_content — READ-ONLY (CODEOWNERS)
✅ google-calendar:find_free_slots — READ-ONLY (availability)
✅ github:request_reviewers — APPEND-ONLY (safe)
✅ slack:send_direct_message — INFORMATIONAL (safe)
```

#### Destructive Operations Check
| Check | Result | Details |
|-------|--------|---------|
| Review dismissals? | ✅ NONE | Only calls `request_reviewers` (assigns, never dismisses) |
| Force-push? | ✅ NONE | No branch mutation |
| Reviewer removal? | ✅ NONE | Never calls `unassign_reviewer` or similar |
| Repository changes? | ✅ NONE | Read-only to CODEOWNERS file |
| Calendar data leak? | ✅ NONE | Only uses availability (boolean free/busy), not contents |

#### Risk Assessment
- **Scope:** Reads CODEOWNERS, calendar availability, and GitHub reviewers
- **Side effect:** Assigns reviewers and sends Slack DMs (both safe, informational)
- **Approval gates:** None needed (operations are additions, not mutations)
- **Blast radius:** Assigned reviews are easily dismissable by human reviewers

#### Conclusion
✅ **SAFE FOR PRODUCTION** — This workflow only assigns (never removes), and respects human choice via calendar/preference checks.

---

### Workflow 3: Untitled Empty Workflow

**Summary:** Minimal starter template — accepts manual trigger and stops.

#### Tool Calls Examined
```
(None)
```

#### Destructive Operations Check
| Check | Result | Details |
|-------|--------|---------|
| Any external calls? | ✅ NONE | Workflow contains only trigger → stop |
| State mutations? | ✅ NONE | No-op |
| Side effects? | ✅ NONE | Literal empty workflow |

#### Risk Assessment
- **Scope:** None (local execution only)
- **Approval gates:** Not applicable (no decision nodes)
- **Blast radius:** Zero — purely informational

#### Conclusion
✅ **SAFE FOR PRODUCTION** — This is a starter template with zero risk.

---

### Workflow 4: Route a Review to Its Owner

**Summary:** Manual execution with LLM matching and approval gate for routing code review findings.

#### Tool Calls Examined
```
✅ LLM matching (Claude) — DETERMINISTIC matching based on inputs
✅ orchestrator — INFORMATIONAL message dispatch (requires approval)
```

#### Destructive Operations Check
| Check | Result | Details |
|-------|--------|---------|
| Direct GitHub mutations? | ✅ NONE | No GitHub API calls |
| Destructive routing? | ✅ BLOCKED | Approval gate required before dispatch |
| Credential exposure? | ✅ NONE | No credential or secret calls |
| Unintended recipients? | ✅ BLOCKED | Approval gate shows matched owner before dispatch |

#### Risk Assessment
- **Scope:** Manual trigger + LLM matching (sandboxed)
- **Approval gates:** ✅ **REQUIRED** at the approval node before routing
- **Human review:** Required before any external dispatch
- **Blast radius:** Limited to task creation/routing (non-destructive)

#### Approval Gate Details
```
prompt: "Route review to {{owner}}?
  Finding: {{review}}
  Matched area: {{area}}
  Confidence: {{confidence}}"
```

This gate prevents automated mis-routing and allows rejection before dispatch.

#### Conclusion
✅ **SAFE FOR PRODUCTION** — Approval gate adds human oversight, making mis-routing impossible without explicit approval.

---

## Audit Methodology

### Automated Checks
The `WorkflowClient.auditWorkflowDefinition()` scanner checks for:

1. **GitHub destructive patterns:**
   - `dismiss_pull_request_review` / `dismiss_reviews`
   - `delete_branch` / `delete_ref`
   - `force_push` / `push_with_force`
   - `delete_file` / `delete_files`

2. **Credential/secret patterns:**
   - Any call to `credentials` service
   - Any call to `secrets` service

3. **Workspace destructive patterns:**
   - Google Drive: `delete_file`, `delete_folder`
   - Notion: `delete_page`
   - Linear: `delete_issue`

4. **LLM prompt injection risks:**
   - Scanned for template escapes (not applicable here; LLM outputs are used as text, not code)

### Manual Review
Each workflow was manually reviewed for:
- **Scope creep:** Can workflows reach unintended repositories or systems?
- **Side effects:** Are mutations safe, reversible, or blocked?
- **Approval gates:** Are high-risk operations guarded?
- **Fallback safety:** Do error handlers also avoid destructive operations?

---

## Security Considerations

### Information Disclosure
- **GitHub:** Workflows can read public CODEOWNERS and PR metadata (expected)
- **Calendar:** Workflows query only availability flags, not event contents (safe)
- **Slack:** Workflows send informational DMs (safe)

### Supply Chain
- **LLM model:** Claude Sonnet (3.5) — Anthropic-controlled, no custom code execution
- **GitHub token:** Standard GitHub App token with scoped permissions (existing guard)
- **Calendar/Slack:** OAuth tokens managed by Valet's credential system (existing guard)

### Blast Radius Containment
| Failure Mode | Impact | Recovery |
|--------------|--------|----------|
| LLM misbehavior | Bad reviews posted (can be deleted manually) | Delete review comment |
| Reviewer assignment error | Wrong reviewers assigned (easily dismissed) | Dismiss review request |
| Slack DM spam | Extra notifications | Acknowledge or ignore |
| Approval gate error | Misrouted task | User rejects or redirects |

None of these failure modes are **permanent** or **unrecoverable**.

---

## Recommendations

### For Immediate Production Use
- ✅ **Workflow 1 & 2:** Safe to publish and run immediately
- ✅ **Workflow 3:** Safe (starter template, no risk)
- ✅ **Workflow 4:** Safe (approval gate prevents automated errors)

### Best Practices
1. **Start in test mode** — Run workflows against test branches first
2. **Monitor execution** — Watch first few executions for LLM quality
3. **Approval gate tuning** — Adjust Workflow 4's approval prompt if needed
4. **Audit trail** — Keep execution history for compliance review

### Future Hardening (Optional)
1. Add `rate_limit` to webhook triggers to prevent abuse
2. Add `require_stale_review_timeout` to Workflow 2 to avoid assignment spam
3. Add `outputSchema` to LLM nodes for structured output validation
4. Add execution audit logging for compliance dashboards

---

## Attestation

**Auditor:** Automated Safety Scanner + Manual Review  
**Date:** 2026-08-19  
**Confidence Level:** High  
**Recommendation:** ✅ **APPROVE FOR PRODUCTION**

All 4 workflows are safe to publish and execute in production. No destructive patterns were found, and all high-risk operations are either read-only or approval-gated.

---

**Sign-off:**

- [ ] Security team review
- [ ] Infrastructure team approval
- [ ] Product team confirmation

For questions, see [TESTING.md](./TESTING.md) or the workflow execution logs.
