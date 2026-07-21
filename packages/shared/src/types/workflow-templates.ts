// Workflow template gallery (Zapier-style "Templates").
//
// A template is a pre-built, publishable workflow definition plus the metadata
// the client needs to render a card and (optionally) collect inputs for an
// immediate run. The full definition lives worker-side in the template
// registry; these are the client-facing catalog + install shapes.

/** An input the "Run now" dialog collects; each maps to `trigger.data.<name>`. */
export interface WorkflowTemplateInput {
  name: string;
  label: string;
  type: 'string' | 'number';
  required?: boolean;
  placeholder?: string;
}

/** A single card in the template gallery (Zapier-style). */
export interface WorkflowTemplateSummary {
  id: string;
  /** Plain-language, action-verb-first title, e.g. "Review pull requests and post a comment". */
  name: string;
  description: string;
  category: string;
  /** Short icon key/emoji for the card; null when unset. */
  icon: string | null;
  /**
   * Ordered service ids for the app-logo chain shown at the top of the card
   * (trigger → … → action), e.g. ['github', 'claude', 'github']. The client
   * resolves each to a brand logo.
   */
  apps: string[];
  /** Human-readable trigger → action steps, shown in the setup dialog. */
  steps: string[];
  /** Inputs the "Run now" dialog collects (become trigger.data via a manual run). */
  inputs: WorkflowTemplateInput[];
  /** Whether installing also provisions a webhook trigger for external events. */
  hasWebhook: boolean;
  /**
   * Whether the template's trigger is scoped to a single repository. When true
   * the install request must name owner/repo: the trigger is pinned to that
   * repository and deliveries naming any other one are refused.
   */
  repoScoped: boolean;
  /**
   * Optional hint for a richer "test it now" form than the generic input list.
   * 'github-pr' renders a connected-repo picker + open-PR picker (populating the
   * owner/repo/pullNumber inputs) instead of free-text fields. Absent = generic.
   */
  runForm?: 'github-pr';
}

export interface WorkflowTemplateListResponse {
  templates: WorkflowTemplateSummary[];
}

/** The webhook trigger provisioned at install time (when the template defines one). */
export interface InstalledTemplateTrigger {
  id: string;
  name: string;
  webhookUrl: string;
  /** Server-issued token — returned exactly once, at install time. */
  webhookToken: string;
}

/**
 * Install request body. `owner`/`repo` are required for a repoScoped template —
 * its trigger is pinned to that repository at install time.
 */
export interface InstallTemplateRequest {
  owner?: string;
  repo?: string;
}

export interface InstallTemplateResponse {
  workflowId: string;
  workflowName: string;
  trigger: InstalledTemplateTrigger | null;
}
