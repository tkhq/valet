/**
 * Where a provider's API key usually goes: the API host and the header.
 * Prompts that save a pasted key as use-only pre-fill these, and the person
 * confirms or changes them. Nothing uses them without that confirmation: a
 * host learned from a guess or a first use could send the key anywhere.
 *
 * Providers whose keys go in a URL, a query string, Basic auth, or a request
 * signature are left out, because a use-only secret goes in one header.
 */
export interface SecretUseDefault {
  host: string;
  /** Lower-case header name. */
  header: string;
  /** Header value with `{secret}` once. */
  format: string;
}

const BEARER = (host: string): SecretUseDefault => ({ host, header: "authorization", format: "Bearer {secret}" });

const DEFAULTS: Readonly<Record<string, SecretUseDefault>> = {
  anthropic: { host: "api.anthropic.com", header: "x-api-key", format: "{secret}" },
  openai: BEARER("api.openai.com"),
  github: BEARER("api.github.com"),
  gitlab: BEARER("gitlab.com"),
  slack: BEARER("slack.com"),
  stripe: BEARER("api.stripe.com"),
  "hugging face": BEARER("huggingface.co"),
  huggingface: BEARER("huggingface.co"),
  hetzner: BEARER("api.hetzner.cloud"),
  digitalocean: BEARER("api.digitalocean.com"),
  linode: BEARER("api.linode.com"),
  vultr: BEARER("api.vultr.com"),
  cloudflare: BEARER("api.cloudflare.com"),
  vercel: BEARER("api.vercel.com"),
  netlify: BEARER("api.netlify.com"),
  render: BEARER("api.render.com"),
  heroku: BEARER("api.heroku.com"),
  linear: { host: "api.linear.app", header: "authorization", format: "{secret}" },
  notion: BEARER("api.notion.com"),
  sentry: BEARER("sentry.io"),
  datadog: { host: "api.datadoghq.com", header: "dd-api-key", format: "{secret}" },
  airtable: BEARER("api.airtable.com"),
  postmark: { host: "api.postmarkapp.com", header: "x-postmark-server-token", format: "{secret}" },
  resend: BEARER("api.resend.com"),
  sendgrid: BEARER("api.sendgrid.com"),
  npm: BEARER("registry.npmjs.org"),
  openrouter: BEARER("openrouter.ai"),
  groq: BEARER("api.groq.com"),
  mistral: BEARER("api.mistral.ai"),
  cohere: BEARER("api.cohere.com"),
  replicate: BEARER("api.replicate.com"),
  xai: BEARER("api.x.ai"),
  grok: BEARER("api.x.ai"),
  tailscale: BEARER("api.tailscale.com"),
  doppler: BEARER("api.doppler.com"),
};

/**
 * The usual host and header for a provider, from a provider word
 * (`hetzner`) or a known-format label (`OpenAI key`, `GitHub token`).
 * `undefined` when the provider is unknown or its keys do not go in a header.
 */
export function secretUseDefaultFor(provider: string | undefined): SecretUseDefault | undefined {
  if (!provider) return undefined;
  const word = provider
    .toLowerCase()
    .replace(/\s+(?:api\s+)?(?:key|token|secret)$/, "")
    .trim();
  return DEFAULTS[word];
}
