# OpenAI capability tools (plugin-openai)

Date: 2026-08-17
Status: approved

## Goal

Give capable OpenAI session models native image generation in the main agent loop.
Other models use four plugin media tools backed by the OpenAI API: `generate_image`,
`edit_image`, `transcribe_audio`, and `text_to_speech`. The tools appear in
`list_tools` only when an OpenAI API key is configured. They are hidden when no
key resolves, the same way an unconnected GitHub hides its tools.

## Decisions

1. **Plugin, not a builtin tool.** The engine's builtin `ToolDef[]` has no
   conditional-availability mechanism, and the plugin catalog already hides a
   service's actions when `requiresCredential: true` and
   `ctx.credentials.get(service)` returns null
   (`packages/engine/src/plugin-catalog.ts`). The feature ships as
   `packages/plugin-openai/` with `service: "openai"` and
   `requiresCredential: true`. Native image handling is the engine-owned exception described below.
2. **Key resolution order:** org OpenAI LLM-provider key (credential store,
   service `llm:{rowId}`) → stored `"openai"` credential for the owner (plain
   store read) → `OPENAI_API_KEY` host env var. Implemented as an `"openai"`
   branch in `EngineHost.buildCredentialResolver`
   (`packages/api/src/engine/host.ts`), the session-level seam that already
   special-cases `github`.
3. **Image output = sandbox file + attachment.** Image actions write the selected image format
   into the sandbox and also return a `ToolAttachment { type: "image" }`, so
   the model gets vision feedback and the web UI can render the image inline.
4. **Fallback transport:** plain `fetch`. Native generation uses the existing OpenAI provider transport and auth.
5. **Risk:** all actions are `riskLevel: "low"` with
   `defaultApprovalMode: "allow"`. They spend API credits but write only inside
   the sandbox.

## Actions

| Action | Endpoint | Model | Input | Output |
| --- | --- | --- | --- | --- |
| `generate_image` | Images generations | selectable, default Sunburst | `prompt`, image options | sandbox image + image attachment + path text |
| `edit_image` | Images edits | selectable, default Sunburst | `image_path`, `prompt`, image options | same as `generate_image` |
| `transcribe_audio` | `POST /v1/audio/transcriptions` | `gpt-4o-transcribe` | `audio_path`, `language?` | transcript text |
| `text_to_speech` | `POST /v1/audio/speech` | `gpt-4o-mini-tts` | `text`, `voice?`, `format?`, `output_path?` | audio file in sandbox + path text |

- `size`: `"1024x1024" | "1536x1024" | "1024x1536" | "auto"` (default `auto`).
- `model`: the image model. Default `gpt-image-2.5-sunburst`; Flare is the faster everyday option.
- Supported image choices include Sunburst, Flare, their dated snapshots, GPT Image 2, its snapshot, 1.5, 1, and 1-mini.
- `quality`: `low`, `medium`, `high`, or `auto` (default). GPT Image 2.5 also supports `xhigh` and `max`.
- `output_format`: `png` (default), `jpeg`, or `webp`.
- `background`: `transparent`, `opaque`, or `auto`. Transparency requires PNG or WebP.
- `output_compression`: integer from 0 to 100, only for JPEG or WebP.
- Default output paths: `generated-images/<unique-id>-<slug>.<ext>`
  and `/workspace/generated-audio/<timestamp>-<slug>.<ext>`.
- Sandbox file IO uses `ctx.sandbox.readBinary` / `writeBinary`.

## Native image workflow (TKAI-577)

The selected session model generates images through the main Responses request, not a second chat-model request inside a plugin.
The user asks in plain language. The engine offers `image_generation` with Sunburst, PNG, and quality auto.
The image tool model remains separate from the selected session chat model.

