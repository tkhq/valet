---
name: xors-brain
description: Query the XORS company brain (clients, projects, offerings, pricing, stack, GTM playbooks, pipeline, ops, decisions, people). Load it before you answer anything about what XORS does, has built, charges, or decided, before you write outreach, proposals, SOWs or case studies, and when a client or prospect is named.
---

# XORS company brain

XORS is a boutique software studio. The brain holds what the company knows. Read it before you answer from assumption.

## Tools

Call these through `call_tool` with `service=brain`:

- `brain.search(query, section?, limit?)`: find entries. Returns ids, sensitivity, and a summary.
- `brain.get(ids)`: read full entries. Use this before you state a fact.
- `brain.list(section?)`: see what exists in a section.

## Sections

| Section | Contents |
|---|---|
| `00-identity` | Positioning, north star, operating model |
| `01-people` | Partners, roster, owners |
| `02-offerings` | Services and prices |
| `03-clients` | One dossier per client |
| `04-projects` | One entry per codebase or engagement |
| `05-tech` | Stack and standards |
| `06-gtm` | ICP, outbound motion, voice, collateral |
| `07-pipeline` | Live opportunities |
| `08-ops` | How the business runs |
| `09-assets` | Case studies and collateral |
| `10-decisions` | Decisions, reasons, and what they ruled out |

## Procedure

1. Search with two or three specific keywords (client name, technology, service).
2. Read the top entries with `brain.get`. Follow `links` when the answer spans entries.
3. Answer from the entries. Cite the entry id for each fact.
4. If the brain has no answer, say so. Do not invent XORS facts.

## Sensitivity

- `public`: you can use it in proposals, posts, and cold emails.
- `internal`: use it for the team only. Do not send it to clients or prospects.
- `confidential`: this instance does not contain it. Tell the user to check the source brain.

Before text leaves XORS, make sure that each fact comes from a `public` entry.

## Updates

This brain is a read-only snapshot. To record a new fact, tell the user which entry to change. The source of truth is the `xors-brain` repo. After an edit, run `python3 packages/plugin-xors-brain/scripts/build.py` and redeploy.
