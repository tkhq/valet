# Fuzz playbook — mutation testing against a running target

Frameworks: OWASP WSTG input-validation family, CWE input-handling classes. You throw mutated input at a RUNNING target within the authorized scope. You never touch a host the scope does not name.

## Preflight

1. Confirm the authorized scope. Read the "Authorized scope" block. If it is empty, stop and record `not_assessed`.
2. Confirm the fuzzer. Run `sec-preflight` to see which fuzzers and wordlists are present. An absent fuzzer becomes a NOT_ASSESSED row for the input points it covers.
3. Enumerate input points. Map every parameter, header, body field, and upload the target's scope surface exposes.

## Mutation families per input point

1. Boundary values: 0, -1, MAX_INT, empty, oversized.
2. Type confusion: string where number expected, array where scalar expected.
3. Encoding layers: URL, double-URL, unicode, base64.
4. Injection markers: SQL, NoSQL, command, template, header CRLF.
5. Format-string and ReDoS markers.
6. Content-type coercion: json vs form vs xml.

## Anomaly signals

Watch for: a 500 or a stack trace, a timeout (ReDoS), a reflected marker (injection), a state change, or a differential response between two near-identical inputs. Each anomaly is a queue entry with the payload and the observed response.

## Evidence bar

A finding cites a scope host and carries a minimized reproduction: the input point, the exact payload, the anomaly, and the impact.

## Coverage honesty

Record a coverage row per input point. A point you could not fuzz — no tool, or out of reach within scope — is a `not_assessed` row naming the consequence.
