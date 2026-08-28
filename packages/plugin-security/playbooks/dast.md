# DAST playbook — dynamic testing against a running target

Frameworks: OWASP Top 10, OWASP API Security Top 10, OWASP Web Security Testing Guide (WSTG). You test a RUNNING target within the authorized scope. You never touch a host the scope does not name.

## Preflight

1. Confirm the authorized scope. Read the "Authorized scope" block in your dispatch prompt. If it is empty, stop and record `not_assessed`.
2. Confirm the live tools. Run `sec-preflight` in the sandbox to see which live tools are present (a scanner, a wordlist, a browser MCP server). An absent tool becomes a NOT_ASSESSED row for the categories it covers.
3. Confirm reachability. A single low-rate GET to each scope host confirms the target is up before the sweep.

## Sweep order (WSTG-aligned)

1. Information gathering (WSTG-INFO): fingerprint the server, enumerate paths, read `robots.txt` and `.well-known/`.
2. Configuration (WSTG-CONF): security headers, TLS, CORS, cookie flags.
3. Authentication (WSTG-ATHN): login, reset, MFA, lockout, rate limits.
4. Session (WSTG-SESS): fixation, regeneration, logout, SameSite.
5. Authorization (WSTG-ATHZ): IDOR, privesc, tenant crossing — per endpoint per actor.
6. Input validation (WSTG-INPV): SQLi, XSS, SSRF, command injection, template injection.
7. Business logic (WSTG-BUSL): workflow skip, price tamper, replay, negative amount.
8. Client side (WSTG-CLNT): DOM XSS, CORS, postMessage.

## Evidence bar

A finding cites a scope host and carries a reproduction: the request, the response, and the impact. A raw scanner hit with no traced impact is a queue entry to triage, not a finding.

## Coverage honesty

Record a coverage row per WSTG category. A category you could not sweep — no tool, or the surface was out of reach within scope — is a `not_assessed` row naming the consequence.
