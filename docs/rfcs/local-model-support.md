# RFC: Local Model Support

## Status
Draft

## Authors
- Conner Swann

## Summary
Enable Valet PWA users to leverage locally-running LLMs (Ollama, LM Studio, llama.cpp, etc.) for privacy, cost savings, offline capability, and model experimentation. This RFC explores five architectural approaches ranging from simple client-side chat to a full-featured local agent daemon.

## Motivation

Users have expressed strong interest in using Valet with local models for several key reasons:

- **Privacy & Security**: Sensitive code, data, and conversations remain on the user's machine; nothing traverses external APIs
- **Cost**: Eliminate API fees, especially valuable for users with high token volumes or agentic workloads
- **Offline Capability**: Work without internet connectivity; no dependency on cloud service uptime
- **Model Experimentation**: Rapidly iterate and test open-source models (Llama 2, Mistral, etc.) without vendor lock-in
- **Compliance**: Meet regulatory or organizational requirements preventing cloud API usage

Current constraints prevent seamless local model integration:
- Valet's tool ecosystem (file I/O, terminal execution, web search) requires backend orchestration
- Browser security model blocks direct PWA-to-localhost communication without workarounds
- No clear path for users to expose or bridge their local LLM to Valet's cloud backend

## Options Considered

### Option A: Client-Side Direct (Chat Only)

**Approach**: PWA sends requests directly to a localhost endpoint (e.g., `http://localhost:11434` for Ollama) via the Chat API. No backend involvement.

**Architecture**:
```
┌─────────────────────────────────────────────────────┐
│ Browser (PWA)                                       │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Chat Component                                  │ │
│ │  ┌──────────────────────────────────────────┐  │ │
│ │  │ POST /api/chat to localhost:11434        │  │ │
│ │  └──────────────────────────────────────────┘  │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
                      │
                      │ HTTP (CORS issue)
                      ▼
        ┌──────────────────────────┐
        │ localhost:11434 (Ollama) │
        │ ↓                        │
        │ Model inference (local)  │
        └──────────────────────────┘

Valet Backend: ✗ Not involved
```

**Pros**:
- Simplest implementation: minimal code changes to PWA
- No server-side changes needed
- Users can start experimenting immediately
- Works for chat completions and basic multi-turn conversation

**Cons**:
- **CORS blocking**: Browsers block localhost requests from https://app domain by default
  - Workaround exists (localhost flag, special case) but requires browser policy changes or local proxy
- **No tool execution**: Tools like terminal, file I/O, search require backend orchestration
- **No function calling**: Models may not support or reliably use function calling locally
- **Limited feature set**: Chat-only; incompatible with agentic workflows
- **User friction**: Requires CORS workaround; unclear setup flow

---

### Option B: Service Worker Proxy

**Approach**: Extend the existing Service Worker to intercept requests to a special localhost route and route them transparently to the user's local Ollama/LM Studio endpoint. Acts as a transparent proxy layer.

**Architecture**:
```
┌──────────────────────────────────────┐
│ Browser (PWA)                        │
│ ┌────────────────────────────────┐   │
│ │ App Code                       │   │
│ │ POST /api/chat-local           │───────┐
│ └────────────────────────────────┘   │   │
│                                      │   │
│ ┌────────────────────────────────┐   │   │
│ │ Service Worker                 │◀──┘   │
│ │ (intercepts /api/chat-local)   │       │
│ │ → forwards to localhost:11434  │───────┐
│ └────────────────────────────────┘       │
└──────────────────────────────────────────┤
                                           │
                                           ▼
                            ┌──────────────────────────┐
                            │ localhost:11434 (Ollama) │
                            │ ↓                        │
                            │ Model inference (local)  │
                            └──────────────────────────┘
```

**Pros**:
- No CORS issues: requests originate from localhost perspective
- Transparent to app code: same request/response format as cloud API
- Reuses existing Valet chat UI and message handling
- Minimal backend changes

**Cons**:
- Same limitations as Option A (chat-only, no tools, function calling uncertainty)
- Browser security restrictions limit what a SW can do with localhost
- Unclear if SW can reliably proxy streaming responses
- Limited adoption: still doesn't enable the main pain point (tool execution)
- Debugging complexity: adds a proxy layer

