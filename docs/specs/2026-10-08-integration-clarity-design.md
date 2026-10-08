# Integration capabilities and connections

Integrations must separate installed capabilities from account authorization.
Personal cards retain their existing account, health, connect, and reconnect controls.
They name the connection scope and expose a collapsible tools-and-skills section.
Team Integrations uses the team-scoped plugin catalog for the same capability details.

The plugin catalog includes names and descriptions of bundled skills. It does not include skill bodies or credential secrets.
Related skill links use those declarations rather than a service-name lookup table.
Existing servers without this metadata show an unavailable-details message.

Tool names and approval requirements come from the existing host-resolved action summaries.
Dynamic tools are described as discovered on connection. Requested OAuth scopes do not imply granted permissions or file access.
Long lists have bounded scroll areas and long permission names wrap on small screens.

Validation covers disconnected services, dynamic tools, old-server compatibility, related links, and metadata-only API responses.
No database migration or connection mutation is required.
