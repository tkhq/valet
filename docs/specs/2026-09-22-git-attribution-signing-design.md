# Git attribution and App signing

Valet stores Git identity and signing as one valid mode. Co-author credit and opaque correlation trailers remain independent settings. A personal or team setting inherits each missing field from the organization.

Every engine session gets an insert-only snapshot. The active head identifies one generation. Resume and sandbox replacement keep that generation. Apply requires an idle session and creates a new generation. Apply does not rewrite commits.

The sandbox commit hook enriches messages and chains a repository hook that existed before Valet installed its hook. Hooks are not a security boundary. Each bash execution receives the exact queue item identity through both synchronous and job execution.

App-signed mode mints restricted, repository-scoped installation tokens. A sandbox Git token has read-only contents access. A sandbox API token can manage pull requests and comments but cannot write contents. Only the host replay capability gets contents write access. The host replays commits through the Git Database API without custom author, committer, or signature fields. It verifies each returned Git object and signature before a non-force ref update.

Replay mappings, observed branches, and pull requests are durable. Optional trailers enrich analytics but do not own pull-request attribution.