---

### Option C: Tunnel-Based (User-Managed Cloudflare Tunnel)

**Approach**: User runs `cloudflared tunnel run` locally to expose their Ollama endpoint to a public URL. Valet backend connects through the tunnel. User provides the tunnel URL in Valet settings.

**Architecture**:
```
┌──────────────────────────┐
│ Browser (PWA)            │
└──────────────────────────┘
         │
         │ standard HTTPS
         ▼
┌──────────────────────────────────────────┐
│ Valet Backend                            │
│ ┌──────────────────────────────────────┐ │
│ │ Model API Route                      │ │
│ │ POST /api/models/local/completions  │ │
│ │ → forward to https://my-tunnel.cf.. │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
         │
         │ HTTPS tunnel
         ▼
┌────────────────────────────────────────────┐
│ Cloudflare Tunnel Network                  │
└────────────────────────────────────────────┘
         │
         │ localhost
         ▼
┌────────────────────────────────────┐
│ User's Machine                     │
│ ┌────────────────────────────────┐ │
│ │ cloudflared (tunnel client)    │ │
│ └─────────────┬──────────────────┘ │
│               ▼                     │
│ ┌────────────────────────────────┐ │
│ │ localhost:11434 (Ollama)       │ │
│ │ ↓                              │ │
│ │ Model inference (local)        │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

**Pros**:
- **Full feature support**: Backend can call tools, perform function calling, manage state
- **No local agent daemon**: Leverages existing Cloudflare infrastructure
- **Secure**: Tunnel is encrypted and authenticated
- **No code changes needed** to Ollama/LM Studio; direct HTTP compatibility
- Works with function calling if model supports it
- Enables full agentic workflows with local models

**Cons**:
- **High setup friction**: Users must understand and configure Cloudflare Tunnel
- **Dependency on external service**: Tunnel latency, Cloudflare availability
- **Recurring networking overhead**: All requests route through Cloudflare
- **Learning curve**: Not intuitive for non-technical users
- **Public exposure risk**: Misconfiguration could expose local LLM to internet
- **Pricing**: Cloudflare Tunnel is free, but adds another service to manage

---

### Option D: Local Agent Daemon (Agent Client Protocol / ACP)

**Approach**: Build a lightweight cross-platform local daemon (ACP—Agent Client Protocol) that bridges the user's local LLM and Valet's backend tools. The daemon:
1. Runs on the user's machine (auto-started or manual)
2. Maintains a WebSocket connection to Valet backend
3. Intercepts LLM-to-tool calls and routes them through Valet's backend
4. Relays responses back to the local model

The sw.js codebase contains a TODO comment about ACP; this option formalizes that idea.

**Architecture**:
```
┌──────────────────────────────────────────┐
│ Browser (PWA)                            │
└──────────────────────────────────────────┘
         │
         │ standard chat/LLM requests
         ▼
┌──────────────────────────────────────────┐
│ Valet Backend                            │
│ ┌──────────────────────────────────────┐ │
│ │ Chat Route (model=local)             │ │
│ │ Look up device ACP connection        │ │
│ │ Route to local agent via WS          │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ Tool Execution Endpoints             │ │
│ │ (file I/O, terminal, web search...)  │ │
│ │ Called by ACP for tool invocation    │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
         ▲                       │
         │ (tool results)        │ (tool requests)
         │                       │
         └───────────────────────┘
                   WS
                    │
         ┌──────────▼──────────────┐
         │ User's Machine          │
         │ ┌───────────────────────┤
         │ │ Local ACP Agent       │
         │ │ (node/rust/go binary) │
         │ └─────┬─────────────────┤
         │       │                 │
         │       ▼                 │
         │ ┌───────────────────────┤
         │ │ localhost:11434       │
         │ │ (Ollama/LM Studio)    │
         │ │ ↓                     │
         │ │ Model inference       │
         │ └───────────────────────┤
         └─────────────────────────┘
