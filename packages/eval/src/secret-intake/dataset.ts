/**
 * Labeled messages for secret-intake detection
 * (`docs/specs/2026-11-17-secret-intake-design.md`, Evaluation).
 *
 * Every value is random, made with a seeded generator in a provider's shape.
 * No real key appears here. The same seed always gives the same set.
 */

export interface SecretSpan {
  start: number;
  end: number;
  provider: string;
}

export interface LabeledMessage {
  id: string;
  /** `positive` holds keys, `negative` holds none, `mixed` holds a key and a look-alike. */
  kind: "positive" | "negative" | "mixed";
  /** Provider for positives; look-alike class for negatives. */
  category: string;
  text: string;
  secrets: SecretSpan[];
  /** True when the message answers an open credential request. */
  credentialRequested?: boolean;
}

/** mulberry32: small, fast, and deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;
const HEXCH = "0123456789abcdef";
const B64URL = ALNUM + "-_";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const str = (r: R, alphabet: string, n: number): string => Array.from({ length: n }, () => pick(r, [...alphabet])).join("");
const uuid = (r: R): string => `${str(r, HEXCH, 8)}-${str(r, HEXCH, 4)}-4${str(r, HEXCH, 3)}-a${str(r, HEXCH, 3)}-${str(r, HEXCH, 12)}`;
const b64url = (r: R, n: number): string => str(r, B64URL, n);

interface Provider {
  id: string;
  /** Words a person uses for it in a sentence. */
  name: string;
  env: string;
  make: (r: R) => string;
  /** No prefix or distinctive shape: the hard cases. */
  formatless?: boolean;
}

