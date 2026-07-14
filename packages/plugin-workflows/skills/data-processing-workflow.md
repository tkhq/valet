---
name: data-processing-workflow
description: Playbook for authoring data-processing workflows in dag/v1 — query an external system, transform rows per item, write results to a spreadsheet/doc. Covers the action-id gotcha, the foreach typed-array constraint, and the deterministic reshape pattern.
---

# Data-processing workflow playbook

This skill is the shortest path from "I have a data source and I want to process each row and write results somewhere" to a validated, runnable workflow. It codifies the lessons from every friction point we've hit building this shape in `dag/v1`. If you're building a **query → transform → write** workflow, read this first.

## The canonical DAG

```text
trigger → query(tool) → extract(set or llm) → tier_loop(foreach + llm|tool)
                                                 ↓
                                              create_sheet(tool)
                                                 ↓
                                              headers(tool)
                                                 ↓
                                              write_loop(foreach + tool)
```

Six nodes plus the trigger. Every node has one job. The two foreach loops are the load-bearing pieces: one to process each row, one to write each row.

## Node-by-node

### 1. `trigger`

Manual/webhook entry. Declare a `dataSchema` so `test_run` gives you a one-click prefilled form and the workflow is documented at the top.

### 2. `query` — a `tool` node

Pull the source data. Salesforce SOQL, Google Sheets read, GitHub search, Linear list_issues — anything that returns an array of records.

**The action-id gotcha (this bites everyone once):** the `action` field on a tool node is the id **exactly as it appears after the first colon in the tool id from `list_tools`**, not a shortened form. Two conventions coexist:

- Some services prefix action ids with the service name: `salesforce-read-only:salesforce-read-only.soqlQuery` → `action: "salesforce-read-only.soqlQuery"`.
- Others don't: `google_workspace:sheets.write_spreadsheet` → `action: "sheets.write_spreadsheet"`.

**Never guess or strip prefixes.** Run `list_tools service="<name>"`, copy the actionId from the tool id verbatim. `workflows.save_draft(validate=true)` and `workflows.validate` hard-error on unknown ids with a nearest-match suggestion, so a clean save proves the ids resolve.

### 3. `extract` — a `set` node with `outputSchema` (preferred) or `llm` node (fallback)

The source tool returns nested objects (`records[].Account.Name`). Downstream `foreach` and Sheets writes want a flat array. This is where you reshape.

**Preferred: `set` with `outputSchema`.** Deterministic, free, no LLM cost. Available since the DX changelist landed:

```json
{
  "id": "extract",
  "type": "set",
  "values": { "records": "{{nodes.query.data.records}}" },
  "outputSchema": {
    "type": "object",
    "properties": { "records": { "type": "array", "items": { "type": "object" } } },
    "required": ["records"]
  }
}
```

The `outputSchema` tells the validator that `nodes.extract.data.records` is an array, so the downstream `foreach` accepts it. The runtime just emits whatever `values` renders to.

**Fallback: `llm` node** when you need to flatten nested paths (`Account.Name` → `accountName`) at the same time. Use only when actually needed — it's ~1s per call and costs tokens for plumbing.

### 4. `tier_loop` — a `foreach` with an `llm` body

Per-item processing. The LLM sees one record at a time, so it can apply real judgment (catch bad data, semantic classification) instead of mechanical rules. Downside: N LLM calls, ~1s each. For thousands of items, budget accordingly or move deterministic parts into the `extract` step.

```json
{
  "id": "tier_loop",
  "type": "foreach",
  "items": "{{nodes.extract.data.records}}",
  "itemAlias": "item",
  "concurrency": 5,
  "body": {
    "id": "tier_one",
    "type": "llm",
    "model": "anthropic:claude-sonnet-4-5",
    "maxOutputTokens": 500,
    "system": "…",
    "prompt": "Classify: {{item.accountName}} …",
    "outputSchema": { "type": "object", "properties": { "tier": { "type": "string", "enum": [...] }, /* echo fields */ }, "required": [...] }
  }
}
```

**Have the body echo every field it needs downstream.** The foreach output shape is `{{nodes.tier_loop.data.items}}` where each item is `{status, data: <body output>}` — so downstream code references `{{item.data.tier}}`, `{{item.data.accountName}}`, etc. (note the `.data` nesting). This is not obvious until you inspect a trace.

### 5. `create_sheet` — a `tool` node

