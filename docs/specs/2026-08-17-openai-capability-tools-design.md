# OpenAI capability tools (plugin-openai)

Date: 2026-08-17
Status: approved

## Goal

Give agent sessions four media tools backed by the OpenAI API: `generate_image`,
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
   `requiresCredential: true`. Zero engine changes.
2. **Key resolution order:** org OpenAI LLM-provider key (credential store,
   service `llm:{rowId}`) → stored `"openai"` credential for the owner (plain
   store read) → `OPENAI_API_KEY` host env var. Implemented as an `"openai"`
   branch in `EngineHost.buildCredentialResolver`
   (`packages/api/src/engine/host.ts`), the session-level seam that already
   special-cases `github`.
3. **Image output = sandbox file + attachment.** Image actions write the selected image format
   into the sandbox and also return a `ToolAttachment { type: "image" }`, so
   the model gets vision feedback and the web UI can render the image inline.
4. **Plain `fetch`, no OpenAI SDK dependency.**
5. **Risk:** all actions are `riskLevel: "low"` with
   `defaultApprovalMode: "allow"`. They spend API credits but write only inside
   the sandbox.

## Actions

| Action | Endpoint | Model | Input | Output |
| --- | --- | --- | --- | --- |
| `generate_image` | Images generations or Responses | selectable, default Sunburst | `prompt`, image options | sandbox image + image attachment + path text |
| `edit_image` | Images edits or Responses | selectable, default Sunburst | `image_path`, `prompt`, image options | same as `generate_image` |
| `transcribe_audio` | `POST /v1/audio/transcriptions` | `gpt-4o-transcribe` | `audio_path`, `language?` | transcript text |
| `text_to_speech` | `POST /v1/audio/speech` | `gpt-4o-mini-tts` | `text`, `voice?`, `format?`, `output_path?` | audio file in sandbox + path text |

- `size`: `"1024x1024" | "1536x1024" | "1024x1536" | "auto"` (default `auto`).
- `model`: the image model. Default `gpt-image-2.5-sunburst`; Flare is the faster everyday option.
- Supported image choices include Sunburst, Flare, their dated snapshots, GPT Image 2, its snapshot, 1.5, 1, and 1-mini.
- `quality`: `low`, `medium`, `high`, or `auto` (default). GPT Image 2.5 also supports `xhigh` and `max`.
- `output_format`: `png` (default), `jpeg`, or `webp`.
- `background`: `transparent`, `opaque`, or `auto`. Transparency requires PNG or WebP.
- `output_compression`: integer from 0 to 100, only for JPEG or WebP.
- Default output paths: `/workspace/generated-images/<unique-id>-<slug>.<ext>`
  and `/workspace/generated-audio/<timestamp>-<slug>.<ext>`.
- Sandbox file IO uses `ctx.sandbox.readBinary` / `writeBinary`.

## Responses image workflow (TKAI-577)

The existing action IDs do not change. Both actions accept optional `responses_model`, separate from the image `model`.
Without this option, they use the direct Images API. With it, the plugin calls `/v1/responses` on the host.

Supported mainline choices are `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.5`, `gpt-5.4-mini`, and `gpt-5.4-nano`.
This is a checked subset, not a claim that every chat model supports the tool.
The [OpenAI guide](https://developers.openai.com/api/docs/guides/image-generation) and model pages were checked on 2026-10-09.

The request sets the top-level model to `responses_model` and the `image_generation` tool model to `model`.
The plugin forces one image call with the generate or edit action. Edit input comes from sandbox bytes, not remote URLs.
Requests use `store: false`. They do not need provider-side conversation history or `previous_response_id`.
The session chat model does not change. The plugin does not inject hosted tools into Pi's main agent transport.

Example person prompt: "Generate a red fox through GPT-6.1 Sol with Flare, then use the saved image in my design."
The agent calls `openai.generate_image` with `responses_model: "gpt-6.1-sol"` and `model: "gpt-image-2.5-flare"`.
It can then call `openai.edit_image` with the saved `image_path` and the same model choices.

Both API paths validate one completed image result and decode canonical base64.
Sharp checks the actual format and decodes pixels before the sandbox write. The original encoded bytes remain unchanged.
The image validator loads Sharp lazily. Compiled binaries use the existing `__VALET_SHARP__` runtime from extracted assets.
The file extension, detected format, and attachment MIME must agree. A result reports success only after the write completes.

Image inputs and outputs are limited to 20 MB and 16,777,216 pixels. Animated images are not accepted.
The response reader bounds bytes before JSON parsing. Input size is checked before and after the sandbox read.
Paths must resolve inside `/workspace`. Sandbox providers retain their own isolation and filesystem policy.
Credentials remain host-only. Requests use the fixed OpenAI origin and propagate the action's abort signal.
The plugin does not retry paid requests automatically. Provider errors redact credential values.

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
`openai.`, and pinned `openai__*` tools:

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
- Plugin tests cover separate Responses/image models, generation and edits, formats, unsupported options, malformed output, limits, write failures, and aborts.
- An API integration test drives an ordinary OpenAI chat model with a scripted provider and mocked image HTTP response.
  It checks real plugin execution, sandbox bytes, agent image feedback, live WebSocket media, Postgres persistence, REST history, and session isolation.
- Web tests cover completion, collapsed-card preferences, serialized reload, MIME rejection, and errors.
- `pnpm typecheck` + full `make e2e` scorecard.