```

**Protocol Sketch** (ACP Message Format):
```
┌─────────────────────────────────────────┐
│ ACP Handshake                           │
├─────────────────────────────────────────┤
│ Agent → Backend:                        │
│ {                                       │
│   "type": "register",                   │
│   "device_id": "user-device-uuid",      │
│   "auth_token": "...",                  │
│   "capabilities": {                     │
│     "model_url": "http://localhost:...  │
│     "supported_models": ["llama2", ...] │
│   }                                     │
│ }                                       │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ ACP Chat Request                        │
├─────────────────────────────────────────┤
│ Backend → Agent:                        │
│ {                                       │
│   "type": "chat",                       │
│   "id": "msg-123",                      │
│   "model": "llama2",                    │
│   "messages": [...],                    │
│   "tools": [                            │
│     {"name": "exec_terminal", ...},     │
│     {"name": "read_file", ...}          │
│   ]                                     │
│ }                                       │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ ACP Tool Invocation                     │
├─────────────────────────────────────────┤
│ Agent → Backend:                        │
│ {                                       │
│   "type": "tool_call",                  │
│   "msg_id": "msg-123",                  │
│   "tool": "exec_terminal",              │
│   "args": {"command": "ls -la"}         │
│ }                                       │
├─────────────────────────────────────────┤
│ Backend processes, responds:            │
│ {                                       │
│   "type": "tool_result",                │
│   "msg_id": "msg-123",                  │
│   "tool": "exec_terminal",              │
│   "result": "file1.txt\nfile2.txt..."   │
│ }                                       │
└─────────────────────────────────────────┘
```

**Pros**:
- **Full feature parity**: All Valet tools work with local models (terminal, file I/O, web search, etc.)
- **Best UX long-term**: One-time install, transparent thereafter; no tunnel setup
- **Optimal performance**: Direct localhost communication; no external routing overhead
- **Privacy complete**: LLM runs locally; tool execution stays within trusted network
- **Function calling**: Can reliably support tool/function calling via ACP schema
- **Model flexibility**: Supports any local LLM (Ollama, LM Studio, llama.cpp, etc.)
- **Scalability**: Can extend to multi-device scenarios (home lab, mobile client via tunnel)

**Cons**:
- **Significant engineering effort**: Cross-platform daemon (Windows, macOS, Linux), installer, auto-update, lifecycle management
- **Distribution complexity**: Package and distribute binaries; manage versioning and updates
- **Protocol design**: ACP protocol must be robust, versioned, and tested
- **Debugging difficulty**: User support for daemon lifecycle issues (crashes, network loss, port conflicts)
- **Installation friction initially**: Users must download, install, and run daemon
- **Daemon maintenance**: Responsible for another always-on process; power/battery impact on laptops
- **Security hardening**: Daemon runs with local access to tools; must validate and sandbox ACP calls

---

### Option E: WebRTC P2P

**Approach**: Establish a direct WebRTC data channel between the PWA and the user's local machine. Backend provides signaling to bootstrap the connection. Once established, the PWA talks directly to the local LLM without routing through the backend or a tunnel service.

**Architecture**:
```
┌──────────────────────────────────────────┐
│ Browser (PWA)                            │
│ ┌──────────────────────────────────────┐ │
│ │ App Code                             │ │
│ └────────┬─────────────────────────────┘ │
│          │                              │
│ ┌────────▼──────────────────────────────┐│
│ │ WebRTC Data Channel                   ││
│ └────────┬──────────────────────────────┘│
└─────────┼──────────────────────────────┘
          │ (after signaling)
          │ direct P2P
          ▼
┌──────────────────────────────────┐
│ User's Machine                   │
│ ┌──────────────────────────────┐ │
│ │ WebRTC Peer                  │ │
│ │ (electron app or web worker) │ │
│ └────────┬─────────────────────┘ │
│          │                       │
│          ▼                       │
│ ┌──────────────────────────────┐ │
│ │ localhost:11434 (Ollama)     │ │
│ │ ↓                            │ │
│ │ Model inference (local)      │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘

