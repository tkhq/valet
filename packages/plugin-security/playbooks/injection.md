# Injection playbook — untrusted data reaching a sink

**Frameworks:** OWASP Top 10 2021 A03:2021 Injection and A10:2021 Server-Side Request Forgery (SSRF); OWASP ASVS 4.0.3 V5 Validation, Sanitization and Encoding; OWASP WSTG v4.2 §4.7 Input Validation Testing; CWE-89 SQL Injection, CWE-78 OS Command Injection, CWE-77 Command Injection, CWE-94 Code Injection, CWE-95 Eval Injection, CWE-1336 Server-Side Template Injection, CWE-79 Cross-Site Scripting, CWE-22 Path Traversal, CWE-611 XML External Entity (XXE), CWE-502 Deserialization of Untrusted Data, CWE-918 SSRF, CWE-90 LDAP Injection, CWE-943 NoSQL/query injection; OWASP Cheat Sheets: SQL Injection Prevention, OS Command Injection Defense, Injection Prevention, Deserialization, SSRF Prevention, XXE Prevention.

Injection is a reachability problem: untrusted input flows to a sink that interprets it as code, a query, a path, or a request target. Work from the recon cell's sinks column. For each sink, trace backward to a source; a source-to-sink path with no effective sanitization between them is the finding.

## The sink taxonomy — what to grep for and trace

- **SQL / query (CWE-89, CWE-943).** String-built queries or format strings feeding the db driver. RED FLAG: concatenation or interpolation into SQL/NoSQL instead of parameterized queries / prepared statements. Safe: bound parameters. An ORM is not automatically safe — raw fragments, `.raw()`, `whereRaw`, dynamic column/table names, and `ORDER BY` built from input all reintroduce it.
- **OS command (CWE-78, CWE-77).** Process spawn with a shell: `system`, `exec`, `popen`, `sh -c`, `child_process.exec`, `os/exec` with a shell, `subprocess` with `shell=True`, backticks. RED FLAG: input in the command string. Safe: argument-vector spawn (no shell) with a fixed program and input as separate args.
- **Code / eval (CWE-94, CWE-95).** `eval`, `Function()`, `exec`, `pickle`/`marshal` of code, dynamic `require`/`import` of an input-derived path, template compilation from input.
- **Server-side template injection (CWE-1336).** User input rendered AS a template rather than passed as template data (Jinja2, Twig, Freemarker, ERB, Handlebars, Velocity). RED FLAG: `render_template_string(user_input)` or concatenating input into the template source.
- **Path traversal (CWE-22).** File read/write/serve where a filename or path segment comes from input. RED FLAG: `../` not neutralized, `path.join(base, userInput)` without a containment check, absolute-path override. Safe: canonicalize then verify the result stays under the intended base.
- **XXE (CWE-611).** XML parsed with external entities / DTD processing enabled. RED FLAG: default parser config on `.xml` input; check the parser is hardened (external entities and DOCTYPE disabled).
- **Deserialization (CWE-502).** Untrusted bytes fed to a native deserializer: Java `readObject`, Python `pickle`/`yaml.load` (unsafe), Ruby `Marshal`/unsafe YAML, PHP `unserialize`, .NET `BinaryFormatter`. RED FLAG: any of these on request/queue/cookie data. This is frequently critical (remote code execution).
- **SSRF (CWE-918, A10).** Outbound request (HTTP client, URL fetch, webhook, image/PDF fetcher, XML/SVG loader) whose target URL or host is input-derived. RED FLAG: no allowlist, redirects followed, and reachability to `169.254.169.254` (cloud metadata), `localhost`, or internal ranges. Judge internal reachability from the recon trust-boundary map.
- **XSS (CWE-79).** Input reflected into HTML/JS without context-correct output encoding, or `dangerouslySetInnerHTML` / `v-html` / `|safe` / `innerHTML` on input. Distinguish reflected, stored, and DOM. Stored XSS on a shared surface is the higher impact.
- **LDAP / header / log / other interpreters (CWE-90, CWE-93, CWE-117).** Input into an LDAP filter, an HTTP response header (splitting), or a log line (forging/poisoning).

## Method per sink

1. Confirm the sink actually interprets its input (a parameterized query does not; a concatenated one does).
2. Trace backward to a source (entry point, or a second-order source the recon cell flagged — DB/queue data that was attacker-controlled earlier).
3. Check the path between them for *effective* neutralization for THIS sink. Encoding for the wrong context does not count (HTML-escaping does not stop SQLi; escaping quotes does not stop `ORDER BY` injection). A denylist/`replace('..','')` is usually bypassable (ASVS V5.1) — treat it as ineffective unless proven otherwise.
4. If input reaches the sink uninterpreted-as-intended, report with the source, the path, and the sink.

## Evidence standard for this cell

Show the source (file:line), the sink (file:line), the data path between them, and why the neutralization (if any) does not cover this sink. Name the CWE and the injection class. A payload sketch that would reach the sink strengthens it but the traced path is the requirement.

## Severity guidance

- **critical** — unauthenticated RCE (command/code/deserialization) or full-database SQLi; SSRF reaching cloud metadata or an internal admin service.
- **high** — authenticated injection with realistic preconditions, stored XSS on a shared surface, path traversal reading arbitrary files.
- **medium** — reflected XSS needing user interaction, injection gated behind an unusual role or non-default config.
- **low** — injection into a low-value context with limited impact, or requiring a trusted position.

## Common false positives (hand these to verify)

- Parameterized queries that merely *look* concatenated because of a query builder's string form — confirm binding.
- Input constrained to a safe type before the sink (parsed to int, matched against a strict allowlist/enum) — reduced or no reachability.
- SSRF where the client can only reach a fixed, hardcoded host — not attacker-controlled.
- "Injection" into a sink that does not interpret the data as code (writing input into a plain text file that is never executed or rendered).
