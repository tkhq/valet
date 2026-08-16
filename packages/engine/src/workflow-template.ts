/**
 * Workflow templates — the plugin-contributed half of the workflow gallery.
 *
 * A template is a ready-to-install workflow: card copy for the gallery, a
 * dag/v1 definition, and an optional cron schedule the host arms at install
 * time. Templates belong to the plugin that owns the actions they call, so
 * a host that does not load a plugin never offers a workflow it cannot run.
 * A template that spans several services belongs to the plugin that owns
 * the workflow surface itself.
 *
 * `definition` is `unknown` on purpose. The concrete `WorkflowDefinition`
 * type lives in `@valet/workflow`, and this manifest composes only
 * engine-owned types (see `valet-plugin.ts`). The host narrows it with the
 * same validator every other definition passes through, so a template that
 * drifts out of contract fails at list or install time with the validator's
 * own message, not at run time inside a node.
 */

/**
 * Cron schedule a template arms at install time. The host validates the
 * expression before it writes anything, so a bad cron fails the install
 * instead of arming a schedule that never fires.
 */
export interface WorkflowTemplateSchedule {
  /**
   * Base schedule name. The host appends a per-install suffix, so two
   * installs of one template stay apart in the schedules list.
   */
  name: string;
  /** 5-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
  /** IANA timezone name. The host uses UTC when this is absent. */
  timezone?: string;
  /** One line of card copy for the cadence, e.g. "Weekdays at 08:00 UTC". */
  description: string;
}

export interface WorkflowTemplate {
  /**
   * Stable, globally unique id — the install route's path parameter. Two
   * plugins that claim one id is a build error, so namespace it with the
   * owning plugin, e.g. "github-daily-dev-digest".
   */
  id: string;
  /** Card title, and the installed workflow's default name. */
  name: string;
  /** One or two sentences: what the workflow does, and what it needs. */
  description: string;
  /** Gallery grouping key, e.g. "Daily digest". */
  category: string;
  /** Optional emoji or icon key for the card. */
  icon?: string;
  /**
   * Brand tokens for the card's logo chain, e.g. ["github", "linear"].
   * These are display tokens, not service ids: the services a template
   * needs are read from its tool nodes, never from this list.
   */
  apps: string[];
  /** Human-readable step list, shown before the person installs. */
  steps: string[];
  /**
   * Limits an author knows that the definition cannot show — anything the
   * host cannot derive for itself. The host adds its own derived caveats
   * (dynamic action names, approval-gated steps, batch caps) on top.
   */
  caveats?: string[];
  /** A dag/v1 `WorkflowDefinition`. See the module comment for the type. */
  definition: unknown;
  /** Cron schedule to arm with the workflow, in the same transaction. */
  schedule?: WorkflowTemplateSchedule;
}
