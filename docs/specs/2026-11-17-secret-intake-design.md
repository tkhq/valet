# Secret intake: catching keys people paste

Status: proposed (2026-11-17). Extends `2026-09-01-sandbox-secret-broker-design.md` ("Getting a credential without the value entering a thread").

## Intent

People paste keys into chat. Someone deploying a server writes "here's my hetzner key" followed by 64 random characters. Today the composer and the api backstop recognize provider formats only (`@valet/shared` `detectSecrets`), so a key with no known prefix stays in the transcript, reaches the model, and is stored in plain text.

Intake catches such a key before the message is stored or reaches the agent, swaps in a secret reference, and asks the person where the key may be used.

## Prior art

- None of the common coding agents (Claude Code, Codex, Cursor) removes a pasted key from its transcript by default. Their guidance is not to paste keys, and to rotate any that were pasted. A hook that blocks a prompt after the fact is not enough: one reported case shows a blocked prompt staying in model context.
- GitHub secret scanning finds generic passwords with candidate filtering, then an LLM judgment with context, then verification. Giving the model usage signals, rather than whole files, cut false positives by about three quarters.
- Replit offers, when a key is pasted into a file, to store it as a secret instead.
- Slack's native data loss prevention, and apps built on it, can delete or redact a message in Enterprise workspaces.

## Goals

- A pasted key, in any format, is replaced before the message is stored or reaches the model.
- An ordinary message is never silently changed. A wrong guess costs at most one click.
- The person, not the agent, decides what a key is and where it may be used.
- Detection quality is measured on a labeled set before release and after each change.

## Non-goals

- Keys inside files, tool output, or command output. The output redactor covers known values in command output; files are out of scope.
- Deleting the original Slack message (see "Slack").

## Anti-goals

- Scrubbing after the message is stored. A cleanup after the fact leaves copies.
- An agent that decides what counts as a secret. The agent reads untrusted content and has tools.
- Learning a key's allowed host from its first use.

## Design

### Stage 1: candidates (`@valet/shared`)

`findSecretCandidates(text)` returns spans with a score, cheaply and with high recall. It runs in the browser composer and on the api.

- A token is a run of non-space characters, cut at quotes, brackets, backticks and commas, with trailing sentence punctuation removed. `NAME=value` and `name: value` yield the value. A URL yields its password if it has one, and is otherwise skipped.
- Shape: at least 16 characters; at least two character classes; Shannon entropy at least 3.0 bits per character.
- Look-alikes that are not keys unless a credential word is nearby: hex-only strings (commit SHAs, hashes, transaction hashes), UUIDs, and base58 strings that look like crypto addresses. Never candidates: SSH and PEM public keys, `secret://` and `op://` references, file paths whose segments are words.
- Context raises the score: a credential word within 40 characters before the token (key, token, secret, api, password, pat, credential, bearer, auth), or a provider name, or an open credential request in the thread.
- Short passwords (8 to 15 characters) are candidates only right after a password word ("password is …", "pw: …").
- Known provider formats from `detectSecrets` score highest and name the provider.

### Stage 2: confirmation (api only)

For text that does not come through the composer (Slack, API clients, answers to questions, first prompts, artifact comments), the organization's smallest model tier (`xs`, through `resolveModelSpec`) judges stage-1 candidates scored from 0.2 to below 0.5. It is a separate model call with no tools, made before the message is stored, because the agent's own model call cannot judge a key without reading it first. Claude Code (a small model for background side queries) and Codex (a separate reviewer model for approvals) make side calls in the same way. The call uses the deployment's own provider and credentials, so on self-hosted inference no key leaves the deployment. The model sees each candidate with 200 characters of context and returns `{secret, provider}` per candidate. Most messages hold no candidate in that range and make no call. The call times out after 5 seconds.

Candidates in a known format, and candidates scored 0.5 or higher, are caught without the model. The model may add weaker candidates but never veto a strong one: in the eval, a veto lowered recall and prevented no false alarm. Without a verdict, a weak candidate stays as text.

### Composer (web)

Stage 1 only, before sending, at a score of 0.5 or higher (`composer-secret-prompt.tsx`). Built (2026-11-17): the prompt names the provider ("This looks like a Hetzner key"), suggests `PROVIDER_API_KEY`, numbers several candidates ("1 of 2"), and offers "Save as secret" and "It's not a key". The host and header fields below wait for use rules. The target design:

```
This looks like a key. Save it as a secret instead of sending it?
Name      HETZNER_API_KEY
Used with api.hetzner.cloud
Header    Authorization: Bearer
[Save and send]   [It's not a key]
```

