# Product announcements

The signed-in app shows a nonmodal product update with a title, description, CTA, and dismiss button. The notice does not take focus.

The server owns a stable announcement ID and its content. `product_announcements` records the release activation time once during installation. `product_announcement_acknowledgements` records each user's acknowledgement. Future notices use a new ID and their own eligibility check.

`GET /api/product-announcements` returns eligible, unacknowledged notices. `POST /api/product-announcements/:id/acknowledge` saves acknowledgement for the authenticated user. Repeated requests are idempotent. Team API keys cannot acknowledge notices for their creator.

Dismissal and the CTA save acknowledgement before hiding the notice. The CTA then opens its internal destination. A failed save keeps the notice visible with a retry message. An acknowledged notice stays hidden across reloads and devices. Already open devices refresh on window focus. An account change prevents a pending acknowledgement from navigating or changing the next user's cache.

The first notice explains that workflow run threads moved to Automations. Its CTA opens `/workflows`. Eligibility requires an account created before activation and an existing run-owned thread created before activation. The server checks the current organization, session owner, team membership, and per-viewer thread visibility. New users and users without affected history receive no notice. Workflow editor conversations do not qualify.

The schema follows the pre-1.0 migration convention. Both fresh installs and existing deployments create the tables and seed activation once. The schema repair creates the activation row with its table in one transaction.