export const PROVIDERS: readonly Provider[] = [
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY", make: (r) => `sk-ant-api03-${b64url(r, 93)}AA` },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", make: (r) => `sk-proj-${b64url(r, 48)}` },
  { id: "github", name: "GitHub", env: "GITHUB_TOKEN", make: (r) => `ghp_${str(r, ALNUM, 36)}` },
  { id: "github-fine", name: "GitHub", env: "GITHUB_TOKEN", make: (r) => `github_pat_${str(r, ALNUM, 22)}_${str(r, ALNUM, 59)}` },
  { id: "stripe", name: "Stripe", env: "STRIPE_SECRET_KEY", make: (r) => `sk_live_${str(r, ALNUM, 24)}` },
  { id: "aws", name: "AWS", env: "AWS_SECRET_ACCESS_KEY", make: (r) => str(r, ALNUM + "/+", 40), formatless: true },
  { id: "hetzner", name: "Hetzner", env: "HCLOUD_TOKEN", make: (r) => str(r, ALNUM, 64), formatless: true },
  { id: "digitalocean", name: "DigitalOcean", env: "DIGITALOCEAN_TOKEN", make: (r) => `dop_v1_${str(r, HEXCH, 64)}` },
  { id: "cloudflare", name: "Cloudflare", env: "CLOUDFLARE_API_TOKEN", make: (r) => b64url(r, 40), formatless: true },
  { id: "vercel", name: "Vercel", env: "VERCEL_TOKEN", make: (r) => str(r, ALNUM, 24), formatless: true },
  { id: "datadog", name: "Datadog", env: "DD_API_KEY", make: (r) => str(r, HEXCH, 32), formatless: true },
  { id: "heroku", name: "Heroku", env: "HEROKU_API_KEY", make: (r) => uuid(r), formatless: true },
  { id: "linear", name: "Linear", env: "LINEAR_API_KEY", make: (r) => `lin_api_${str(r, ALNUM, 40)}` },
  { id: "notion", name: "Notion", env: "NOTION_TOKEN", make: (r) => `ntn_${str(r, DIGITS, 12)}${str(r, ALNUM, 34)}` },
  { id: "twilio", name: "Twilio", env: "TWILIO_AUTH_TOKEN", make: (r) => str(r, HEXCH, 32), formatless: true },
  { id: "sendgrid", name: "SendGrid", env: "SENDGRID_API_KEY", make: (r) => `SG.${b64url(r, 22)}.${b64url(r, 43)}` },
  { id: "slack-bot", name: "Slack", env: "SLACK_BOT_TOKEN", make: (r) => `xoxb-${str(r, DIGITS, 12)}-${str(r, DIGITS, 13)}-${str(r, ALNUM, 24)}` },
  { id: "telegram", name: "Telegram", env: "TELEGRAM_BOT_TOKEN", make: (r) => `${str(r, DIGITS, 10)}:AA${b64url(r, 33)}` },
  { id: "discord", name: "Discord", env: "DISCORD_TOKEN", make: (r) => `${b64url(r, 24)}.${b64url(r, 6)}.${b64url(r, 38)}` },
  { id: "npm", name: "npm", env: "NPM_TOKEN", make: (r) => `npm_${str(r, ALNUM, 36)}` },
  { id: "pypi", name: "PyPI", env: "PYPI_TOKEN", make: (r) => `pypi-AgEIcHlwaS5vcmc${b64url(r, 60)}` },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", make: (r) => `sk-or-v1-${str(r, HEXCH, 64)}` },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", make: (r) => `gsk_${str(r, ALNUM, 52)}` },
  { id: "xai", name: "xAI", env: "XAI_API_KEY", make: (r) => `xai-${str(r, ALNUM, 80)}` },
  { id: "tailscale", name: "Tailscale", env: "TS_AUTHKEY", make: (r) => `tskey-auth-${str(r, ALNUM, 12)}-${str(r, ALNUM, 32)}` },
  { id: "supabase-jwt", name: "Supabase", env: "SUPABASE_SERVICE_ROLE_KEY", make: (r) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64url(r, 120)}.${b64url(r, 43)}` },
  { id: "pinecone", name: "Pinecone", env: "PINECONE_API_KEY", make: (r) => `pcsk_${str(r, ALNUM, 6)}_${str(r, ALNUM, 64)}` },
  { id: "mailgun", name: "Mailgun", env: "MAILGUN_API_KEY", make: (r) => `${str(r, HEXCH, 32)}-${str(r, HEXCH, 8)}-${str(r, HEXCH, 8)}`, formatless: true },
  { id: "alchemy", name: "Alchemy", env: "ALCHEMY_API_KEY", make: (r) => b64url(r, 32), formatless: true },
  { id: "generic-random", name: "the service", env: "API_KEY", make: (r) => str(r, ALNUM, 40), formatless: true },
];

interface Template {
  id: string;
  render: (p: Provider, key: string) => string;
  credentialRequested?: boolean;
}

/** `{K}` marks where the key goes. */
const POSITIVE_TEMPLATES: readonly Template[] = [
  { id: "sentence", render: (p) => `here's my ${p.name.toLowerCase()} api key {K} can you deploy the server`, },
  { id: "use-this", render: (p) => `use this for ${p.name}: {K}`, },
  { id: "bare", render: () => `{K}`, credentialRequested: true },
  { id: "bare-thanks", render: () => `{K} thanks`, credentialRequested: true },
  { id: "export", render: (p) => `export ${p.env}={K}`, },
  { id: "codeblock", render: (p) => "try with this:\n```\n" + `${p.env}="{K}"` + "\n```", },
  { id: "token-is", render: (p) => `the ${p.name} token is {K}, let me know if it works.`, },
  { id: "no-keyword", render: (p) => `ok go ahead and set up ${p.name} with {K} and ping me when it's done`, },
  { id: "plain-no-context", render: () => `{K} should work now, I regenerated it`, },
];

function place(template: string, key: string, provider: string): { text: string; spans: SecretSpan[] } {
  const start = template.indexOf("{K}");
  const text = template.slice(0, start) + key + template.slice(start + 3);
  return { text, spans: [{ start, end: start + key.length, provider }] };
}

