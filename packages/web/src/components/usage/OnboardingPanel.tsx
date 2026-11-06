/**
 * Coding-tool setup, with browser-approved CLI setup for personal centralized
 * access and manual setup for shared keys and pass-through credentials.
 * Manual key secrets are revealed once and remain local to this mounted flow.
 */
import { useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { errorText } from "~/lib/error-text";
import { useCopyToClipboard } from "~/lib/use-copy";
import { useCreateApiKey, type CreatedApiKey } from "~/api/api-keys";
import { useProxyRequests } from "~/api/proxy-usage";
import { Button, Callout, RadioCard } from "~/components/primitives";

type CodingTool = "claude-code" | "codex" | "opencode" | "cursor" | "other";
const CODING_TOOLS: { id: CodingTool; title: string; description: string }[] = [
  { id: "claude-code", title: "Claude Code", description: "Terminal" },
  { id: "codex", title: "Codex", description: "Terminal" },
  { id: "opencode", title: "OpenCode", description: "Terminal" },
  { id: "cursor", title: "Cursor", description: "Editor settings" },
  { id: "other", title: "Other tools", description: "Compatible APIs" },
];

function CodeBlock({ label, code }: { label: string; code: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="mb-4 min-w-0 max-w-full">
      <div className="flex items-center gap-2 mb-1">
        <span className="min-w-0 break-words text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        <Button size="sm" variant="secondary" className="ml-auto shrink-0" onClick={() => void copy(code)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={`${label} setup snippet`} className="w-full min-w-0 max-w-full whitespace-pre text-xs font-mono bg-paper-muted border border-line rounded p-3 overflow-x-auto">
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
  apiKey: Pick<CreatedApiKey, "key">;
  team?: boolean;
  mode: "centralized" | "passthrough";
  tool: CodingTool;
}

function ModeSnippets({ apiKey, mode, team = false, tool }: ModeSnippetsProps) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const key = apiKey.key ?? "";

  // Every tool reads the proxy key from one variable, VALET_PROXY_KEY, so the
  // key is set once. Pass-through mode adds the provider keys that the
  // gateway forwards upstream.
  const keyEnvSnippet =
    mode === "centralized"
      ? `export VALET_PROXY_KEY=${key}`
      : [
          `export VALET_PROXY_KEY=${key}`,
          `# Pass-through mode: your own key is forwarded and billed; the Valet key only identifies you.`,
          ...(tool === "claude-code" || tool === "opencode" || tool === "other"
            ? [`export ANTHROPIC_API_KEY=<your-own-anthropic-key>`] : []),
          ...(tool === "codex" || tool === "other"
            ? [`export OPENAI_API_KEY=<your-own-openai-key>`] : []),
        ].join("\n");

  // Claude Code sends ANTHROPIC_AUTH_TOKEN as the Bearer header and, when set,
  // ANTHROPIC_API_KEY as x-api-key. The gateway picks the `vlt_` one.
  const claudeCodeSnippet =
    mode === "centralized"
      ? [
          `export ANTHROPIC_BASE_URL=${origin}/proxy/anthropic`,
          `export ANTHROPIC_AUTH_TOKEN="$VALET_PROXY_KEY"`,
          `unset ANTHROPIC_API_KEY`,
        ].join("\n")
      : [
          `export ANTHROPIC_BASE_URL=${origin}/proxy/anthropic`,
          `export ANTHROPIC_AUTH_TOKEN="$VALET_PROXY_KEY"`,
        ].join("\n");

  // Passthrough: Codex sends env_key as the Bearer header (forwarded
  // upstream) and env_http_headers adds the proxy key as x-api-key.
  const codexTomlSnippet =
    mode === "centralized"
      ? [
          `# ~/.codex/config.toml`,
          `model_provider = "valet"`,
          ``,
          `[model_providers.valet]`,
          `name = "valet"`,
          `base_url = "${origin}/proxy/openai/v1"`,
          `env_key = "VALET_PROXY_KEY"`,
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
          `env_http_headers = { "x-api-key" = "VALET_PROXY_KEY" }`,
          `wire_api = "responses"`,
        ].join("\n");

  // OpenCode's Anthropic client appends `/messages` to `baseURL` directly, so
  // the URL ends in `/v1`. The gateway also adds a missing `/v1`
  // (`proxySubpath`), so a copied Claude Code base URL still works.
  // Passthrough: OpenCode sends `apiKey` as x-api-key (forwarded upstream)
  // and the Bearer header carries the proxy key that identifies you.
  const opencodeConfigSnippet = [
    `{`,
    `  "$schema": "https://opencode.ai/config.json",`,
    `  "provider": {`,
    `    "anthropic": {`,
    `      "options": {`,
    `        "baseURL": "${origin}/proxy/anthropic/v1",`,
    ...(mode === "centralized"
      ? [`        "apiKey": "{env:VALET_PROXY_KEY}"`]
      : [
          `        "apiKey": "{env:ANTHROPIC_API_KEY}",`,
          `        "headers": { "Authorization": "Bearer {env:VALET_PROXY_KEY}" }`,
        ]),
    `      }`,
    `    }`,
    `  }`,
    `}`,
  ].join("\n");

  // OpenAI SDK snippet for self-service scripts. Centralized: the proxy key is
  // the api_key (sent as Bearer). Passthrough: your own key is forwarded and
  // bills your account, and the proxy key identifies you via x-api-key.
  const openaiSdkSnippet = [
    `import os`,
    `from openai import OpenAI`,
    ``,
    `client = OpenAI(`,
    `    base_url="${origin}/proxy/openai/v1",`,
    ...(mode === "centralized"
      ? [`    api_key=os.environ["VALET_PROXY_KEY"],`]
      : [
          `    api_key=os.environ["OPENAI_API_KEY"],  # forwarded upstream, bills you`,
          `    default_headers={"x-api-key": os.environ["VALET_PROXY_KEY"]},  # your Valet identity`,
        ]),
    `)`,
    `resp = client.chat.completions.create(`,
    `    model="gpt-4o-mini",`,
    `    messages=[{"role": "user", "content": "hello"}],`,
    `)`,
    `print(resp.choices[0].message.content)`,
  ].join("\n");

  function setupCode(code: string): string {
    if (!team) return code;
    return code
      .replaceAll("your-own-anthropic-key", "approved-anthropic-key")
      .replaceAll("your-own-openai-key", "approved-openai-key")
      .replaceAll("your own key is forwarded and billed; the Valet key only identifies you", "the supplied provider key is billed; the Valet key identifies the team")
      .replaceAll("bills you", "bills the provider account")
      .replaceAll("your Valet", "the team's Valet")
      .replaceAll("Your Valet", "The team's Valet");
  }

  if (tool === "cursor") {
    return <div className="min-w-0 space-y-3">
      {mode === "passthrough" ? <Callout tone="warning">
        Cursor settings cannot supply the two credentials required by pass-through mode.
        Ask an admin to use centralized mode, or select another coding tool.
      </Callout> : <>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Open Cursor Settings → Models.</li>
          <li>Set the OpenAI API key to your Valet proxy key.</li>
          <li>Set the custom OpenAI base URL to the endpoint below.</li>
          <li>Enable an approved OpenAI model and send a message in local Chat or Agent.</li>
        </ol>
        <CodeBlock label="OpenAI base URL" code={`${origin}/proxy/openai/v1`} />
        <p className="text-sm text-muted">Use the secret from Create proxy key, or an existing key's saved secret.</p>
      </>}
      <Callout>Cursor routes supported local Chat and Agent requests only. Tab, Auto, Cloud agents, and Cursor-provided models keep their own routing.</Callout>
      <a href="https://cursor.com/help/models-and-usage/api-keys" target="_blank" rel="noreferrer" className="text-sm text-moss underline">Cursor API key documentation</a>
    </div>;
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      {/* The key, set once for every tool */}
      <h4 className="text-sm font-medium text-ink mb-1">Proxy key</h4>
      <p className="text-xs text-muted mb-2">
        Paste the exports into your terminal. For future sessions, save them in your shell profile and open a new terminal.
      </p>
      <CodeBlock label="Shell env" code={setupCode(keyEnvSnippet)} />

      {tool === "claude-code" && <>
      <h4 className="text-sm font-medium text-ink mb-1 mt-4">Claude Code</h4>
      <p className="text-xs text-muted mb-2">Run these exports in the same terminal, after the proxy key.</p>
      <CodeBlock label="Shell env" code={setupCode(claudeCodeSnippet)} />
      </>}

      {tool === "codex" && <>
      <h4 className="text-sm font-medium text-ink mb-1 mt-4">Codex</h4>
      <p className="text-xs text-muted mb-2">Add this to <code>~/.codex/config.toml</code>.</p>
      <CodeBlock label="~/.codex/config.toml" code={setupCode(codexTomlSnippet)} />
      </>}

      {tool === "opencode" && <>
      <h4 className="text-sm font-medium text-ink mb-1 mt-4">OpenCode</h4>
      <p className="text-xs text-muted mb-2">
        OpenCode 1.x manual config: merge this into <code>opencode.json</code> in your project, or <code>~/.config/opencode/opencode.json</code>.
        Keep <code>/v1</code> at the end of <code>baseURL</code>.
      </p>
      <Callout>For OpenCode 2.x, use automatic setup in a personal workspace with centralized mode. It creates Valet provider aliases and preserves native provider logins.</Callout>
      <CodeBlock label="opencode.json" code={setupCode(opencodeConfigSnippet)} />
      <p className="text-xs text-muted">A saved provider login can override these settings. Disconnect it with <code>opencode auth logout</code> before testing.</p>
      </>}

      {tool === "other" && <>
        <p className="text-sm text-muted">Use a tool that supports a custom API base URL and the credentials below.</p>
        <CodeBlock label="Anthropic base URL" code={`${origin}/proxy/anthropic`} />
        <p className="mb-3 text-xs text-muted">If your tool appends <code>/messages</code> directly, use <code>{origin}/proxy/anthropic/v1</code>.</p>
        <CodeBlock label="OpenAI base URL" code={`${origin}/proxy/openai/v1`} />
        <CodeBlock label="Authentication headers" code={mode === "centralized"
          ? "# Anthropic\nx-api-key: $VALET_PROXY_KEY\n\n# OpenAI\nAuthorization: Bearer $VALET_PROXY_KEY"
          : "# Anthropic\nAuthorization: Bearer $VALET_PROXY_KEY\nx-api-key: $ANTHROPIC_API_KEY\n\n# OpenAI\nAuthorization: Bearer $OPENAI_API_KEY\nx-api-key: $VALET_PROXY_KEY"} />
        <CodeBlock label="OpenAI SDK example (Python)" code={setupCode(openaiSdkSnippet)} />
      </>}
    </div>
  );
}

function RunCommands({ tool, automatic = false }: { tool: CodingTool; automatic?: boolean }) {
  const command = tool === "claude-code" ? 'claude -p "hello"'
    : tool === "codex" ? `codex ${automatic ? "--profile valet " : ""}exec "hello"`
    : tool === "opencode" ? 'opencode run "hello"' : undefined;
  return (
    <>
      <p className="text-sm text-muted mb-2">Send a short message through your selected tool, then check the connection below.</p>
      {command && <CodeBlock label="Test request" code={command} />}
    </>
  );
}

/** Shown in place of a real key before one exists. */
const KEY_PLACEHOLDER = "<your-valet-proxy-key>";

interface SetupGuideProps {
  mode: "centralized" | "passthrough";
  team: boolean;
  tool: CodingTool;
}

/** Steps 3 and 4 before a key exists: collapsed, with a key placeholder. */
function SetupGuide({ mode, team, tool }: SetupGuideProps) {
  return (
    <details key={tool} open={tool === "cursor" || tool === "other"} className="group min-w-0 max-w-full">
      <summary className="cursor-pointer text-sm font-medium text-ink select-none">
        Setup guide for your selected tool
      </summary>
      <div className="mt-4 min-w-0 max-w-full space-y-6">
        <p className="text-xs text-muted">
          Replace <code>{KEY_PLACEHOLDER}</code> with your proxy key. After you create a key, these snippets show it.
        </p>
        <div>
          <StepHeading n={3} title="Configure your tool" />
          <ModeSnippets apiKey={{ key: KEY_PLACEHOLDER }} mode={mode} team={team} tool={tool} />
        </div>
        <div>
          <StepHeading n={4} title="Run it" />
          <RunCommands tool={tool} />
        </div>
      </div>
    </details>
  );
}

interface KeyDisplayProps {
  apiKey: Pick<CreatedApiKey, "key">;
  team?: boolean;
  settingsQuery: OnboardingPanelProps["settingsQuery"];
  onCreateAnother: () => void;
  tool: CodingTool;
}

function KeyDisplay({ apiKey, settingsQuery, onCreateAnother, team = false, tool }: KeyDisplayProps) {
  const key = apiKey.key ?? "";
  const mode = settingsQuery.data?.mode;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="min-w-0 max-w-full space-y-6">
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
          <code tabIndex={0} aria-label="New proxy key" className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm font-mono bg-paper-muted border border-line rounded px-2 py-1 text-ink select-all">
            {key}
          </code>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void copy(key)}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {/* The panel renders under the API keys section of the same page:
            `/settings/api-keys`, or a team's API keys and proxy tab. */}
        <p className="text-xs text-muted">
          You can revoke keys anytime in the API keys section on this {team ? "tab" : "page"}.
        </p>
      </div>

      {/* Step 3 — Configure your tool */}
      <div>
        <StepHeading n={3} title="Configure your tool" />
        {settingsQuery.isLoading ? (
          <p className="text-xs text-muted">Loading mode configuration…</p>
        ) : mode !== undefined ? (
          <ModeSnippets apiKey={apiKey} mode={mode} team={team} tool={tool} />
        ) : null}
      </div>

      {/* Step 4 — Run it */}
      <div>
        <StepHeading n={4} title="Run it" />
        <RunCommands tool={tool} />
      </div>

      <Button variant="ghost" size="sm"
        onClick={onCreateAnother}
      >
        Create another key
      </Button>
    </div>
  );
}

