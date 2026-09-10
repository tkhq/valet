# Retire legacy team assistants

Use this procedure during a maintenance window. It does not run at startup.
Personal chats and current team assistants are outside this cleanup.

## Inventory (dry run)

Run this read-only query against the intended database. Supply the organization ID as `$1`.
For local PGlite, stop the local API before opening its database.

```sql
SELECT a.id AS assistant_id, s.id AS session_id, s.owner_id AS team_id,
       s.status, 'pre-update credential-owner stamp' AS reason
FROM agent_sessions s
JOIN assistants a ON a.session_id = s.id AND a.org_id = s.org_id
  AND a.owner_type = 'team' AND a.owner_id = s.owner_id
WHERE s.org_id = $1 AND s.owner_type = 'team'
  AND s.credential_owner_mode = 'actor'
  AND a.archived_at IS NULL
ORDER BY s.owner_id, s.id;
```

The `actor` stamp identifies sessions carried over when team credential ownership shipped.
Children can inherit it. The assistant join excludes those children.
Deleted sessions with live assistant rows remain in the inventory so retirement can finish.
Do not select records by creation date or session ID prefix alone.

## Apply an explicit selection

1. Review the inventory and select the session IDs to retire.
2. Stop incoming team automation during cleanup. Ask members to stop submitting turns.
3. Wait for running turns to finish.
4. As a team admin, call `DELETE /api/sessions/:id?retireLegacyTeam=true` for each selected ID.
5. Check each response before proceeding to the next ID.
6. Open the team workspace and create its replacement assistant if the empty state offers that action.
7. Verify that personal conversations retain their history.

The endpoint rechecks admin permission, the legacy stamp, and assistant ownership.
An unsettled submission returns 409 without deleting the session.
A personal chat or current team assistant returns 400.
Deletion uses the existing engine teardown and assistant retirement path.
A repeated request for the same deleted legacy session returns success.

The maintenance window prevents new work between the busy check and teardown.
This procedure does not remove the compatibility column or its resolver behavior.
It does not delete team memories, workflows, credentials, or plain child sessions.
