# Valet Security — Next Features (dynamic configuration and beyond)

**Date:** 2026-08-28
**Status:** accepted — all phases are MVP (2026-08-28); no phase is deferred.
**Source:** Akshar's pentest harness `tkhq/test-security-reviewer`, plus the Conner/Akshar Slack thread. This plan folds that reference into the shipped Valet Security feature (`docs/specs/2026-08-27-valet-security-design.md`).

## What the reference harness is

`test-security-reviewer` is a repo-local, `.claude/`-driven multi-persona pentest harness. Its shape:

- **`.claude/agents/`** — a persona per phase, each a triad: `<persona>-architect` (plans, selects tools, seeds a falsifiable checklist), `<persona>` (works the checklist, spawns children), `<persona>-verifier` (independently re-runs and gates PASS/CONDITIONAL/FAIL). Personas: `threat-model`, `attack-tree`, `code-review`, `sast`, `dast`, `fuzz`, `exploit-dev`, plus `security-orchestrator`, `pivot-coordinator`, `report-writer`, `report-designer`.
- **`.claude/agents/_protocols/exploration-loop.md`** — the shared state-doc protocol (working dir, ROOT/CHILD modes, `state.yml` schema). This is our protocol, one-to-one.
- **`.claude/threat-model-categories/*.yml`** — structured domain threat libraries (authn, authz, crypto-wallets, key-management, mfa, multi-tenancy, parsers, policy-engines, secrets-handling, state-machines, webhooks). Each has `detect_when`, `dedup` (ownership boundaries), and `threat_patterns` (CWE, CAPEC, MITRE ATT&CK, skill, likelihood, prereqs, `look_for`). This is the "invariants you already know" library.
- **`.mcp.json` + `docker/`** — the tool layer: Kali (an MCP server of pentest tools), ZAP, Burp, Playwright, a vulnerability canary. Live personas (DAST/fuzz/exploit) run against a running target through these.
- **`tools/preflight-registry.py`** — a canonical tool registry + presence probe. Each architect calls it; an absent tool becomes an explicit `NOT ASSESSED` entry naming the consequence, never a silent gap.
- **`security-orchestrator`** — a richer runner: a first pass of model + active personas, a `needs.yml` per persona, a `pivot-coordinator` that auto-resolves what it can (signup, session propagation, scope) and surfaces one consolidated human ask, then delta re-runs only the changed surface. Exploit-dev runs over confirmed crit/high, attack-tree composes chains, `report-writer` renders once at the end.

## Mapping to what we shipped

| Reference concept | Valet Security today | Gap |
|---|---|---|
| `.claude/agents/` persona set | one `code-review` persona | many personas; a persona registry |
| `_protocols/exploration-loop.md` | `protocol/state-doc.md` | equivalent |
| `engagements/<id>/<persona>/state.yml` | the engagement tree | equivalent |
| `security-orchestrator` | the runner + nudge sweep | no pivot/needs loop, no delta re-run within a run |
| architect → worker → **verifier** triad | one `verify` cell | no independent architect/verifier gate |
| `threat-model-categories/*.yml` | methodology playbooks | playbooks are generic; no structured, repo-supplied invariants |
| `.mcp.json` + `docker/` tools | baked gitleaks; static image | no per-repo tool declaration, no MCP tools, no live-target tools |
| `preflight-registry.py` + NOT_ASSESSED | scanners run best-effort | no coverage-honesty ledger |
| `report-writer` / `report-designer` | the manifest | no multi-audience report |
| re-scan diff + carried reasoning | **shipped** (ahead of the reference) | — |
| metering | **shipped** (cost visibility) | — |

We are ahead on iteration (re-scan, carried reasoning, cost). We are behind on configurability, persona breadth, verification rigor, and live testing.

## The feature set, phased

### Phase 1 — Dynamic configuration (the ask: "at the very least, the dynamic configuration component")

The point Akshar made: Claude Security won't let you say what to focus on or give it invariants you already know. This phase closes that.

1. **Repo config file — `.valet/security.yml`.** A file the scanned repo commits that configures the review: the ordered steps (persona + goal + paths + playbook), the invariants to load, the focus, and (Phase 4) the tools to provision. When present, the hub offers "Use the repo's `.valet/security.yml`" instead of a bundled preset. The runner reads it at `sec_start` (it clones the repo, so the file is right there) and seeds the plan from it. This makes a review self-describing and versioned with the code it reviews. A repo without one falls back to the bundled presets.
2. **Custom step editor (UI) + a persona registry.** The plan already stores arbitrary cells; the constraint is the single `code-review` persona and no UI to edit steps. Add: (a) an extensible persona registry (bundled personas, plus repo/org-defined ones from the config file), (b) a step editor in the hub/panel — add, remove, reorder, and edit a step (persona, goal, paths, playbook, `review` flag) during planning, saved through the existing `/security/plan` route. This is "add/modify static steps" without chatting.
3. **Invariants and focus as first-class config.** Beyond the free-text focus prompt: a structured `invariants` block (things the team already knows — "tenant id is always checked in the repository layer", "all admin routes sit behind `requireAdmin`") that is injected into every persona's dispatch prompt, and an optional set of loaded threat categories (Phase 2's library) named in the config. Known invariants both focus the review and let a persona flag a violation of a stated invariant as high-signal.
4. **Comment on a finding, carried into re-scan.** When triaging, let a human attach a comment to a finding ("this is intended — the check is in middleware X", or "confirm this is fixed next scan"). On re-scan, those comments ride into the `/prior/findings.md` context, so the personas see the human's prior reasoning, not just the status. This extends the shipped carry-forward and directly answers "interject/comment on findings when re-scanning so it ends up in context."