export interface OnboardingPanelProps {
  settingsQuery: {
    data: { enabled: boolean; mode: "centralized" | "passthrough" } | undefined;
    isLoading: boolean;
    error?: Error | null;
  };
  /** When false, the "Step 1 — Gateway status" block is omitted from the
   * pre-creation view (use when the page already shows gateway status above
   * the panel). Defaults to true. */
  showGatewayStatus?: boolean;
  team?: boolean;
  creation?: {
    create: (onCreated: (key: Pick<CreatedApiKey, "key">) => void) => void;
    isPending: boolean;
    error: Error | null;
    canCreate: boolean;
  };
}

export function OnboardingPanel(props: OnboardingPanelProps) {
  if (props.settingsQuery.error) {
    return <p role="alert">Could not load proxy settings. Reload this page to try again.</p>;
  }
  if (!props.settingsQuery.data) return <p role="status">Loading proxy settings…</p>;
  return props.creation
    ? <ProxyOnboardingFlow key={String(props.creation.canCreate)} {...props} creation={props.creation} />
    : <PersonalOnboardingFlow {...props} />;
}

function AutomaticSetup({ tool }: { tool: "claude-code" | "codex" | "opencode" }) {
  const origin = window.location.origin;
  return <div className="min-w-0 space-y-4">
    <div>
      <h3 className="text-sm font-medium text-ink mb-2">Set up with the Valet CLI</h3>
      <p className="text-sm text-muted mb-3">Run these commands in your terminal. Approve access in the browser when prompted.</p>
      <CodeBlock label="Install Valet (macOS or Linux)" code={`curl -fsSL ${origin}/cli/install.sh | sh\nexport PATH="$HOME/.local/bin:$PATH"`} />
      <CodeBlock label="Connect this tool" code={`valet login ${origin}\nvalet proxy setup ${tool}`} />
    </div>
    {tool === "codex" && <Callout>Use Codex CLI 0.164 or later. Launch with <code>codex --profile valet</code> to use the Valet profile.</Callout>}
    {tool === "opencode" && <Callout>
      OpenCode 1.x and 2.x are supported. Version 2 creates Valet Anthropic and Valet OpenAI providers; select one in <code>/models</code> if needed.
      Version 1 requires disconnecting saved Anthropic or OpenAI logins with <code>opencode auth logout</code> before setup.
      Other providers keep their own routing.
    </Callout>}
    <p className="text-xs text-muted">The CLI stores a key for proxy traffic. Revoke it with <code>valet proxy remove {tool}</code> or in API keys.</p>
    <RunCommands tool={tool} automatic />
  </div>;
}