/** Values that look random but are not credentials. */
const LOOKALIKES: readonly { id: string; make: (r: R) => string; render: (v: string) => string }[] = [
  { id: "git-sha", make: (r) => str(r, HEXCH, 40), render: (v) => `the regression came in with commit ${v}, can you revert it?` },
  { id: "git-sha-short", make: (r) => str(r, HEXCH, 9), render: (v) => `merged as ${v}` },
  { id: "uuid", make: uuid, render: (v) => `the org id is ${v}` },
  { id: "sha256", make: (r) => str(r, HEXCH, 64), render: (v) => `checksum sha256:${v} matches` },
  { id: "tx-hash", make: (r) => `0x${str(r, HEXCH, 64)}`, render: (v) => `the transfer landed in tx ${v}` },
  { id: "eth-address", make: (r) => `0x${str(r, HEXCH, 40)}`, render: (v) => `send it to ${v} on base` },
  { id: "sol-address", make: (r) => str(r, B58, 44), render: (v) => `my solana wallet is ${v}` },
  { id: "btc-address", make: (r) => `bc1q${str(r, LOWER + DIGITS, 38)}`, render: (v) => `btc address ${v}` },
  { id: "p256-pubkey", make: (r) => `02${str(r, HEXCH, 64)}`, render: (v) => `register public key ${v} on the user` },
  { id: "ssh-pubkey", make: (r) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${str(r, ALNUM + "+/", 43)} me@laptop`, render: (v) => `add this deploy key: ${v}` },
  { id: "url-query", make: (r) => `https://example.com/report?id=${str(r, ALNUM, 12)}&page=2`, render: (v) => `see ${v}` },
  { id: "path", make: () => "packages/api/src/services/secret-store/inbound-scrub.ts", render: (v) => `look at ${v}` },
  { id: "slack-ids", make: (r) => `C0${str(r, UPPER + DIGITS, 9)}`, render: (v) => `post it in ${v}` },
  { id: "thread-id", make: (r) => `th-${str(r, LOWER + DIGITS, 8)}-${str(r, LOWER + DIGITS, 8)}`, render: (v) => `continue in ${v}` },
  { id: "base64-blob", make: (r) => `iVBORw0KGgoAAAANSUhEUgAA${str(r, ALNUM + "+/", 60)}`, render: (v) => `the image data starts with ${v}` },
  { id: "docker-digest", make: (r) => `sha256:${str(r, HEXCH, 64)}`, render: (v) => `pin the image to ghcr.io/acme/app@${v}` },
  { id: "npm-integrity", make: (r) => `sha512-${str(r, ALNUM + "+/", 86)}==`, render: (v) => `integrity ${v}` },
  { id: "semver", make: () => "v2.14.0-rc.3+build.20261117", render: (v) => `bump to ${v}` },
  { id: "code", make: () => "const result = await fetchUserProfiles({ includeArchived: true });", render: (v) => "why does this hang?\n```\n" + v + "\n```" },
  { id: "stripe-customer", make: (r) => `cus_${str(r, ALNUM, 14)}`, render: (v) => `refund customer ${v}` },
  { id: "camel-identifier", make: () => "handleSecretRequestAnswerRefusal", render: (v) => `rename ${v}` },
  { id: "secret-ref", make: () => "secret://personal/HCLOUD_TOKEN", render: (v) => `use ${v} for the deploy` },
  { id: "key-talk", make: () => "rotate", render: () => "can you rotate the api key and tell me when the new token is live?" },
];

const PASSWORDS: readonly ((r: R) => string)[] = [
  (r) => `${pick(r, ["Tr0ub4dor", "Sunset", "Blue"])}&${str(r, DIGITS, 2)}${pick(r, ["!", "#", "$"])}`,
  (r) => `${str(r, LOWER, 5)}${str(r, DIGITS, 4)}${str(r, UPPER, 2)}`,
];

/** Builds the labeled set. */
export function buildDataset(seed = 20261117): LabeledMessage[] {
  const r = rng(seed);
  const out: LabeledMessage[] = [];

  for (const p of PROVIDERS) {
    for (const t of POSITIVE_TEMPLATES) {
      const key = p.make(r);
      const { text, spans } = place(t.render(p, key), key, p.id);
      out.push({
        id: `pos:${p.id}:${t.id}`,
        kind: "positive",
        category: p.formatless ? `formatless:${p.id}` : `prefixed:${p.id}`,
        text,
        secrets: spans,
        ...(t.credentialRequested ? { credentialRequested: true } : {}),
      });
    }
  }

  PASSWORDS.forEach((make, i) => {
    for (const lead of ["my password is", "pw:", "the db password is"]) {
      const pw = make(r);
      const tpl = `${lead} {K}`;
      const { text, spans } = place(tpl, pw, "password");
      out.push({ id: `pos:password:${i}:${lead}`, kind: "positive", category: "password", text, secrets: spans });
    }
  });

  for (const scheme of ["postgres", "mysql", "redis"]) {
    const pass = str(r, ALNUM, 20);
    const before = `connect with ${scheme}://app:`;
    const text = `${before}${pass}@db.internal.example.com:5432/app`;
    out.push({
      id: `pos:dburl:${scheme}`,
      kind: "positive",
      category: "db-url",
      text,
      secrets: [{ start: before.length, end: before.length + pass.length, provider: "db-url" }],
    });
  }

  for (const l of LOOKALIKES) {
    for (let i = 0; i < 4; i++) {
      out.push({ id: `neg:${l.id}:${i}`, kind: "negative", category: l.id, text: l.render(l.make(r)), secrets: [] });
    }
  }

  const mixedPairs: [string, string][] = [["hetzner", "git-sha"], ["datadog", "sha256"], ["heroku", "uuid"], ["alchemy", "eth-address"], ["generic-random", "tx-hash"]];
  for (const [pid, lid] of mixedPairs) {
    const p = PROVIDERS.find((x) => x.id === pid)!;
    const l = LOOKALIKES.find((x) => x.id === lid)!;
    const key = p.make(r);
    const look = l.make(r);
    const head = `${l.render(look)}. Also, here's the ${p.name} key: `;
    out.push({
      id: `mixed:${pid}:${lid}`,
      kind: "mixed",
      category: `mixed:${pid}`,
      text: `${head}${key}`,
      secrets: [{ start: head.length, end: head.length + key.length, provider: pid }],
    });
  }

  return out;
}

/** Providers, templates, and look-alikes never used while tuning stage 1. */
const HELD_OUT_PROVIDERS: readonly Provider[] = [
  { id: "netlify", name: "Netlify", env: "NETLIFY_AUTH_TOKEN", make: (r) => `nfp_${str(r, ALNUM, 36)}` },
  { id: "fly", name: "Fly", env: "FLY_API_TOKEN", make: (r) => `fo1_${b64url(r, 43)}` },
  { id: "sentry", name: "Sentry", env: "SENTRY_AUTH_TOKEN", make: (r) => `sntrys_${b64url(r, 120)}` },
  { id: "doppler", name: "Doppler", env: "DOPPLER_TOKEN", make: (r) => `dp.st.prd.${str(r, ALNUM, 43)}` },
  { id: "shopify", name: "Shopify", env: "SHOPIFY_ACCESS_TOKEN", make: (r) => `shpat_${str(r, HEXCH, 32)}` },
  { id: "replicate", name: "Replicate", env: "REPLICATE_API_TOKEN", make: (r) => `r8_${str(r, ALNUM, 37)}` },
  { id: "algolia", name: "Algolia", env: "ALGOLIA_ADMIN_KEY", make: (r) => str(r, HEXCH, 32), formatless: true },
  { id: "mistral", name: "Mistral", env: "MISTRAL_API_KEY", make: (r) => str(r, ALNUM, 32), formatless: true },
  { id: "cohere", name: "Cohere", env: "COHERE_API_KEY", make: (r) => str(r, ALNUM, 40), formatless: true },
  { id: "railway", name: "Railway", env: "RAILWAY_TOKEN", make: (r) => uuid(r), formatless: true },
  { id: "neon", name: "Neon", env: "NEON_API_KEY", make: (r) => `napi_${str(r, LOWER + DIGITS, 64)}` },
  { id: "resend", name: "Resend", env: "RESEND_API_KEY", make: (r) => `re_${str(r, ALNUM, 8)}_${str(r, ALNUM, 24)}` },
  { id: "vultr", name: "Vultr", env: "VULTR_API_KEY", make: (r) => str(r, UPPER + DIGITS, 36), formatless: true },
  { id: "linode", name: "Linode", env: "LINODE_TOKEN", make: (r) => str(r, HEXCH, 64), formatless: true },
];

const HELD_OUT_TEMPLATES: readonly Template[] = [
  { id: "creds-colon", render: () => `creds: {K}` },
  { id: "json", render: () => `config is {"apiKey": "{K}", "region": "us-east-1"}` },
  { id: "bold", render: (p) => `${p.name} key → **{K}**` },
  { id: "trailing-period", render: (p) => `Sure, the ${p.name} one is {K}.` },
  { id: "after-arrow", render: () => `{K} <- that's the new one` },
  { id: "spanish", render: (p) => `mi clave de ${p.name} es {K}` },
  { id: "multiline", render: (p) => `deploy to ${p.name}\nregion fsn1\n{K}\nsize cx22` },
  { id: "bare-unrequested", render: () => `{K}` },
];

const HELD_OUT_LOOKALIKES: readonly { id: string; make: (r: R) => string; render: (v: string) => string }[] = [
  { id: "mongo-objectid", make: (r) => str(r, HEXCH, 24), render: (v) => `the document ${v} is missing` },
  { id: "ulid", make: (r) => `01J${str(r, "0123456789ABCDEFGHJKMNPQRSTVWXYZ", 23)}`, render: (v) => `event ${v} failed` },
  { id: "ipfs-cid", make: (r) => `bafybei${str(r, "abcdefghijklmnopqrstuvwxyz234567", 52)}`, render: (v) => `pinned at ipfs://${v}` },
  { id: "k8s-pod", make: (r) => `valet-api-${str(r, LOWER + DIGITS, 10)}-${str(r, LOWER + DIGITS, 5)}`, render: (v) => `pod ${v} is crash looping` },
  { id: "turnkey-activity", make: uuid, render: (v) => `activity ${v} is pending approval` },
  { id: "email", make: (r) => `${str(r, LOWER, 8)}@example.com`, render: (v) => `invite ${v}` },
  { id: "branch", make: () => "feature/secret-intake-stage-one", render: (v) => `push to ${v}` },
  { id: "hex-color", make: (r) => `#${str(r, HEXCH, 6)}`, render: (v) => `make the button ${v}` },
  { id: "base64-text", make: () => "SGVsbG8sIHRoaXMgaXMganVzdCBhIG5vcm1hbCBzZW50ZW5jZQ==", render: (v) => `what does ${v} decode to?` },
  { id: "github-run-url", make: (r) => `https://github.com/acme/app/actions/runs/${str(r, DIGITS, 11)}/job/${str(r, DIGITS, 11)}`, render: (v) => `CI failed: ${v}` },
  { id: "sha-in-sentence", make: (r) => str(r, HEXCH, 40), render: (v) => `cherry-pick ${v} onto main` },
  { id: "ens-name", make: () => "vitalik.eth", render: (v) => `resolve ${v}` },
];

/** A set built from held-out providers, templates, and look-alikes. */
export function buildHeldOutDataset(seed = 77): LabeledMessage[] {
  const r = rng(seed);
  const out: LabeledMessage[] = [];
  for (const p of HELD_OUT_PROVIDERS) {
    for (const t of HELD_OUT_TEMPLATES) {
      const key = p.make(r);
      const { text, spans } = place(t.render(p, key), key, p.id);
      out.push({ id: `held:pos:${p.id}:${t.id}`, kind: "positive", category: p.formatless ? `formatless:${p.id}` : `prefixed:${p.id}`, text, secrets: spans });
    }
  }
  for (const l of HELD_OUT_LOOKALIKES) {
    for (let i = 0; i < 4; i++) {
      out.push({ id: `held:neg:${l.id}:${i}`, kind: "negative", category: l.id, text: l.render(l.make(r)), secrets: [] });
    }
  }
  return out;
}
