# Artifact homepage navigation

The standalone artifact reader provides a visible `Back to Valet` link to `/`.
It uses a normal anchor so direct links and new browser tabs do not need browser history.
The link also appears during loading, errors, empty responses, and after revocation.
The header wraps controls on narrow screens and keeps the home link outside the sandboxed artifact frame.
The homepage keeps its existing authentication and workspace selection behavior.
Artifact access rules do not change.

Regression tests cover the loaded, loading, failed, and revoked states.