function ConnectionCheck() {
  const [startedAt] = useState(Date.now);
  const [checked, setChecked] = useState(false);
  const requests = useProxyRequests({ from: startedAt, limit: 25 }, {
    enabled: false, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const success = requests.data?.items.find((row) => row.createdAt >= startedAt
    && !row.teamId && row.statusCode >= 200 && row.statusCode < 300 && !row.hasError);
  return <div className="min-w-0 space-y-3 border-t border-line pt-5">
    <h3 className="text-sm font-medium text-ink">Check your connection</h3>
    <p className="text-sm text-muted">After sending a message, check for a successful model request since you opened this setup.</p>
    <Button variant="secondary" disabled={requests.isFetching} onClick={() => {
      setChecked(true);
      void requests.refetch();
    }}>{requests.isFetching ? "Checking…" : "Check connection"}</Button>
    {checked && !requests.isFetching && (requests.isError
      ? <Callout tone="danger" role="alert">Could not check proxy traffic. Select Check connection to try again.</Callout>
      : success
        ? <Callout tone="success" role="status">
          Successful proxy request recorded{success.model ? ` for ${success.model}` : ""}.
          This confirms traffic reached Valet; other requests can use different routing.
        </Callout>
        : <Callout role="status">No successful proxy request recorded yet. Send a message with your configured tool, then select Check connection again.</Callout>)}
  </div>;
}

function PersonalOnboardingFlow(props: OnboardingPanelProps) {
  const createKey = useCreateApiKey();
  return <ProxyOnboardingFlow {...props} creation={{
    create: (onSuccess) => createKey.mutate("proxy-key", { onSuccess }),
    isPending: createKey.isPending, error: createKey.error, canCreate: true,
  }} />;
}

function ProxyOnboardingFlow({ settingsQuery, showGatewayStatus = true, team = false, creation }: OnboardingPanelProps & { creation: NonNullable<OnboardingPanelProps["creation"]> }) {
  const [createdKey, setCreatedKey] = useState<Pick<CreatedApiKey, "key"> | null>(null);
  const [tool, setTool] = useState<CodingTool>("claude-code");
  // Ties the blocked create button to the paragraphs that name who can create
  // the key and what the reader does next. Two panels on one page must not
  // share the id, so it comes from the hook, not a module constant.
  const blockedHelpId = useId();
  // The blocked copy speaks only about a team. A caller that blocks creation
  // in another scope gets no team instructions.
  const blocked = team && !creation.canCreate;

  const manual = createdKey ? (
      <div className="min-w-0 max-w-full overflow-hidden rounded border border-line bg-paper p-5">
        <h2 className="text-base font-medium text-ink mb-6">Proxy key created</h2>
        <KeyDisplay
          apiKey={createdKey}
          team={team}
          settingsQuery={settingsQuery}
          tool={tool}
          onCreateAnother={() => setCreatedKey(null)}
        />
      </div>
    ) : (
    <div className="min-w-0 max-w-full overflow-hidden rounded border border-line bg-paper p-5">
      <div className="min-w-0 max-w-full space-y-6">
        {/* Step 1 — Gateway status (shown before key creation too, unless suppressed) */}
        {showGatewayStatus && (
          <div>
            <StepHeading n={1} title="Gateway status" />
            <GatewayStatus
              enabled={settingsQuery.data?.enabled}
              isLoading={settingsQuery.isLoading}
            />
          </div>
        )}

        {/* Step 2 — Create your key */}
        <div>
          <StepHeading n={2} title="Create your key" />
          <p className="text-sm text-muted mb-4">
            {team
              ? "Create a shared key for your selected coding tool. Requests and spend belong to this team."
              : "Create a key for your selected coding tool. Usage is tracked per key."}
          </p>
          {blocked && (
            <div id={blockedHelpId} className="mb-4 space-y-2 text-sm text-muted">
              <p>Only a team admin or an organization admin can create a shared key for this team. Ask an admin of this team to create the key.</p>
              {/* Team settings pin the team's scope, so the switcher cannot
                  make this tab personal. The personal page can. */}
              <p>
                {settingsQuery.data?.mode === "passthrough" && "This gateway runs in pass-through mode. "}
                To create your own key, open{" "}
                <Link to="/settings/api-keys" className="underline">Personal workspace → API keys and proxy</Link>.
                {settingsQuery.data?.mode === "passthrough"
                  ? " That page makes a personal proxy key, and you must also supply your own provider key with it."
                  : " That page makes a personal proxy key."}
              </p>
              <p>Team key names are in the API keys section on this tab. A stored secret cannot be read again.</p>
            </div>
          )}
          {creation.error && (
            <p role="alert" className="mb-3 text-sm text-danger-600">{errorText(creation.error)}</p>
          )}
          <Button
            onClick={() => {
              if (creation.canCreate && !creation.isPending) creation.create(setCreatedKey);
            }}
            // A blocked member must still reach this control with the
            // keyboard, or the explanation above it is never announced on
            // focus. `disabled` removes a button from the tab order, so the
            // permission refusal is inert, not disabled. The click guard
            // above refuses the click. A pending create keeps the hard
            // `disabled`: that state is short and it must not queue a second
            // create.
            aria-disabled={!creation.canCreate || undefined}
            disabled={creation.isPending}
            aria-describedby={blocked ? blockedHelpId : undefined}
            className="aria-disabled:opacity-50"
          >
            {creation.isPending ? "Creating…" : "Create proxy key"}
          </Button>
        </div>

        {settingsQuery.data && <SetupGuide mode={settingsQuery.data.mode} team={team} tool={tool} />}
      </div>
    </div>
  );

  const automaticTool = tool === "claude-code" || tool === "codex" || tool === "opencode" ? tool : undefined;
  const automatic = !team && settingsQuery.data?.mode === "centralized" && automaticTool !== undefined;
  return <div className="min-w-0 max-w-full space-y-6">
    <div>
      <h2 className="text-base font-medium text-ink mb-2">Connect your coding tool</h2>
      <p className="text-sm text-muted mb-4">Choose the tool you use. Valet records model requests sent through its proxy.</p>
      <div role="radiogroup" aria-label="Coding tool" className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {CODING_TOOLS.map((option) => <RadioCard key={option.id} title={option.title} description={option.description}
          ariaLabel={option.title} selected={tool === option.id} onSelect={() => setTool(option.id)} className="min-w-0" />)}
      </div>
    </div>
    {automatic && settingsQuery.data?.enabled === false && <Callout tone="warning">The gateway is off. Enable it above or ask an organization admin before sending model requests.</Callout>}
    {automatic && automaticTool && <AutomaticSetup tool={automaticTool} />}
    {team && <Callout>Automatic setup creates personal keys only. Use a shared team key below to attribute traffic to this team.</Callout>}
    {!team && settingsQuery.data?.mode === "passthrough" && <Callout>
      Automatic setup requires centralized mode. Use manual setup below with your proxy key and provider key.
    </Callout>}
    {automatic ? <details className="min-w-0">
      <summary className="cursor-pointer text-sm font-medium text-ink">Manual setup with a proxy key</summary>
      <div className="mt-4 min-w-0">{manual}</div>
    </details> : manual}
    {team
      ? <p className="text-sm text-muted">Team connection checks are not available here. Send a test request and check your team's spend in Usage.</p>
      : <ConnectionCheck key={tool} />}
  </div>;
}
