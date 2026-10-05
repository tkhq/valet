# XORS deployment domain validation

Both `valet.xors.xyz` and `valet.xors.dev` serve the XORS installation.
The deploy workflow checks both domains after installation.
Each API must return a healthy `valet-api` response.
Both frontends must expose the same JavaScript entry path and content hash.
HTTP failures, missing entries, and differences fail the deployment check.
This check does not prove database identity or replace migration rehearsals.

Run `node scripts/check-xors-domains.mjs` for a read-only public check.
The check does not need credentials and does not send model requests.

Browser sessions are separate across the two registrable domains.
Users can need a separate sign-in even when both domains serve the same installation.
Model catalog additions do not change an organization's approved-model list.
Approve requested models separately without disabling the existing restriction.