The name and host come from words in the message and a provider table, never from the key. Save seals the value in the browser, as the secrets form does, and the message is sent with the reference in its place. "It's not a key" sends the message unchanged. Nothing leaves the browser until the person chooses.

### Server intake (Slack, API clients, typed answers)

Built (2026-11-17): the backstop (`services/secret-store/inbound-scrub.ts`) saves each caught key as a secret, replaces it with its reference before the text is stored or reaches the model, and adds a note, as it already did for known formats.

Planned, with use rules: hold the value in memory for at most 15 minutes, replace the span with `[pending secret NAME]`, and show a card ("Save as a secret? NAME, used with HOST, header HEADER", with Save, Edit, and "It's not a key"). Save imports the value with those rules. "It's not a key" puts the original text back. This waits for the secret store to support a host and header per secret; until then there is no rule for the card to set.

### Agent backstop

If a key gets past intake, the agent can call `secure_pasted_secret(message_id, excerpt)`. It sends the excerpt through the same server path: the span is redacted in the stored message and in the next turn's context, and the same card opens. It depends on the agent noticing, so it is a second net only.

### Slack

Valet cannot delete a person's Slack message without an admin token. The card says the original message is still in Slack and asks the person to delete it. A workspace with Slack's data loss prevention or an admin-scoped app can remove it; that is a later option.

## Evaluation

`packages/eval/src/secret-intake/` generates a labeled set with a fixed seed: no real keys, only random values in each provider's shape.

- Positives: about 30 providers, including formats with no prefix (Hetzner, Datadog, Heroku, Cloudflare), JWTs, database URLs with passwords, and short passwords after a password word. Each is placed in several message templates: a sentence, a bare paste, a code block, an `export` line.
- Negatives: commit SHAs, UUIDs, hashes, transaction hashes, crypto addresses, SSH and P-256 public keys, URLs, file paths, Slack and Linear ids, base64 snippets, version strings, code.
- Mixed messages hold a key and a look-alike together.

Metrics, per detector and per category:

- Message recall: share of messages with a key where every key span is caught.
- Message false-alarm rate: share of messages without a key where anything is flagged.
- Span precision.

Detectors measured: today's backstop (`known` only), today's composer (`known` and `assigned`), stage 1, and stage 1 plus stage 2.

Release targets:

- Composer (stage 1): recall at least 0.98, false alarms at most 5% of messages.
- Server (stages 1 and 2): recall at least 0.97, span precision at least 0.95.

### Results (2026-11-17)

Run with `pnpm --filter @valet/eval secret-intake [--held-out] [--model]`. Stage 2 used `claude-haiku-5-5` through the Valet gateway.

| Detector | Tuning set recall | Tuning set false alarms | Held-out recall | Held-out false alarms |
|---|---|---|---|---|
| Backstop today (`known`) | 22.2% | 0% | 0% | 0% |
| Composer today (`known`, `assigned`) | 38.4% | 0% | 0% | 0% |
| Stage 1, score at least 0.5 | 100% | 0% | 92.0% | 0% |
| Stage 1 at 0.5, model adds candidates below 0.5 (shipped in the backstop) | 100% | 0% | 96.4% | 0% |
| The same, with `claude-haiku-4-5` (the default `xs` tier) | | | 93.8% | 0% |
| Stage 1, model judges every non-known candidate | 99.6% | 0% | 92.0% | 0% |

- The tuning set has 376 messages (284 with keys). The held-out set has 160 messages (112 with keys) with providers, templates and look-alikes that were not used to tune stage 1.
- The first model prompt, which let the model veto any candidate, lowered recall (95.4% tuning, 89.3% held-out): it refused hex and UUID keys that came with a provider name. The model now only adds candidates that stage 1 scored below 0.5. The prompt was revised after the first held-out run, so the held-out set is no longer fully blind.
- The gain from stage 2 depends on the model behind the `xs` tier. `claude-haiku-4-5` refuses some keys that `claude-haiku-5-5` confirms, for example a UUID offered with "use this from now on". An organization can point `xs` at a newer model in its tier settings.
- The model sometimes answers `"provider": "unknown"`. Intake ignores such an answer and names the secret `PASTED_KEY`.
- The remaining misses are keys pasted with no words and no open credential request. Rules and the model cannot tell them apart from a hash without earlier messages in the thread.
- Next: a second held-out set, and key-free negatives sampled from real messages (with consent) to measure false alarms on real traffic.

## Rollout

1. The eval and stage 1. Done.
2. The composer prompt on stage 1. Done.
3. Stage 2 in the backstop. Done.
4. Use rules (host and header per secret), then the hold and card flow and the host fields in the composer.
5. The agent backstop tool.
