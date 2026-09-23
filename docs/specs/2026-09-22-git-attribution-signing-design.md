# Git attribution and App signing

Valet stores Git identity and signing as one valid mode. Co-author credit and opaque correlation trailers remain independent settings. A personal or team setting inherits each missing field from the organization.

Every engine session gets an insert-only snapshot. The active head identifies one generation. The session status GET is read-only and previews generation one before engine initialization. Snapshot creation and Apply use the session actor as the counterpart, never the requester. Resume and sandbox replacement keep that generation. Apply requires an idle session and creates a new generation. Apply does not rewrite commits.

The sandbox commit hook enriches messages and chains a repository hook that existed before Valet installed its hook. The wrapper activates the dispatcher for commit, merge, cherry-pick, revert, rebase, and am. The hook uses POSIX awk filtering and supports BusyBox. It fails closed when a created commit has no queue correlation identity. Hooks are not a security boundary. Each bash execution receives the exact queue item identity through both synchronous and job execution.

App-signed mode mints restricted, repository-scoped installation tokens. A sandbox Git token has read-only contents access. A sandbox API token can manage pull requests and comments but cannot write contents. Only the host replay capability gets contents write access. The host replays commits through the Git Database API without custom author, committer, or signature fields. The replay route caps declared and streamed body bytes. It also caps object counts, tree entries, and aggregate encoded and decoded bytes. The sandbox wrapper applies the same V1 budgets before upload. It verifies each returned Git object and signature before a non-force ref update.

Replay mappings, observed branches, and pull requests are durable. Optional trailers enrich analytics but do not own pull-request attribution.
