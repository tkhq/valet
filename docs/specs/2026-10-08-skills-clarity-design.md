# Skills clarity

Skills supply instructions to the assistant. Installation does not connect an account or grant access.

## Catalog and sources

The Skills page opens the catalog. A secondary Sources view holds repository imports and sync management.
The `view=sources` search parameter selects that view. Unknown values open the catalog.
Both views retain catalog filters, scope, and independent cursor stacks in the URL.
The workspace switcher continues to select the catalog owner and source owner.
Plugin cards say “Installed instructions”. They do not fetch credential status.

## Skill details

Details show the skill source and ownership. Plugin authors manage plugin instructions.
Stored skill ownership uses the existing owner badge. Team-owned local skills say “Team”, not “Yours”.

Plugin skill details read the existing plugin connection metadata for the active personal or team workspace.
Connection labels use the existing health rules, including expired and sign-in-only states.
A failed read or absent plugin reports unavailable status. It does not imply disconnected status.
The page links to Integrations for setup and repair.

Plugin connections are not a list of required connections for every skill. The task determines which connections are needed.
Stored skills have no structured prerequisite metadata. Their details direct readers to the playbook.
The page does not infer dependencies from names or markdown.

## Try in chat

Try in chat opens the existing workspace assistant with an editable starter prompt.
The existing draft helper fills only an empty draft and preserves existing text and attachments.
No URL auto-submit parameter is introduced. The user sends the prompt.
Shadowed stored skills cannot use this action because name resolution would invoke a different skill.

## Validation

Focused tests cover catalog and Sources state, workspace connection scope, unavailable connection status, and starter prompt handoff.
Existing composer draft tests cover preservation and workspace isolation.
