# Durable sandbox tokens implementation plan

Goal: implement TKAI-498 so API restarts do not interrupt sandbox authentication.

Design: keep token hashes in the existing table. Derive recoverable bearer values
from a random row ID and the instance encryption key with a domain-separated HMAC.
Use the year 9999 expiry sentinel for lifetime tokens. This preserves compatibility
with the existing non-null schema and older API verifiers during rolling updates.
Revocation remains authoritative. No plaintext bearer is stored.

1. Add failing tests for adoption, lifetime, principal isolation, and revocation.
2. Add durable mint/adoption and promote unexpired legacy tokens at API boot.
   Never revive expired or revoked credentials.
3. Wire the host to the stable instance encryption key. Remove the rotation sweep.
4. Test HTTP server restart with a new host, retained database, and original bearer.
5. Count rejected known credentials by reason and add an alert with corrective action.
6. Update auth, sandbox reconciliation, and GitHub specs and stale CLAUDE guidance.
7. Run targeted tests, typecheck, and the complete make e2e scorecard.
8. Review the diff, commit, push, and open a PR against dev-v2.

A concurrent first adoption can create two valid credentials. Neither revokes the
other. Later builds select the oldest recoverable credential; teardown revokes all.
A changed encryption key can mint another credential without invalidating the old
one. Operators must retain the encryption key across ordinary API restarts.