Signaling (bootstrap):
PWA ←→ Valet Backend ←→ Local WebRTC Peer
(SDP, ICE candidates)
```

**Pros**:
- **Low latency**: Direct P2P connection; no external service latency
- **No tunnel setup**: Signaling is automatic; users see seamless experience
- **Decentralized**: Doesn't depend on Cloudflare or a custom daemon
- **Works for chat**: Supports streaming, function calling if implemented correctly

**Cons**:
- **NAT traversal complexity**: WebRTC's STUN/TURN may not always work; some users behind restrictive NAT will fail
- **Complex implementation**: WebRTC is intricate; signaling, codec negotiation, ICE candidate handling all require careful implementation
- **Electron dependency**: May require electron app on user's machine (not just web), or a separate web worker host
- **Tool execution unclear**: Still requires backend involvement for tools; WebRTC doesn't solve the architecture
- **Debugging nightmare**: P2P connections are notoriously hard to debug and have flaky edge cases
- **Fallback needed**: Tunnel-based fallback required for users where P2P fails
- **Higher risk**: New infrastructure with many failure modes

---

## Data Sync & Credential Architecture

### The Core Insight

**Credentials can't sync — but tool execution can proxy.**

Org credentials (Slack bot token, GitHub App installation, OAuth client secrets) are org property and should never leave the cloud. But we can still give local Valet full tool access by proxying tool calls through the cloud.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        valet local                              │
│                                                                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐    │
│   │ Local LLM   │    │ Synced Data │    │ Local Tools     │    │
│   │ (llama.cpp) │    │             │    │                 │    │
│   │             │    │ • memories  │    │ • filesystem    │    │
│   │             │    │ • personas  │    │ • terminal      │    │
│   │             │    │ • skills*   │    │ • browser       │    │
│   │             │    │ • workflows*│    │ • mem_* ops     │    │
│   │             │    │ • prefs     │    │                 │    │
│   └──────┬──────┘    └─────────────┘    └─────────────────┘    │
│          │                                                      │
│          │  github.*, slack.*, gmail.*, linear.*                │
│          ▼                                                      │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │                  Cloud Tool Proxy                        │  │
│   │  POST /api/v1/tools/execute { tool_id, params }         │  │
│   │  Auth: Bearer <session_token>                            │  │
│   └─────────────────────────────────────────────────────────┘  │
│          │                                                      │
└──────────┼──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Valet Cloud                               │
│                                                                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐    │
│   │ Tool        │    │ Credential  │    │ Sync API        │    │
│   │ Executor    │◄───│ Store       │    │                 │    │
│   │             │    │ (org creds) │    │ GET /sync/pull  │    │
│   │ Runs tools  │    │             │    │ POST /sync/push │    │
│   │ with user's │    │ Never       │    │                 │    │
│   │ permissions │    │ exposed     │    │ Validates       │    │
│   └─────────────┘    └─────────────┘    │ ownership       │    │
│                                          └─────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### What Syncs (and What Doesn't)

| Data | Syncs? | Notes |
|------|--------|-------|
| **Memories** | ✅ Yes | Your OKF files, journals, people |
| **Personas** | ✅ Yes | Your configured agents |
| **User Skills** | ✅ Yes | Skills YOU created |
| **User Workflows** | ✅ Yes | Workflows YOU own |
| **Preferences** | ✅ Yes | Model prefs, UI settings |
| **Org Skills** | ⚠️ Read-only cache | Expires after 24h, re-fetched on sync |
| **Org Workflows** | ⚠️ Read-only cache | Expires after 24h, re-fetched on sync |
| **Credentials** | ❌ Never | Stay in cloud, accessed via proxy |
| **Team Config** | ❌ Never | Org structure stays in cloud |

### Tool Execution Tiers

**Tier 1: Pure Local (always works offline)**
```
filesystem.*  → local fs operations
terminal.*    → local shell
browser.*     → local Chromium
mem_*         → synced local OKF files
```

**Tier 2: Cloud Proxy (default, requires network)**
```
github.*      → cloud proxy → org's GitHub App
slack.*       → cloud proxy → org's Slack App  
gmail.*       → cloud proxy → user's Google token
linear.*      → cloud proxy → user's Linear token
```

**Tier 3: Personal Tokens (opt-in, works offline)**
```bash
valet config set github.token ghp_xxxxx
# Now github.* uses your PAT directly, no cloud needed
```

### The `valet sync` Command

```bash
# Initial login (one-time)
valet login
# Opens browser → Turnkey passkey auth → stores session token

