# Contributor guides

Practical guides for changing this codebase. Read the one that matches what you
are about to do.

| Guide | Read it when |
| --- | --- |
| [Placement](./placement.md) | You are adding a file and do not know which package owns it |
| [Building a feature](./building-a-feature.md) | Your change cuts through the stack, and you want the build order |
| [Data fetching](./data-fetching.md) | You are reading or writing server state in `packages/web` |
| [Styling](./styling.md) | You are building or restyling UI |
| [Web performance](./web-performance.md) | A page feels slow, or you are about to reach for `memo` |

The last three cover `packages/web` only. [CLAUDE.md](../../CLAUDE.md) remains
the source for repo-wide rules: the locked architecture decisions, the dev loop,
the writing standard, and the traps we have already hit.
