# Overheard digest sender authority

An unlinked channel sender can use the subscription creator's actor ID with `author.externalSender: true`.
A linked teammate can use that same actor ID without the restriction.
The engine must keep their queued content separate because tools use this marker to restrict the resulting turn.

Overheard coalescing now requires the same origin thread, author ID, and external-sender status.
An absent marker and an explicit `false` both mean a linked sender.
The digest keeps the newest constituent's author, after the engine verifies that every constituent has the same authority.

Messages within each authority group can still form and extend a digest.
Dispatch deduplication and crash repair retain their existing behavior.
Crash repair settles a digest's saved constituent IDs; it does not combine separate digests.
This change prevents new mixed digests. It does not rewrite digests persisted by older versions.

## Validation

The regression tests submit messages with the same actor ID and different external-sender status, in both orders.
They verify that each original stays queued until another message with matching authority arrives.
After a sweep, two digests remain, each containing only its own authority group's content.
Both cases failed before the fix because the first submission had already merged into a mixed digest.
