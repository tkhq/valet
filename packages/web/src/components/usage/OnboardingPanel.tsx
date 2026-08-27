/**
 * Panel for minting a proxy key and showing copy-paste setup snippets for
 * Claude Code and Codex. The key is shown ONCE after creation (better-auth
 * does not return it again on list). Uses `useCreateApiKey` from
 * `~/api/api-keys` — no new backend endpoint needed.
 */
import { useState } from "react";
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

interface KeySnippetsProps {
  apiKey: CreatedApiKey;
}

function KeySnippets({ apiKey }: KeySnippetsProps) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const key = apiKey.key ?? "";

  const claudeCodeSnippet = `export ANTHROPIC_BASE_URL=${origin}/proxy/anthropic
export ANTHROPIC_AUTH_TOKEN=${key}`;

  const codexTomlSnippet = `# ~/.codex/config.toml
model_provider = "valet"

[model_providers.valet]
name = "valet"
base_url = "${origin}/proxy/openai/v1"
env_key = "VALET_KEY"
wire_api = "responses"`;

  const codexEnvSnippet = `export VALET_KEY=${key}`;

  return (
    <div>
      <p className="text-sm text-ink mb-4">
        Your proxy key is shown once. Store it now.
      </p>
      <div className="mb-2 flex items-center gap-2">
        <code className="text-sm font-mono bg-paper-muted border border-line rounded px-2 py-1 text-ink select-all">
          {key}
        </code>
        <CopyButton text={key} />
      </div>

      <div className="mt-6">
        <h4 className="text-sm font-medium text-ink mb-3">Claude Code</h4>
        <CodeBlock label="Shell env" code={claudeCodeSnippet} />
      </div>

      <div className="mt-4">
        <h4 className="text-sm font-medium text-ink mb-3">Codex</h4>
        <CodeBlock label="~/.codex/config.toml" code={codexTomlSnippet} />
        <CodeBlock label="Shell env" code={codexEnvSnippet} />
      </div>
    </div>
  );
}

export function OnboardingPanel() {
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const createKey = useCreateApiKey();

  if (createdKey) {
    return (
      <div className="rounded border border-line bg-paper p-5">
        <h2 className="text-base font-medium text-ink mb-4">Proxy key created</h2>
        <KeySnippets apiKey={createdKey} />
        <button
          type="button"
          onClick={() => setCreatedKey(null)}
          className="mt-4 text-xs text-muted hover:text-ink"
        >
          Create another key
        </button>
      </div>
    );
  }

  return (
    <div className="rounded border border-line bg-paper p-5">
      <h2 className="text-base font-medium text-ink mb-2">Set up your proxy key</h2>
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
  );
}