`supportsNativeImageGeneration` in the engine model registry uses an explicit allowlist:
`gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.5`, `gpt-5.4-mini`, and `gpt-5.4-nano`.
The provider must be `openai` and the API must be `openai-responses`. Unknown models use the plugin fallback.
The [OpenAI guide](https://developers.openai.com/api/docs/guides/image-generation) and official model pages were checked on 2026-10-09.

Pi-ai 1.0.3 drops `image_generation_call` output. Published versions 1.0.4 and 1.1.0 still drop it.
Valet keeps the pin and uses its awaited `onPayload` and `onProviderStreamEvent` hooks in one engine adapter.
The adapter validates every completed image result and writes original bytes into the session sandbox before publishing a receipt.
It converts receipts into execution-only tool results through the existing agent loop and persistence contract.
The receipt tool is not offered to the model. It returns the saved path, provider image ID, and bounded image feedback.

The next request receives the saved path and image through persisted tool-result context. This supports multi-turn native edits.
Native models do not see the duplicate `openai.generate_image` action, including pinned and catalog discovery paths.
`openai.edit_image` remains available deliberately: the existing `read` tool reads text, not binary images.
It covers edits of arbitrary sandbox files that are not already in vision context. Native editing covers images already in context.
Other models retain both plugin actions, with selectable image models and Sunburst defaults.
The plugin has no `responses_model` parameter or Responses code path.

Native generation uses the existing provider's host-side auth. It does not resolve another credential or start another model.
Untrusted external-sender turns do not receive the native hosted tool.

The hosted tool is offered only when `openai.generate_image` would run now without a gate.
Once per turn, before the first request, the thread asks `resolveUngatedAction` for that action: the OpenAI plugin must be registered in the session's plugin catalog, its service must be available, and the policy resolver must answer `allow`.
The policy input carries the hosted tool's fixed parameters (`model`, `output_format`, `quality`), so a parameter-scoped policy on those fields applies. A policy scoped to the prompt text cannot apply, because the prompt is not known before the request. Use a deny or approval policy on the action for that case.
A `deny` or `require_approval` decision, a resolver error, a missing catalog, or a missing plugin withholds the hosted tool for the turn.
The bridge then prepares `generated-images/` in the sandbox before the request. If the sandbox is not ready, the hosted tool is withheld for the turn, so a cold sandbox cannot cost a paid image. The direct fallback prepares its directory the same way.
The plugin action then stays visible, and `invokeAction` applies and audits the same policy when the agent calls it.
The check opens no gate and writes no audit record. Each saved native image writes one `completed` action-invocation record for `openai.generate_image`, with the grant's provenance and the saved path in its params, so hosted spend appears in the same audit as plugin invocations.
Duplicate plugin actions are hidden only while the most recent request offered the hosted tool. A replayed approval after an API restart therefore reaches the plugin action.
Requests preserve existing sampling, timeout, and abort settings. The bridge preserves final results from providers that end without terminal events.
A request-time 400, 403, 404, or 422 error naming image-tool access or availability triggers one request without the hosted tool.
That turn uses plugin generation, including catalog and pinned tools. Authentication, quota, unrelated model errors, and stream errors do not trigger this fallback.
The next turn can try native generation again.

### Saved originals and failed streams

The adapter writes validated original bytes before making the preview. It registers the receipt as soon as the write completes.
Receipt tool calls are placed before any other tool call in the message. Tools run in content order, so a stop or restart during a slow or gated call cannot leave a saved original unrecorded.
If the provider throws before it streams anything, the bridge still ends the stream with an error message, so the agent loop settles.
If the preview fails, the receipt returns the saved path and a warning instead of asking for another paid generation.
The web renderer keeps that path visible without a preview.
If a later stream event fails, completed images still produce receipts with a stream warning.
The warning names the upstream end state: the provider error, `length` for an output-token cutoff, or the incomplete reason such as `content_filter`.
A cut-off message keeps only tool calls whose arguments finished streaming, plus the receipts. A truncated call never runs.
An abort after saving appends the paths to the message text and reports them in its error.
The thread persists an aborted message's text, so the paths survive reload and reach the next request.
Receipt replay still propagates aborts; it does not treat them as preview failures. A request that saved an image cannot use transient-turn retries or provider fallback. Later plain requests retain normal recovery after receipts.
The direct Images fallback follows the same order: it writes the validated original, then makes the preview.
If the preview fails or the turn aborts after the write, the action succeeds with the saved path and a warning, without an attachment.

### Receipts and context pruning

Receipt results are prunable like other tool results. The sandbox file is the durable record.
Context estimates count each tool-result image as one image, not as its base64 text, so one preview cannot force a prune or compaction by itself.
When a receipt's output is elided, replay sends the saved path in its place, so the model can still edit the file with `openai.edit_image`.

### Responses replay

Pi-ai replays reasoning signatures but does not replay their following hosted image items.
The payload hook omits reasoning from native-image turns and converts internal receipt function pairs into ordinary text/vision user context.
The same assistant message's text and real function-call items lose their provider IDs when its reasoning is omitted.
Real function calls retain their call IDs and matching outputs. Unrelated reasoning, item IDs, and assistant phases remain unchanged.
The [Responses input reference](https://developers.openai.com/api/reference/resources/responses/methods/create) accepts hosted image items with base64 results.
This adapter instead uses ID-free replay and bounded previews, so it does not resend large originals. The next request contains no orphaned image-turn reasoning or fabricated receipt function pair.
The [image guide](https://developers.openai.com/api/docs/guides/image-generation) supports edits from image inputs without prior reasoning.
The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) requires complete output when preserving reasoning; this adapter does not preserve image-turn reasoning.
A scripted SSE test includes reasoning and checks the exact next-turn input sequence.

No live OpenAI validation was done. The owner chose to skip it.
Replay and organization-access behavior are mitigated by scripted tests, not live-verified.

## Shared output validation

Both paths decode canonical base64 and validate the actual format, pixel count, animation, and byte size.
Image inputs and original outputs are limited to 20 MB and 16,777,216 pixels. Animated images are not accepted.
Sharp decodes all pixels before saving. Its lazy loader uses the existing `__VALET_SHARP__` native-runtime hook.
If decoding cannot load, the request fails before spending image-generation credits and names the installation repair.

The original encoded bytes remain unchanged in the sandbox file.
Model-facing previews are bounded to 5 MB after base64 encoding, with space reserved for metadata.
Larger images are resized to fit 1024 by 1024 pixels, preserving their format. If a dense image still exceeds the limit at 1024, the preview tries 768 and then 512 pixels before it gives up.
The attachment MIME, file extension, and detected format must agree. No successful receipt precedes its sandbox write.
Native receipts can recover from an interrupted turn by reading the saved file, without regenerating or paying again.

Relative input and output paths stay relative to the sandbox working directory, including on LocalSandbox.
Absolute container paths must resolve inside `/workspace`. Sandbox providers retain their own isolation and filesystem policy.
The fallback response reader bounds bytes before JSON parsing. Error bodies are capped at 64 KB and retain their HTTP status.
All invocations prepare the target directory before the request. Workflow agent sessions with a writable sandbox can generate images.
Sandbox-less workflow tool nodes fail during directory preparation, before payment. Sandbox preparation failures retain their real cause.
Input size is checked before and after the sandbox read. Source-read errors retain the sandbox cause with credential values redacted.
The plugin does not retry paid image requests automatically. Provider errors redact credential values.

Durable transcript images and sandbox files are separate outputs. Sandbox files follow the session's storage lifecycle.
`file_attach` remains available for a durable private download. This change does not create public artifact URLs.

## Error surface

Every error names the corrective action:

- Missing key at execute time: "No OpenAI API key is configured. Add an OpenAI
  provider in Settings or set OPENAI_API_KEY."
- OpenAI API errors: surface status + the API's error message.
- Missing input file: name the path and tell the agent to check it.

## Web renderer

One `openai-media` renderer in
`packages/web/src/components/session/tool-renderers/`, registered before the
fallback. It matches `call_tool` invocations whose `tool_id` starts with
`openai.`, pinned `openai__*` tools, and native `openai_native_image` receipts:

- image actions → inline `<img>` from persisted base64, with the saved path underneath;
- `transcribe_audio` → transcript text;
- `text_to_speech` → saved path line.

The renderer's `Preview` stays outside the collapsible tool card. Completion and reload show the image even under the always-collapsed preference.
The expandable body retains tool details. Other tools keep their collapse behavior.

The image data must survive the four-hop persistence round trip (engine
`updateEntry` → wire `engineToWireParts` → REST `entryToMessage` → frontend
extraction). A test asserts the base64 payload is reachable after reload, per
the CLAUDE.md tool-call persistence rule.

## Testing

- Plugin unit tests with mocked `fetch` and a stub sandbox: success paths
  (file written, attachment returned), API-error surfacing, missing-file
  errors, default-path generation.
- API tests for the resolver branch: org LLM-provider key wins over env; env
  fallback works; stored `"openai"` credential resolves; none → `null` (tools
  hidden in `list_tools`).
- Plugin tests cover model selection, generation and edits, formats, unsupported options, malformed output, limits, write failures, aborts, and real LocalSandbox paths.
- Engine tests exercise capability selection, raw hosted events, null and failed results, write failures, aborts, encoded limits, and fallback discovery.
- Engine tests cover cut-off streams with truncated calls, pruned-receipt replay, policy-gated offering with deny, approval, allow, and missing-catalog cases, parameter-scoped policy input, sandbox prep before the request, receipt ordering, audit records per saved image, and image-aware token estimates.
- An API integration test uses the real pinned OpenAI streaming provider with scripted SSE responses.
  It checks native generation, multi-turn editing, sandbox bytes, agent image feedback, live media, Postgres persistence, REST history, process-cache restore, and session isolation.
- A fallback API test checks direct generation and editing with Sunburst and Flare, sandbox files, and inline persisted results.
- Web tests cover completion, collapsed-card preferences, serialized reload, MIME rejection, and errors.
- `pnpm typecheck` + full `make e2e` scorecard.
