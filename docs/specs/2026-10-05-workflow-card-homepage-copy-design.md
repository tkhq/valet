# Workflow cards and homepage copy

## Scope

Workflow request and result signals use compact operation rows in the thread.
They start collapsed, including short reports and legacy reports without a run ID.
Native details and summary elements provide keyboard expansion.
The outcome and verified run link remain visible when collapsed.
Expansion shows the full report without another truncation control.
Other signals retain their existing presentation.

## Homepage

Detected questions remain under Needs attention and use Reply.
Other assistant messages appear under Conversation updates and use Open thread.
An assistant update does not imply that the user must reply.
Archive labels describe the existing archive action.
Briefings without a next step do not claim that nothing needs the user.
A needs-attention briefing points to its linked sources, without assuming a conversation exists.
Existing source links, result grouping, and access rules remain unchanged.

## Validation

Focused web tests cover workflow expansion, full report text, run links, legacy signals, and homepage labels.
Manual browser review after deployment must check narrow layouts, keyboard focus, and archive behavior.
