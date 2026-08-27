/**
 * Panel for minting a proxy key and showing copy-paste setup snippets for
 * Claude Code and Codex. The key is shown ONCE after creation (better-auth
 * does not return it again on list). Uses `useCreateApiKey` from
 * `~/api/api-keys` — no new backend endpoint needed.
 *
 * Numbered steps:
 *   1. Gateway status
 *   2. Create your key
 *   3. Configure your tool
 *   4. Run it
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useCreateApiKey, type CreatedApiKey } from "~/api/api-keys";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-auto shrink-0 text-xs text-muted hover:text-ink border border-line rounded px-2 py-0.5"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="whitespace-pre text-xs font-mono bg-paper-muted border border-line rounded p-3 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

interface StepHeadingProps {
  n: number;
  title: string;
}

function StepHeading({ n, title }: StepHeadingProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-moss/15 text-moss text-xs font-semibold shrink-0">
        {n}
      </span>
      <h3 className="text-sm font-medium text-ink">Step {n} — {title}</h3>
    </div>
  );
}

interface GatewayStatusProps {
  enabled: boolean | undefined;
  isLoading: boolean;
}

function GatewayStatus({ enabled, isLoading }: GatewayStatusProps) {
  if (isLoading) {
    return (
      <p className="text-xs text-muted">Checking gateway status…</p>
    );
  }
  if (enabled === true) {
    return (
      <p className="text-xs text-green-600 font-medium">Gateway is on ✓</p>
    );
  }
  if (enabled === false) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        An admin must enable the recording gateway before requests are accepted.{" "}
        <Link
          to="/settings/organization/proxy"
          className="underline underline-offset-2 hover:text-amber-900"
        >
          Enable in Settings → Proxy
        </Link>
      </div>
    );
  }
  return null;
}

interface ModeSnippetsProps {
  apiKey: CreatedApiKey;
  mode: "centralized" | "passthrough";
}

function ModeSnippets({ apiKey, mode }: ModeSnippetsProps) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const key = apiKey.key ?? "";

  // Claude Code snippets differ by mode.
  const claudeCodeSnippet =
    mode === "centralized"
      ? [
          `export ANTHROPIC_BASE_URL=${origin}/proxy/anthropic`,
          `export ANTHROPIC_AUTH_TOKEN=${key}`,
          `# If ANTHROPIC_API_KEY is set, unset it — in centralized mode Valet uses its own key.`,
          `# unset ANTHROPIC_API_KEY`,
        ].join("\n")
      : [
          `export ANTHROPIC_BASE_URL=${origin}/proxy/anthropic`,
          `export ANTHROPIC_AUTH_TOKEN=${key}`,
          `export ANTHROPIC_API_KEY=<your-own-anthropic-key>`,
          `# Pass-through mode: your own key is forwarded and billed; the Valet key only identifies you.`,
        ].join("\n");

  // Codex snippets differ by mode.
  const codexTomlSnippet =
    mode === "centralized"
      ? [
          `# ~/.codex/config.toml`,
          `model_provider = "valet"`,
          ``,
          `[model_providers.valet]`,
          `name = "valet"`,
          `base_url = "${origin}/proxy/openai/v1"`,
          `env_key = "VALET_KEY"`,
          `wire_api = "responses"`,
        ].join("\n")
      : [
          `# ~/.codex/config.toml`,
          `model_provider = "valet"`,
          ``,
          `[model_providers.valet]`,
          `name = "valet"`,
          `base_url = "${origin}/proxy/openai/v1"`,
          `env_key = "OPENAI_API_KEY"`,
          `wire_api = "responses"`,
          `http_headers = { "x-api-key" = "${key}" }`,
        ].join("\n");

  const codexEnvSnippet =
    mode === "centralized"
      ? `export VALET_KEY=${key}`
      : [
          `export OPENAI_API_KEY=<your-own-openai-key>`,
          `# Your Valet identity goes in http_headers above (already in the config).`,
        ].join("\n");

  const baseUrlNote = `This is your Valet instance's origin — ${origin}.`;

  return (
    <div>
      {/* Claude Code */}
      <h4 className="text-sm font-medium text-ink mb-1">Claude Code</h4>
      <p className="text-xs text-muted mb-2">{baseUrlNote}</p>
      <CodeBlock label="Shell env" code={claudeCodeSnippet} />

      {/* Codex */}
      <h4 className="text-sm font-medium text-ink mb-1 mt-4">Codex</h4>
      <p className="text-xs text-muted mb-2">{baseUrlNote}</p>
      <CodeBlock label="~/.codex/config.toml" code={codexTomlSnippet} />
      <CodeBlock label="Shell env" code={codexEnvSnippet} />
    </div>
  );
}