# Sync everything
valet sync
# Pulls: memories, personas, user skills/workflows, prefs
# Caches: org skills/workflows (read-only, 24h TTL)

# Watch mode (continuous)
valet sync --watch
# Bidirectional sync as you work

# Selective
valet sync --only memories
valet sync --only skills,workflows
```

### Local Directory Structure

```
~/.valet/
├── auth.json              # Encrypted session token
├── config.json            # Local preferences + personal tokens
├── models/                # Downloaded GGUF files
│   ├── llama-3.2-3b.Q4_K_M.gguf
│   └── qwen2.5-coder-7b.Q4_K_M.gguf
├── sync/                  # Synced user data
│   ├── memories/          # OKF markdown files
│   ├── personas/          # User's agent configs
│   ├── skills/            # User-created skills
│   ├── workflows/         # User-owned DAGs
│   └── preferences.json   # Model prefs, UI settings
├── cache/                 # Read-only org data (expires)
│   ├── org-skills/        # Org shared skills
│   ├── org-workflows/     # Org shared workflows
│   └── .cache-meta.json   # TTL timestamps
└── queue/                 # Offline tool call queue
    └── pending.json       # Queued calls for when online
```

### Offline Behavior

| Scenario | Behavior |
|----------|----------|
| **Pure local task** | ✅ Works fully offline |
| **Cloud tool call, online** | ✅ Proxied through cloud |
| **Cloud tool call, offline** | ⏳ Queued, executes when online |
| **Cloud tool call, has personal token** | ✅ Works offline |
| **Sync, online** | ✅ Full bidirectional sync |
| **Sync, offline** | ⚠️ Uses cached data, marks stale |

### Security Properties

1. **Credentials never leave cloud** — Org secrets stay server-side
2. **Session token is encrypted** — `~/.valet/auth.json` encrypted with age
3. **Ownership enforced server-side** — Sync API validates you own the data
4. **Personal tokens are opt-in** — User explicitly adds them, stored encrypted
5. **Cached org data is read-only** — Can't modify shared resources locally
6. **Queue is local-only** — Pending tool calls never contain credentials

### Authentication Flow

```bash
valet login
```

1. CLI opens browser to `https://valet.turnkey.io/cli/auth`
2. User authenticates with Turnkey passkey
3. Browser redirects to `http://localhost:PORT/callback?token=xxx`
4. CLI receives session token, encrypts with age, stores in `~/.valet/auth.json`
5. Session token used for all cloud API calls (sync, tool proxy)

### Personal Token Setup (Optional)

For power users who want full offline capability:

```bash
# GitHub (create PAT at github.com/settings/tokens)
valet config set github.token ghp_xxxxxxxxxxxx

# Slack (get from api.slack.com/apps → OAuth tokens)
valet config set slack.user_token xoxp-xxxxxxxxxxxx

# Linear (create at linear.app/settings/api)  
valet config set linear.token lin_api_xxxxxxxxxxxx
```

When personal tokens are configured:
- Tool calls use them directly (no cloud proxy)
- Works fully offline
- User is responsible for token security

### CLI Commands Summary

```bash
# Authentication
valet login                    # Passkey auth, get session token
valet logout                   # Clear local auth + synced data
valet whoami                   # Show current user + sync status

# Sync
valet sync                     # Bidirectional sync
valet sync --pull              # Pull from cloud only
valet sync --push              # Push to cloud only  
valet sync --watch             # Continuous sync
valet sync --only memories     # Selective sync

# Local inference
valet local                    # Start local session
valet local --model llama3.2   # Specify model
valet local --offline          # Refuse cloud proxy (fail if needed)

# Models
valet model pull llama3.2      # Download model
valet model list               # List downloaded models
valet model rm llama3.2        # Remove model

# Config
valet config list              # Show all config
valet config set KEY VALUE     # Set config/personal token
valet config unset KEY         # Remove config

# Queue (offline tool calls)
valet queue list               # Show pending tool calls
valet queue flush              # Execute all pending (when online)
valet queue clear              # Discard pending calls
```

