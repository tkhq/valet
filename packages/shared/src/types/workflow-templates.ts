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
  description?: string;
}

/** A single card in the template gallery. */
export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Short icon key/emoji for the card; null when unset. */
  icon: string | null;
  /** Inputs the "Run now" dialog collects (become trigger.data via a manual run). */
  inputs: WorkflowTemplateInput[];
  /** Whether installing also provisions a webhook trigger for external events. */
  hasWebhook: boolean;
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

export interface InstallTemplateResponse {
  workflowId: string;
  workflowName: string;
  trigger: InstalledTemplateTrigger | null;
}