interface KeyDisplayProps {
  apiKey: CreatedApiKey;
  settingsQuery: OnboardingPanelProps["settingsQuery"];
  onCreateAnother: () => void;
}

function KeyDisplay({ apiKey, settingsQuery, onCreateAnother }: KeyDisplayProps) {
  const key = apiKey.key ?? "";
  const mode = settingsQuery.data?.mode;

  return (
    <div className="space-y-6">
      {/* Step 1 — Gateway status */}
      <div>
        <StepHeading n={1} title="Gateway status" />
        <GatewayStatus
          enabled={settingsQuery.data?.enabled}
          isLoading={settingsQuery.isLoading}
        />
      </div>

      {/* Step 2 — Key created (shown after creation) */}
      <div>
        <StepHeading n={2} title="Your proxy key" />
        <p className="text-sm text-ink mb-2">Your proxy key is shown once. Store it now.</p>
        <div className="mb-2 flex items-center gap-2">
          <code className="text-sm font-mono bg-paper-muted border border-line rounded px-2 py-1 text-ink select-all">
            {key}
          </code>
          <CopyButton text={key} />
        </div>
        <p className="text-xs text-muted">
          You can revoke keys anytime in{" "}
          <Link to="/settings/api-keys" className="text-moss underline-offset-2 hover:underline">
            Settings → API keys
          </Link>
          .
        </p>
      </div>

      {/* Step 3 — Configure your tool */}
      <div>
        <StepHeading n={3} title="Configure your tool" />
        {settingsQuery.isLoading ? (
          <p className="text-xs text-muted">Loading mode configuration…</p>
        ) : mode !== undefined ? (
          <ModeSnippets apiKey={apiKey} mode={mode} />
        ) : null}
      </div>

      {/* Step 4 — Run it */}
      <div>
        <StepHeading n={4} title="Run it" />
        <p className="text-xs text-muted mb-2">Send a quick request to confirm the proxy is working:</p>
        <div className="space-y-2">
          <CodeBlock label="Claude Code" code={`claude -p "hello"`} />
          <CodeBlock label="Codex" code={`codex exec "hello"`} />
        </div>
      </div>

      <button
        type="button"
        onClick={onCreateAnother}
        className="text-xs text-muted hover:text-ink"
      >
        Create another key
      </button>
    </div>
  );
}

export interface OnboardingPanelProps {
  settingsQuery: {
    data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
    isLoading: boolean;
  };
}

export function OnboardingPanel({ settingsQuery }: OnboardingPanelProps) {
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const createKey = useCreateApiKey();

  if (createdKey) {
    return (
      <div className="rounded border border-line bg-paper p-5">
        <h2 className="text-base font-medium text-ink mb-6">Proxy key created</h2>
        <KeyDisplay
          apiKey={createdKey}
          settingsQuery={settingsQuery}
          onCreateAnother={() => setCreatedKey(null)}
        />
      </div>
    );
  }

  return (
    <div className="rounded border border-line bg-paper p-5">
      <div className="space-y-6">
        {/* Step 1 — Gateway status (shown before key creation too) */}
        <div>
          <StepHeading n={1} title="Gateway status" />
          <GatewayStatus
            enabled={settingsQuery.data?.enabled}
            isLoading={settingsQuery.isLoading}
          />
        </div>

        {/* Step 2 — Create your key */}
        <div>
          <StepHeading n={2} title="Create your key" />
          <p className="text-sm text-muted mb-4">
            Create a key to route your Claude Code or Codex requests through the
            recording proxy. Usage is tracked per key.
          </p>
          {createKey.error && (
            <p className="mb-3 text-sm text-danger-600">{createKey.error.message}</p>
          )}
          <button
            type="button"
            onClick={() =>
              createKey.mutate("proxy-key", {
                onSuccess: (key) => setCreatedKey(key),
              })
            }
            disabled={createKey.isPending}
            className="rounded px-4 py-2 text-sm bg-moss text-white hover:bg-moss/90 disabled:opacity-50"
          >
            {createKey.isPending ? "Creating…" : "Create proxy key"}
          </button>
        </div>
      </div>
    </div>
  );
}
