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

/**
 * One filter on a template's event trigger.
 *
 * The value is either a literal, or `fromInput` — the name of a trigger
 * `dataSchema` field the person fills in at install. A repository is the
 * motivating case: the template knows it needs a repo filter, and only the
 * installer knows which repo.
 *
 * A filter with neither, or with both, is refused before anything is
 * written. So is a `field` the selected event keys do not declare: the
 * ingest matcher only consults the arriving event's own catalog entry, so
 * an undeclared field produces a subscription that matches nothing, forever,
 * with no error to read.
 */
export interface WorkflowTemplateEventFilter {
  /** A field the event catalog declares for these keys, e.g. "repo". */
  field: string;
  op: "eq" | "in" | "prefix" | "contains";
  /** Literal value. Mutually exclusive with `fromInput`. */
  value?: string | string[];
  /**
   * Trigger `dataSchema` field whose install-time value becomes this
   * filter's value. Declare that field `required: true` — an event
   * template's inputs are resolved at install, because an event run merges
   * no `dataSchema` defaults.
   */
  fromInput?: string;
}

/**
 * An event subscription the host arms with the workflow, in the same
 * transaction that writes the definition.
 *
 * Without this a template that runs on events installs INERT: the
 * definition is correct and nothing ever calls it, which reads as a broken
 * workflow rather than an unfinished setup. A cron template has had
 * `schedule` for exactly this reason since the gallery shipped.
 */
export interface WorkflowTemplateEventTrigger {
  /**
   * Base name. The host appends a per-install suffix, the same way it does
   * for a schedule, so two installs stay apart in the Triggers list.
   */
  name: string;
  /** Catalog event keys. A trailing ".*" wildcard is allowed. */
  eventKeys: string[];
  filters?: WorkflowTemplateEventFilter[];
  /** One line of card copy, e.g. "When a pull request opens or is marked ready". */
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
  /**
   * Where this template sits in the gallery. Lower comes first.
   *
   * Order is a property of the template, not of the host: the plugin that
   * knows a template is the one to reach for declares it here, and the host
   * sorts by it. Without this field the gallery order was an accident of
   * plugin registration order and array position, which no author could
   * read and no author could change without editing the host.
   *
   * A template with no rank sorts AFTER every ranked one, and keeps its
   * source order among the other unranked ones. Adding a rank therefore
   * moves one template and leaves the rest where they were. Two templates
   * that claim one rank keep their source order as well, so a repeated
   * number is untidy rather than wrong.
   */
  rank?: number;
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
  /**
   * Event subscriptions to arm with the workflow, in the same transaction.
   *
   * A template that declares neither `schedule` nor `events` installs as a
   * workflow somebody starts by hand. A template that declares `events` and
   * has them armed is the difference between an installed workflow and an
   * installed workflow that actually runs.
   */
  events?: WorkflowTemplateEventTrigger[];
}
