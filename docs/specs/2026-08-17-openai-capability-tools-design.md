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
3. **Image output = sandbox file + attachment.** Image actions write the PNG
   into the sandbox and also return a `ToolAttachment { type: "image" }`, so
   the model gets vision feedback and the web UI can render the image inline.
4. **Plain `fetch`, no OpenAI SDK dependency.**
5. **Risk:** all actions are `riskLevel: "low"` with
   `defaultApprovalMode: "allow"`. They spend API credits but write only inside
   the sandbox.

## Actions

| Action | Endpoint | Model | Input | Output |
| --- | --- | --- | --- | --- |
| `generate_image` | `POST /v1/images/generations` | `gpt-image-1` | `prompt`, `size?`, `quality?`, `output_path?` | PNG in sandbox + image attachment + path text |
| `edit_image` | `POST /v1/images/edits` | `gpt-image-1` | `image_path`, `prompt`, `size?`, `quality?`, `output_path?` | same as `generate_image` |
| `transcribe_audio` | `POST /v1/audio/transcriptions` | `gpt-4o-transcribe` | `audio_path`, `language?` | transcript text |
| `text_to_speech` | `POST /v1/audio/speech` | `gpt-4o-mini-tts` | `text`, `voice?`, `format?`, `output_path?` | audio file in sandbox + path text |

- `size`: `"1024x1024" | "1536x1024" | "1024x1536" | "auto"` (default `auto`).
- `quality`: `"low" | "medium" | "high" | "auto"` (default `auto`).
- Default output paths: `/workspace/generated-images/<timestamp>-<slug>.png`
  and `/workspace/generated-audio/<timestamp>-<slug>.<ext>`.
- Sandbox file IO uses `ctx.sandbox.readBinary` / `writeBinary`.

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
`openai.`:

- image actions → inline `<img>` from base64 data in the persisted result part,
  saved path underneath;
- `transcribe_audio` → transcript text;
- `text_to_speech` → saved path line.

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
- Round-trip test for the image part shape.
- `pnpm typecheck` + full `make e2e` scorecard.
