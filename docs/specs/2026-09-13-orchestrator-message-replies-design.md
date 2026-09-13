# Orchestrator message replies

**Date:** 2026-09-13

## Goal

A user can reply to one completed assistant text message in an orchestrator chat. The reply keeps the current thread and current transcript position.

## Decisions

1. A reply is a topical reference. It does not create a branch and does not rewind the transcript.
2. The web app offers Reply only for assistant messages that contain visible text and have an explicit completed state.
3. The composer shows a server-compatible excerpt and lets the user cancel the reply before send.
4. The client sends only the target entry id. The API reads the target from the authorized session and requested thread.
5. The API rejects a target from another thread or session. It also rejects user, tool-only, missing, and empty targets.
6. The API creates a normalized excerpt of at most 280 Unicode codepoints. Client text cannot replace this excerpt.
7. The queue item and user entry store `{ messageId, excerpt }` in durable entry metadata. REST projects this value as `Message.replyTo`.
8. The engine adds a delimited reply context before the current user text. It keeps all normal current context and does not remove later entries.
9. Slash commands do not carry reply references. The user must cancel the reply before running a slash command.

## Persistence round trip

The submit route validates the target and writes the reply reference into queue metadata. `Thread.appendUserEntry` copies that metadata to the user entry. The Postgres and in-memory stores preserve entry metadata. `entryToMessage` maps the reference and assistant completion state to the wire response. A streamed assistant message becomes complete only on `message_end`. The web message renderer shows the same excerpt after a REST reload.

The reply metadata does not change message parts. Tool-call result persistence keeps its existing engine, store, REST, and renderer shapes.

## Security

The request does not accept an excerpt, session id, or target thread id for the reply reference. The API first authorizes the session. It then resolves the target only from entries in the selected thread. An entry id from another user, team, session, or thread cannot resolve.

## Initial limits

The first version does not offer Reply on tool cards, signal cards, command results, system entries, or empty assistant messages. It does not add a fork view or a branch control.
