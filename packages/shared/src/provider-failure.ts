/**
 * One reading of a model provider's failure text. The engine uses it to
 * decide whether a failed turn retries. Clients use it to word a failed turn
 * in place of the provider's raw text.
 */
export type ProviderFailureKind =
  | 'usage_limit'
  | 'auth'
  | 'rejected'
  | 'overloaded'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'unknown';

/**
 * A failure no retry can fix: credentials, the request itself, a policy, or
 * the application budget. Provider capacity text cannot override it, even
 * when the same text also mentions 429.
 */
const NOT_RETRYABLE = /authentication|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?key|request|input|argument)|permission[_ -]denied|\b(?:40[013]|422)\b|content[_ -]?(?:policy|filter)|policy[_ -]?(?:violation|denied)|\bbudget\b|context[_ -]?(?:length|window)|aborted|cancelled/i;

/** An account's usage, quota or spend limit. It resets after hours, so it never retries. */
const USAGE_LIMIT = /\bquota\b|insufficient_quota|payment_required|\b402\b|billing[_ -](?:error|limit|hard_limit)|credit balance.*(?:low|insufficient|exhausted)|(?:insufficient|exhausted)[_ -]credits|(?:monthly|spend(?:ing)?)[_ -]limit|quota[_ -](?:exceeded|exhausted)|usage[_ -]limit/i;

const AUTH = /authentication|unauthorized|invalid[_ -]?api[_ -]?key|permission[_ -]denied|\b401\b/i;
const OVERLOADED = /overloaded|high demand|at capacity|\b529\b/i;
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
const SERVER_ERROR = /\b50[0-4]\b|server.?error|internal.?error|service.?unavailable|error occurred while processing your request/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network.?error|socket hang up|timed? ?out/i;

/** True when no retry can fix the failure. See `NOT_RETRYABLE`. */
export function isNonRetryableProviderFailure(text: string): boolean {
  return NOT_RETRYABLE.test(text);
}

/** True when the account hit a usage, quota or spend limit. */
export function isUsageLimitFailure(text: string): boolean {
  return USAGE_LIMIT.test(text);
}

export function classifyProviderFailure(text: string): ProviderFailureKind {
  if (isUsageLimitFailure(text)) return 'usage_limit';
  if (AUTH.test(text)) return 'auth';
  if (isNonRetryableProviderFailure(text)) return 'rejected';
  if (OVERLOADED.test(text)) return 'overloaded';
  if (RATE_LIMITED.test(text)) return 'rate_limited';
  if (SERVER_ERROR.test(text)) return 'server_error';
  if (NETWORK.test(text)) return 'network';
  return 'unknown';
}

/** "openai" → "OpenAI". Unknown ids get a capital first letter. */
export function providerLabel(provider: string | undefined): string {
  if (!provider) return 'The model provider';
  const known: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', bedrock: 'Amazon Bedrock', openrouter: 'OpenRouter', xai: 'xAI' };
  return known[provider.toLowerCase()] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * One sentence that says what failed and what to do next, for a turn whose
 * retries ran out. The provider's own text stays available as detail.
 */
export function providerFailureSummary(kind: ProviderFailureKind, provider?: string): string {
  const name = providerLabel(provider);
  switch (kind) {
    case 'usage_limit':
      return `${name} usage limit is reached. Choose another model, or try again after the limit resets.`;
    case 'auth':
      return `${name} did not accept Valet's key. Ask an admin to check the ${name} key in Settings.`;
    case 'rejected':
      return `${name} rejected this request. Open the details to see why.`;
    case 'overloaded':
      return `${name} is overloaded and did not recover after several tries. Try again, or choose another model.`;
    case 'rate_limited':
      return `${name} is limiting requests and did not recover after several tries. Try again in a minute, or choose another model.`;
    case 'server_error':
      return `${name} had a server error and did not recover after several tries. Try again, or choose another model.`;
    case 'network':
      return `Valet could not reach ${name} after several tries. Try again, or choose another model.`;
    case 'unknown':
      return 'The model call failed. Try again, or choose another model.';
  }
}
