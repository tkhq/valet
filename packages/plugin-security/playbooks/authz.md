# Authorization playbook — broken access control

**Frameworks:** OWASP Top 10 2021 A01:2021 Broken Access Control; OWASP API Security Top 10 2023 API1 Broken Object Level Authorization (BOLA), API3 Broken Object Property Level Authorization, API5 Broken Function Level Authorization (BFLA); OWASP ASVS 4.0.3 V4 Access Control; OWASP WSTG v4.2 §4.5 Authorization Testing; CWE-862 Missing Authorization, CWE-863 Incorrect Authorization, CWE-639 Authorization Bypass Through User-Controlled Key (IDOR), CWE-285 Improper Authorization, CWE-306 Missing Authentication for Critical Function, CWE-269 Improper Privilege Management, CWE-732 Incorrect Permission Assignment, CWE-566 Access Control Bypass.

Broken access control was the #1 risk in the 2021 OWASP Top 10. It is rarely a scanner find — it needs a human reading who-can-touch-what. Work from the recon cell's entry-point list; every handler is an authorization question.

## Method

For each entry point from recon, answer four questions in order. A "no" or "unclear" on any is a finding.

1. **Authentication present?** Does the handler require a verified identity before it runs? A mutating or data-returning endpoint reachable unauthenticated is CWE-306 / A01. Check the middleware order — a route registered outside the auth middleware, or before it, is unprotected even if a sibling route is not.
2. **Function-level authorization present?** Does the handler check the caller's role/permission for THIS action, not just that they are logged in? An admin action a normal user can call is BFLA (API5) / CWE-862. Look for the check to be *present at the handler*, not assumed from the UI hiding a button.
3. **Object-level authorization present?** When the handler acts on a record identified by a request parameter (id, slug, filename, tenant), does it verify the caller owns or may access THAT specific object? A query of the form `SELECT ... WHERE id = :id` with no `AND owner_id = :caller` is BOLA/IDOR (API1 / CWE-639) — the canonical, highest-frequency access-control bug. Check every id that comes from the request path, query, or body.
4. **Property-level authorization present?** On writes, can the caller set fields they should not (role, is_admin, price, owner_id, balance)? Mass-assignment / auto-binding of the whole request body to a model is API3 / CWE-915. On reads, does the response include fields this caller should not see?

## Where the bugs concentrate

- **The IDOR pattern.** Any lookup keyed by a client-supplied identifier without an ownership predicate in the same query or an explicit check after the fetch. Trace the id from the entry point to the query.
- **Middleware gaps.** Routes that bypass the auth/authz middleware: registered on a different router, mounted under a different prefix, added after the middleware, or matched by a wildcard that a later specific route shadows. Compare the protected set against recon's full entry-point list — the diff is the gap.
- **Insecure direct object references in files and paths.** A download/read handler that takes a filename or key and does not scope it to the caller (overlaps path-traversal in the injection cell — here the concern is *authorization*, there it is *containment*).
- **Horizontal vs. vertical.** Horizontal: user A reaches user B's data (same privilege level). Vertical: user reaches admin capability (privilege escalation). Test both — a handler can be safe against one and not the other.
- **Client-side or "security by obscurity" controls.** Authorization enforced only in the frontend, or relying on an unguessable id, is not enforced (A01, WSTG-ATHZ-02).
- **JWT / token trust.** Claims trusted without verifying signature, `alg: none` accepted, role/tenant read from an unsigned or client-editable part of the token (overlaps auth failures; here the concern is the authorization decision built on it).
- **State-changing GETs and missing CSRF** where the framework does not auto-protect (CWE-352) — an authorization bypass via the victim's own session.

## Evidence standard for this cell

A finding must show: the entry point (file:line), the missing or incorrect check, and the path by which a caller reaches an object or function they should not. State which class it is (BOLA / BFLA / property-level / missing-auth) and name the CWE. If you cannot show the reachable path, it is a `log` note for the verify cell, not a reported finding.

A finding `file` must be a repo-relative path (no leading `/`, no `..`) inside your cell's assigned scope. The server refuses a file outside your scope — it belongs to another cell. Title the finding by the vulnerability, not a placeholder.

## Severity guidance

- **critical** — unauthenticated reach to sensitive data or admin function, or trivial cross-tenant BOLA on high-value records.
- **high** — authenticated BOLA/BFLA reaching another user's data or a privileged action with realistic preconditions.
- **medium** — property-level over-exposure, or a bypass needing an unusual role or state.
- **low** — defense-in-depth gap (e.g. authorization enforced but not logged).

## Common false positives (hand these to verify)

- An ownership check that lives in a shared middleware or repository layer, not the handler — trace before reporting.
- A framework that auto-scopes queries to the tenant (row-level security, a global query filter) — confirm it is actually applied, then it is not a bug.
- An id that is a server-issued, unguessable, single-use token rather than a database key — reduced impact, note it.