Phase 1 is the highest value and the lowest infrastructure risk — it is all config, plan, and prompt plumbing on primitives we already have.

### Phase 2 — Richer methodology (model personas, no live target)

5. **More model personas.** `threat-model`, `attack-tree`, and a scanner-heavy `sast` persona (distinct from code-review), each with its own playbook. All are source/config-only, so they run in the current sandbox with no new infrastructure. This alone takes the review from "one code sweep" to the model half of a real pentest.
6. **Architect → verifier triad.** Split a persona into an architect step (plan, select tools, seed a falsifiable checklist, declare coverage) and an independent verifier step (re-run, confirm dataflow from source, audit that every candidate was triaged, emit PASS/CONDITIONAL/FAIL). Our single `verify` cell becomes a per-persona gate. This is the reference's core quality mechanism.
7. **Threat-category library + `NOT_ASSESSED` ledger.** Ship the structured threat-category YAMLs (Turnkey-relevant: authz, key-management, multi-tenancy, policy-engines, crypto-wallets, secrets-handling) as loadable invariants, and add a tool-presence preflight so an absent scanner produces an explicit "not assessed, because gitleaks/semgrep is missing" entry rather than a silent hole. Coverage honesty is what makes a report trustworthy.

### Phase 3 — Report generation

8. **Report persona.** A `report-writer` step that renders the confirmed findings into a multi-audience report (executive summary, engineer detail, external/customer framing) plus a machine-readable snapshot, beyond the current manifest. This was a v1 non-goal; Akshar wants it, and it is the deliverable a stakeholder actually reads.

### Phase 4 — Dynamic tools and live testing (the big infrastructure)

9. **Declared tools + provisioning.** The config file declares tools a step needs (a semgrep ruleset, a language scanner, an MCP server, a Kali container). The runner provisions them: bake common ones into the image, install per-repo ones at prep, and wire MCP tools into the persona sessions. The preflight ledger (7) already models presence and consequence.
10. **Live personas (DAST, fuzz, exploit-dev).** These need a running target, network egress, and the pentest toolchain (ZAP/Burp/Playwright/Kali). That is a real infrastructure project: target provisioning, an authorized-scope manifest, an egress policy that only reaches the target, and the `pivot-coordinator` + `needs.yml` loop for credentials and scope. Highest value for a true pentest, highest cost, and the right place to stop for now.

## Recommended first slice

Build **Phase 1** as the next milestone. It is what the thread explicitly asks for ("start with the static stuff", "a way to add/modify static steps", "add a prompt / invariants", "comment on findings when re-scanning"), it is the foundation every later phase configures against, and it needs no new infrastructure. Concretely, in order:

1. `.valet/security.yml` schema + loader (seeds the plan at create/`sec_start`; falls back to presets).
2. Persona registry made extensible + the hub/panel step editor over the existing `/security/plan` route.
3. `invariants`/`focus` injected into dispatch prompts.
4. Finding comments that carry into `/prior/` on re-scan.

Phase 2 (model personas + architect/verifier + threat-category library) is the natural follow-up and the largest single quality jump. Phase 3 (report) is small and independent. Phase 4 (live testing) is a separate infrastructure track to plan on its own.

## Scoping decisions (2026-08-28)

Every phase above ships as MVP; nothing is deferred to a follow-up. The three open questions are ruled:

- **Config format — a single `.valet/security.yml` that can reference `.claude/` personas and categories.** The file is the entry point our UI reads and edits; it may name personas and category files under `.claude/` so Akshar's harness repo drops in unchanged. Valet fetches it from the repo through the GitHub contents API at create time (before the sandbox exists), and falls back to the bundled presets when absent.
- **Persona authorship — both, repo wins.** Bundled personas ship in `plugin-security`; a repo commits its own persona markdown; a persona named in `.valet/security.yml` resolves to the repo file first, then the bundled registry.
- **Architect / worker / verifier — three cells per phase.** The triad reuses the existing dispatch machinery: an architect cell plans and seeds a falsifiable checklist, the worker cell executes it, and an independent verifier cell gates PASS/CONDITIONAL/FAIL. The cell rail already renders many cells.

## Build order

The twelve milestones execute in dependency order, each committed and green before the next: M-F1 persona registry + config loader, M-F2 step editor, M-F3 invariants, M-F4 finding comments, M-P2a threat-category library, M-P2b architect/verifier triad, M-P2c model personas, M-P2d NOT_ASSESSED preflight, M-P3 report, M-P4a tool provisioning, M-P4b live personas, M-P4c pivot-coordinator.