### Why This Design

1. **No credential leakage** — Org admins don't worry about secrets on laptops
2. **Full tool access** — Users get all integrations via proxy
3. **Offline-capable** — Local tools + cached data work without network
4. **Progressive enhancement** — Add personal tokens for full offline
5. **Bidirectional sync** — Changes flow both ways seamlessly
6. **Respects ownership** — User data syncs, org data only caches
7. **Graceful degradation** — Queue tool calls when offline, execute later

---

## Recommendation

**Phased Approach: Start with Option C (Tunnel), Plan for Option D (Local Agent)**

### Phase 1: Tunnel-Based Model Support (MVP)
**Timeline**: 1–2 sprints

Deploy Option C to unblock users immediately:
- Add "model provider" selector in settings: `cloud` vs. `local`
- When `local` is selected, prompt for Cloudflare Tunnel URL
- Store tunnel URL per device
- Backend routes chat/completions requests to the tunnel URL instead of cloud API
- Users can enable tools and get full agentic behavior **today**
- Lower friction than building a daemon; leverages existing infrastructure
- Implement `valet sync` command for data portability: users can sync memories, personas, user-created skills/workflows, and preferences to their local machine
- Support bidirectional sync for offline-capable workflows

**Deliverables**:
- Settings UI for tunnel URL input
- Backend model routing logic
- Sync API endpoints (`GET /sync/pull`, `POST /sync/push`)
- `valet sync` CLI command and continuous sync mode (`--watch`)
- Encryption for local session tokens and personal credentials
- Documentation (setup guide for Cloudflare Tunnel, sync usage)
- Testing with Ollama + Cloudflare Tunnel

**Value**:
- Immediately satisfies user demand for local models
- Enables data portability and offline workflows
- Proof of concept for local model integration
- Learns which tools/workflows users actually run locally
- Establishes foundation for offline tool execution queue
- Can iterate on UX before investing in daemon

---

### Phase 2: Local Agent Daemon (Full Solution)
**Timeline**: 2–3 sprints (depends on scope)

Ship Option D to eliminate setup friction:
- Design and document ACP protocol (versioned, extensible)
- Implement reference daemon in a portable language (Go/Rust)
- Cross-platform binaries (Windows, macOS, Linux)
- Auto-start, lifecycle management, status monitoring
- Installer (MSI for Windows, DMG for macOS, AppImage/snap for Linux)
- Auto-discovery of local models (scans Ollama, LM Studio endpoints)
- PWA UI for daemon status and model selection
- Fallback to tunnel if daemon unavailable
- Refine sync API based on Phase 1 learnings; optimize for offline-first scenarios
- Implement offline tool call queue and replay logic (from Data Sync & Credential Architecture)

**Deliverables**:
- ACP protocol specification
- Open-source daemon implementation
- Distribution infrastructure (GitHub Releases, auto-update logic)
- Enhanced settings UI (daemon discovery, model picker)
- Offline tool call queue (persistent, encrypted storage)
- Queue management CLI commands (`valet queue list/flush/clear`)
- Quality gates (cross-platform testing, daemon lifecycle tests, sync fidelity tests)

**Value**:
- Seamless UX: no tunnel setup needed
- Optimal performance: direct localhost communication
- Full feature parity with cloud models
- True offline capability: queue tool calls for later execution
- Establishes Valet as a leader in local-first AI tooling

---

### Why Not Option A or B?
Options A and B offer only chat-only capabilities and don't solve the core user motivation: using tools locally. They're useful only if we accept a second-class feature set for local models, which defeats the purpose.

### Why Not Option E?
WebRTC is powerful but adds complexity without clear benefits over Option C + Option D. It's a fallback strategy if Cloudflare Tunnel adoption is low, but we should validate demand first.

---

## Open Questions