`google_workspace:sheets.create_spreadsheet` with the tabs you want. The result is `{{nodes.create_sheet.data.spreadsheetId}}`.

### 6. `headers` — a `tool` node

Write header rows to all tabs in one call via `sheets.batch_write`. One approval gate for all three tabs.

### 7. `write_loop` — a `foreach` with a `tool` body

Append each processed row to its tab. The key trick: use a **templated range** so the target tab depends on the item's tier:

```json
{
  "id": "write_loop",
  "type": "foreach",
  "items": "{{nodes.tier_loop.data.items}}",
  "itemAlias": "row",
  "concurrency": 1,
  "body": {
    "id": "append_row",
    "type": "tool",
    "service": "google_workspace",
    "action": "sheets.append_rows",
    "params": {
      "spreadsheetId": "{{nodes.create_sheet.data.spreadsheetId}}",
      "range": "'{{row.data.tier}}'!A1",
      "valueInputOption": "RAW",
      "data": [[
        "{{row.data.accountName}}",
        "{{row.data.website}}",
        "…"
      ]]
    }
  }
}
```

**Note `concurrency: 1`** — Sheets rejects concurrent writes to the same document.

## Rules that trip up first-time authors

### Foreach `items` must be a provably-typed array

The validator rejects `{{...}}` expressions whose type it can't statically verify with `foreach_items_untyped_array_output`. Valid sources:

| Source node | Template | Precondition |
|---|---|---|
| `trigger` | `{{trigger.data.<f>}}` | dataSchema declares `<f>` as `type: "array"` |
| `llm` | `{{nodes.<id>.data.<f>}}` | outputSchema declares `<f>` as `type: "array"` |
| `set` | `{{nodes.<id>.data.<f>}}` | literal array under `values.<f>` OR `outputSchema.<f>: {type:"array"}` |
| `tool` | `{{nodes.<id>.data.<f>}}` | registered `toolOutputSchema` declares `<f>` as array (validation skipped otherwise) |
| `orchestrator` / `session` | `{{nodes.<id>.data.output.<f>}}` | `wait.mode === "until_idle"` AND outputSchema array field |
| `orchestrator` / `session` | `{{nodes.<id>.data.transcript}}` | `resultMode === "transcript"` |
| `foreach` | `{{nodes.<id>.data.items}}` | always (nested-foreach chaining) |

**Session/orchestrator require `.data.output.<field>`** — llm/tool/set go direct at `.data.<field>`.

### Foreach body allows exactly one node

Types: `llm`, `tool`, `set`, `stop`, `orchestrator`, `session`. **No** nested `if`, `wait`, `approval`, `trigger`, or `foreach`. If you need "classify then write" per item, use two sequential foreach nodes (tier_loop → write_loop as above), not one loop with two bodies.

### Approvals

Every `tool` node with `riskLevel: medium` or `high` raises one approval per invocation. In a foreach, the first iteration prompts, then the UI offers **"Approve remaining rows"** to batch-clear the loop. Low-risk tools (reads, queries) don't gate.

**For unattended/scheduled runs, prefer low-risk tools inside foreach bodies.** Otherwise the run stalls indefinitely on the first approval prompt.

## Scaling & cost

- **Per-item LLM tiering** is powerful but ~1s+/iteration and costs tokens. For 1,000+ rows, consider whether the tiering can be a deterministic rule in the SOQL/query layer instead — reserve the LLM for the ~10% of items that actually need semantic judgment.
- **Truncation risk:** never emit "all rows" from a single LLM node. Either use the deterministic `set` reshape (preferred) or fan out via foreach and let each iteration emit one row's worth.
- **Approval fatigue:** if the workflow has N medium-risk tool calls that always run together, wrap them in a single foreach so "Approve remaining rows" applies. Or accept the extra clicks — batching approvals doesn't change the underlying gates.

## Verifying before you scale

1. `workflows.save_draft` with `validate: true` — confirm zero errors AND zero warnings. This catches unknown action ids, untyped-foreach sources, and template refs to nonexistent paths.
2. Cap the query `LIMIT` to 25 and `workflows.test_run`. Poll `workflows.get_execution` every 15s. Confirm every node reaches `completed`, no `failed` iterations, and the final sheet/doc looks right.
3. Only then bump the LIMIT to the full scale.

If the query node hangs in `running` for >60s, check `get_execution` — a preflight-retry loop on a bad action id looks the same as slow work, but you'll see the retry attempts in the CF Workflow instance detail.
