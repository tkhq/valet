# Subscription form cleanup

The automation wizard and edit dialog use one event matching component. Neither form imports the other form.

`event-match-step.tsx` owns the event picker and filter editor layout. `subscription-match.ts` owns selected keys, filter rows, catalog field union, and common filter validation. When a user deselects an event, the hook removes only filters that no selected event supports. It does not prune stored filters when a catalog loads.

Both forms reject incomplete filter rows and contradictory channel scope. The edit dialog also requires fixed channel scope for mention rules unless the user selects Any channel. The wizard retains its existing server validation for missing scope in the raw event flow. Its dedicated reply flow still requires channels or an explicit Any channel selection.

Each form keeps its submission behavior. The wizard builds a create request. The edit dialog builds a patch with changed fields only. A rename does not resend filters or run the collision check again. Both forms retain collision retries and the Done action after a committed overlap.

Regression tests use both forms with their shared component. They cover filter pruning, invalid rows, channel scope, stored any-channel state, changed-field patches, and collision retries. Existing wizard tests cover reply channels, schedule creation, targets, and prompts.