1. **Model Capability Detection**: How do we detect if a local model supports function calling? Should we test with a sample function or query the model's metadata? Not all open models implement function calling reliably.

2. **Fallback Behavior**: If the local model is unavailable or times out, should we fall back to a cloud API? How do we communicate this to the user? Should it be automatic or explicit?

3. **Security & Trust Model**:
   - Should ACP require authentication (e.g., device pairing)?
   - How do we trust that the local agent is legitimate and not a MITM?
   - Can users restrict tool execution on a per-tool basis?
   - How do we protect personal tokens stored locally? Should we use OS keychain, or encrypted JSON?

4. **Function Calling Schema**: Different local models have different function calling conventions (OpenAI format, Ollama tools, etc.). Should ACP normalize these, or should we support multiple schemas?

5. **Streaming & Backpressure**: How do we handle backpressure if the local model is slow? Should we buffer, or should clients respect server-sent-events (SSE) backpressure natively?

6. **Model Context Window & Token Limits**: Local models have varying context windows. Should we implement smarter context management or leave that to users?

7. **Cost Accounting**: If users run local models, how do we track and surface usage? Should we log token counts or just disable usage analytics?

8. **Sync Conflict Resolution**: When local and cloud versions of a resource (e.g., a persona or skill) diverge, how do we resolve conflicts? Should it be last-write-wins, user prompt, or versioning?

9. **Offline Tool Call Durability**: How long should pending (queued) tool calls persist locally? Should they survive process restarts? Should old queued calls be discarded after a TTL?

10. **Cache Invalidation**: For cached org skills/workflows, how do we know when the cloud version has changed? Should we use ETags, timestamps, or periodic re-fetch?

---

## Appendix

### References & External Docs

- **Ollama API**: https://github.com/ollama/ollama/blob/main/docs/api.md
- **LM Studio**: https://lmstudio.ai/ (local API compatible with OpenAI-like endpoints)
- **llama.cpp Server**: https://github.com/ggerganov/llama.cpp/tree/master/examples/server
- **Cloudflare Tunnel Docs**: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- **WebRTC Data Channels**: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- **Service Worker Limitations**: https://w3c.github.io/ServiceWorker/ (Section 4.5—restrictions on localhost)

### ACP Prior Art & Inspiration

- **OpenAI's "custom GPT" architecture** (where a backend orchestrates tool calls)
- **LangChain's tool-calling patterns** (agent executor model)
- **Continue.dev's approach** to local IDE integration (lightweight protocol-based daemon)
- **Jan.ai's local LLM bridge** (similar problem space)

### Example: Tunnel Setup UX (Phase 1)

```
User Flow:
1. Settings → Model Provider → "Local Model"
2. Instructions panel:
   "To use a local model, expose it via Cloudflare Tunnel:
   
   $ brew install cloudflare/cloudflare/cloudflared
   $ cloudflared tunnel run --url http://localhost:11434
   
   Copy your tunnel URL (e.g., https://my-tunnel.cfargotunnels.com)"
3. Paste URL into "Tunnel Endpoint" field
4. Click "Test Connection" → validates endpoint + model list
5. Select model from dropdown
6. Save → chat now routes to local model

Status indicator: "✓ Connected to local model (llama2:7b)"
```

---

## Conclusion

Local model support is a high-value feature that opens Valet to privacy-conscious, cost-sensitive, and offline-dependent users. We recommend a phased approach: start with the quick-win tunnel-based integration (Phase 1) to validate demand and gather feedback, then invest in the full daemon solution (Phase 2) for a seamless, long-term user experience.

Phase 1 introduces bidirectional data sync (`valet sync`) to enable portable, offline-capable workflows: users can sync their memories, personas, and personal skills/workflows to their machine, then work locally with full access to tools via cloud proxy. This architecture cleanly separates org credentials (which stay in the cloud) from user data (which syncs), ensuring security while maximizing utility.

Phase 2 adds the local agent daemon and offline tool execution queue, enabling users to queue tool calls when offline and execute them once reconnected. This combination positions Valet as a leader in local-first AI tooling and future-proofs against API dependency concerns.
