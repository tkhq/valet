# Secrets, crypto, and configuration playbook

**Frameworks:** OWASP Top 10 2021 A02:2021 Cryptographic Failures, A05:2021 Security Misconfiguration, A07:2021 Identification and Authentication Failures, A08:2021 Software and Data Integrity Failures; OWASP ASVS 4.0.3 V2 Authentication, V3 Session Management, V6 Stored Cryptography, V7 Error Handling and Logging, V9 Communication, V14 Configuration; OWASP WSTG v4.2 §4.2 Configuration and Deployment, §4.4 Authentication, §4.9 Cryptography; CWE-798 Use of Hard-coded Credentials, CWE-259 Hard-coded Password, CWE-321 Hard-coded Cryptographic Key, CWE-312 Cleartext Storage of Sensitive Information, CWE-319 Cleartext Transmission, CWE-327 Broken/Risky Crypto Algorithm, CWE-328 Weak Hash, CWE-916 Weak Password Hash, CWE-330 Insufficient Randomness, CWE-295 Improper Certificate Validation, CWE-522 Insufficiently Protected Credentials, CWE-1188 Insecure Default, CWE-489 Debug Code.

This cell is scanner-led. Run the scanners first, triage their output, then do the reasoning a scanner cannot. `gitleaks detect --no-git --source .` (and `--source .` over history if the clone carries it) enumerates candidate secrets; you confirm which are live, in-scope, and reachable, and you find the crypto and config problems the scanner does not model.

The scanners (gitleaks and semgrep) are bootstrapped into the sandbox at cell start. An absent tool means the bootstrap could not reach the network — record it as a NOT_ASSESSED coverage row.

## Method

1. **Run the preflight probe first.** Run `sec-preflight` in the sandbox. It prints one row per known tool: present (y/n), a version, and the consequence when the tool is absent. For every tool it marks ABSENT, record a NOT_ASSESSED coverage row: `sec_coverage_report status=not_assessed area=<the scan> tool=<the tool> reason=<the printed consequence>` (e.g. "secrets not scanned because gitleaks is missing"). Never silently skip an absent tool.
2. **Run the present scanners.** Execute gitleaks over the clone (and any repo-local scanners the clone ships — a `.semgrep.yml`, a `Makefile` lint target). Capture the raw output. Record `sec_coverage_report status=assessed area='secrets scan' tool=gitleaks` for the scan you ran. A coverage `tool` must name a real scanner (gitleaks, semgrep, trufflehog, bandit, gosec, brakeman, eslint, cargo-audit); the server refuses an unknown tool. Omit the tool for a hand-assessed area.
3. **Triage each secret hit.** For each candidate: is it a real credential (not a placeholder/example/test fixture)? Is it live (a production key, not a rotated or dummy value)? Is it committed to the tree the engagement pins (not just a local `.env` that is gitignored)? A committed live credential is CWE-798 and typically high or critical. A placeholder is a false positive — refute it explicitly.
4. **Sweep crypto and config by hand** using the checklist below; scanners miss most of these because they are about *how* an API is used, not a matched string. Record an assessed coverage row for the crypto and config sweeps.

## Secrets checklist

- Hard-coded credentials, API keys, private keys, or tokens in source, templates, or checked-in config (CWE-798, CWE-259, CWE-321). Include CI files, Dockerfiles, IaC, and test fixtures that carry real values.
- Secrets logged, sent in URLs/query strings, or included in error responses (CWE-532 in logs, CWE-598 in query strings).
- Secrets in cleartext at rest where the threat model expects protection — config files, database columns, cookies (CWE-312).
- Credentials with no rotation path or shared across environments — a design note, usually low/medium.

## Cryptography checklist

- Broken or risky algorithms: MD5/SHA-1 for security, DES/3DES/RC4, ECB mode, weak key sizes (CWE-327). Named in code or config.
- Password storage with a fast or unsalted hash instead of a memory-hard KDF (bcrypt/scrypt/argon2/PBKDF2) — CWE-916. Check the auth library's hashing call.
- Predictable randomness for security tokens, session ids, password-reset tokens, or nonces: a non-CSPRNG (`Math.random`, `rand()`, `java.util.Random`) where unpredictability is required (CWE-330, CWE-338).
- Cleartext transmission: HTTP where sensitive data flows, TLS verification disabled, `InsecureSkipVerify` / `verify=False` / a custom trust-all cert callback (CWE-319, CWE-295).
- Missing integrity: unsigned tokens, downloads without checksum/signature verification, deserialization of unsigned data (A08, overlaps injection).

## Configuration and auth-failure checklist

- Insecure defaults left on: debug mode in production, verbose stack traces to the client, default credentials, an admin/management interface exposed (CWE-1188, CWE-489, WSTG-CONF-01..05).
- Missing or weak security headers where the framework does not set them, permissive CORS (`Access-Control-Allow-Origin: *` with credentials), and cookies without `HttpOnly` / `Secure` / `SameSite` on session cookies (ASVS V3.4).
- Authentication weaknesses: no rate limiting or lockout on login/OTP (credential stuffing, CWE-307), password-reset tokens that are guessable or do not expire, session ids not rotated on login (fixation, CWE-384), missing logout invalidation (ASVS V2, V3; A07).
- Dependency and supply-chain: a lockfile pinning a version with a known advisory, or an unpinned/mutable dependency source (A06/A08) — report the specific package and advisory when the clone's manifest makes it checkable; otherwise a `log` note.

## Evidence standard for this cell

For a secret: the file:line, what it is, and why it is live and in-scope (or refute it as a placeholder). For crypto/config: the file:line of the call or setting, the standard it violates (name the CWE/ASVS), and the impact. A raw scanner hit is not a finding until you have triaged it — an untriaged dump is noise.

## Severity guidance

- **critical** — a committed live production secret granting broad access, or credential/crypto failure that directly exposes user data at scale.
- **high** — a live secret with narrower scope, broken password hashing, or TLS verification disabled on a sensitive path.
- **medium** — weak-but-not-broken crypto, missing hardening on a sensitive endpoint, a known-vulnerable pinned dependency.
- **low** — insecure default with limited impact, missing header as defense-in-depth.

## Common false positives (hand these to verify)

- Example/placeholder secrets, test fixtures, and rotated/dummy values — refute with the reason.
- `Math.random` used for a non-security purpose (jitter, a UI id) — not a finding.
- A weak algorithm present in a dependency but not on a security path the app uses — note reachability.
