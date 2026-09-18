# CBM Release Review

Read-only review. Nothing in the release folder was modified.

| | |
|---|---|
| Release folder | `13_09_2026 release CBM` |
| Branch | `phase-a-capture-normalization` at `11c6a48` |
| Remote | github.com/Coob-hash/CBM_n8n_WF (`main` at `554e68e`) |
| Reviewed | 14 September 2026 |
| Published copy | https://claude.ai/code/artifact/815a0860-d007-4c3a-93be-3efaa3977e0a |

Contents

1. [Verdict](#1-verdict)
2. [How the application works](#2-how-the-application-works)
3. [What was verified](#3-what-was-verified)
4. [Findings](#4-findings)
5. [Suggested order of work](#5-suggested-order-of-work)

---

## 1. Verdict

The release is a well-argued, heavily tested design with one serious operational hazard and a handful of real bugs at the seams between its parts. Every offline test suite passes when run on an isolated copy (25 dispatch, 15 knowledge, 40 database, 6 migration-runner, 9 extractor, 14 + 41 + 31 WF2, 32 + 55 + 82 WF3, 11 demo-ingestion checks). None of the live integrations (n8n import, Gmail, Anthropic, OpenAI, Supabase, MultiSet, the Python services) has ever been exercised, and this machine cannot run the Python services at all (pypdf, ifcopenshell, fastapi and psycopg are not installed).

| Offline checks passed | Critical | High | Medium | Low |
|---:|---:|---:|---:|---:|
| 361 | 1 | 7 | 14 | 9 |

> **Do not run the first command in the README on the real folder.** `node phase_b/build-workflow.js` regenerates the WF1 export from tracked sources and silently drops the 22 `Demo - …` nodes (726 lines), because their generator lives only in the git-ignored `phase_b/.test-runtime/demo-ingestion/` folder. The dispatch tests would still pass afterwards. See R1.

The five things to fix first, in order:

1. **R1** Make the WF1 export reproducible: track the demo-ingestion builder and its baseline, and make the Phase B builder preserve the Demo section.
2. **X1** WF1 tells technicians to upload `TICKET-<id>_after.jpg`; WF2 only reacts to `TICKET-<id>.pdf` and discards lone images silently. A technician who follows the instructions never triggers completion.
3. **W1** WF2's BEFORE-photo download reads a column (`drive_file_id`) that exists in no schema, so any completion with a photograph fails before assessment.
4. **W3** A facility manager who does not answer the approval e-mail within 72 hours is treated as having rejected the work; the ticket goes to REWORK and the technician is e-mailed a reason the agent invented.
5. **R2** WF3, the README edits and the test pin are uncommitted; 22 MB of manufacturer PDFs sit untracked and un-ignored; GitHub `main` is three commits behind.

---

## 2. How the application works

CBM ("Community-Based Maintenance") turns a photographed fault into a dispatched, completed and BIM-recorded maintenance job. It is built as three n8n workflows around one PostgreSQL database, a small FastAPI service over IfcOpenShell, and an optional Supabase vector library.

```mermaid
flowchart LR
  subgraph WF1["WF1 · intake and dispatch"]
    A1[Drive upload<br/>report_email_text.jpg] --> A2[Prepare Image<br/>calls /captures/normalize]
    A2 --> A3[MultiSet VPS<br/>pose + confidence]
    A3 --> A4{Confidence gate}
    A4 -- low --> A5[NEEDS_TRIAGE ticket<br/>+ FM e-mail]
    A4 -- ok --> A6[/elements/nearest<br/>IFC GlobalId]
    A6 --> A7{open ticket on<br/>same element?}
    A7 -- yes --> A8[DUPLICATE row]
    A7 -- no --> A9[Claude vision triage<br/>category · severity · skill]
    A9 --> B1[Phase B Context]
    B1 --> B2[Dispatch Agent<br/>Claude Sonnet 4.6]
    B2 --- T1[(create_ticket · get_context<br/>native Postgres tools)]
    B2 --- T2[(5 saved helper workflows)]
    B2 --- T3[(Radiator Technical Knowledge<br/>Supabase vector tool)]
    B2 --> B3[Verify committed outcome<br/>halt / retry / alert FM]
  end
  T2 --> M[Gmail offers with<br/>ACCEPT / DENY links]
  M --> H1[GET page · POST decision<br/>webhook /cbm-wf1-offer]
  H1 --> B1
  R[Recovery tick<br/>every minute] --> B1
  subgraph WF2["WF2 · completion and closure"]
    C1[Drive upload<br/>TICKET-id.pdf] --> C2[pdf-parse report text<br/>optional AFTER photo + vision]
    C2 --> C3[LLM chain proposes status<br/>code decides]
    C3 --> C4[FM approval e-mail<br/>sendAndWait 72 h]
    C4 --> C5[Closure Supervisor agent<br/>IFC write · close · notify]
    C5 --> C6[Verify from DB state]
  end
  subgraph WF3["WF3 · FM dashboard"]
    D1[Hosted chat · basic auth] --> D2[Agent with 8 read-only<br/>SQL tools + 20-turn memory]
    D3[Mondays 07:00] --> D4[One weekly JSON query<br/>→ formatted e-mail]
  end
  DB[(PostgreSQL · legacy 3 tables)]
  WF1 --- DB
  WF2 --- DB
  WF3 --- DB
  IFC[ifc_service.py<br/>FastAPI + IfcOpenShell]
  A2 --- IFC
  A6 --- IFC
  C5 --- IFC
  SB[(Supabase · pgvector)]
  T3 --- SB
  SYNC[Knowledge sync workflow<br/>every minute] --> SB
```

### Components

| Part | What it does | Source of truth |
|---|---|---|
| **WF1 Phase A** (15 nodes, frozen) | Google Drive trigger, image normalisation through the Python service, MultiSet localisation, confidence gate, nearest IFC element, duplicate check, Claude vision triage. | `phase_b/original_wf1.json` (byte-pinned); node 3 also in `phase_a/` |
| **WF1 Phase B** (dispatch) | An agent with two native Postgres tools and five saved helper workflows. Policy (five-technician shortlist, 1 or 2 live offers, 48 h, urgent next-business-day 08:00 slot, first persisted acceptance wins) is enforced in `operations.js` and SQL, not by the model. Offers are answered through a GET confirmation page and a POST webhook. A minute tick recovers due work without calling the model. Dispatch state is a JSON snapshot in `ticket_events` (`CBM_DISPATCH_STATE`) with optimistic concurrency on `tickets.updated_at`. | `phase_b/*.js`, `system-message.txt`, builder output `wf1_ticket_intake_and_dispatch.json` + `phase_b/workflows/*.json` |
| **Knowledge** | Read-only FastAPI extractor (`/knowledge/snapshot`) hashes the active IFC, an approved product catalog and PDF/TXT manuals into citable chunks; a separate n8n sync workflow embeds them with OpenAI and publishes atomically into Supabase; the dispatch agent searches them filtered by the ticket's exact GlobalId; the offer helper re-reads the chosen chunk ids before they enter the invitation. | `knowledge/` |
| **Demo ingestion** (22 nodes inside the WF1 export) | Manual trigger that OCRs the PDFs in `technical_sheets/` with Mistral OCR (tables + figure annotations), embeds them and publishes into a separate Supabase table `cbm_demo_technical_documents`. Not connected to the agent. | Only `phase_b/.test-runtime/demo-ingestion/build.js` (git-ignored) |
| **WF2** | Report-first completion: the PDF report is mandatory, a photo optional. A chain proposes a status, code validates it, the FM approves by e-mail, then a supervising agent with nine typed tools writes the IFC maintenance record, closes the ticket, updates statistics and notifies. Committed DB state decides whether closure settled. | `wf2/build_wf2.py` over `wf2/original_wf2.json` |
| **WF3** | FM chat over the full ticket history with eight read-only parameterised SQL tools, and a Monday weekly report built from one JSON query plus a status-change trigger installed by `schema_wf3_dashboard.sql`. | `wf3/build_wf3.py` (no original export) |
| **Python services** | `ifc_service.py`: nearest element, maintenance Pset write with a new versioned IFC file, capture normalisation (EXIF intrinsics, orientation, 1280 px). `calibrate_registration.py` computes the MultiSet→IFC transform. `create_sample_ifc.py` makes a door/window/light room. | root `*.py` |
| **Database** | Two models coexist. The **legacy** three tables plus JSON events are what all three workflows actually use (`schema.sql` + two additive migrations). The **27-table `cbm` schema** under `database/` is complete, transactional and tested but not wired to any workflow. | `schema*.sql`, `database/migrations/` |

### Life of a ticket (as shipped)

1. A photo lands in the incoming Drive folder. Node 3 posts it to `/captures/normalize`; if the service is down or the EXIF has no 35 mm focal length the item continues with untrusted intrinsics.
2. MultiSet returns a pose. Low confidence or untrusted intrinsics → a `NEEDS_TRIAGE` ticket and an FM e-mail. Otherwise the nearest maintainable IFC element is chosen within 3 m.
3. If an open ticket already exists on that GlobalId a `DUPLICATE` row is written and the run ends. Otherwise Claude classifies the fault and the Phase B agent creates the `LOCALIZED` ticket idempotently (source key = Drive file id).
4. The agent initialises dispatch (shortlist of five, appointment policy), sends the FM opening notice, then offers the job to the top-ranked eligible technician (two in parallel for severity 4–5). Each offer carries a 64-hex token in the e-mail link.
5. The technician opens the GET page and confirms with a POST; the decision is persisted before the agent runs again. First valid acceptance wins; competitors are withdrawn; declines and expiries move down the shortlist; exhaustion or the urgent cutoff escalates to the FM.
6. After the work, WF2 expects `TICKET-<id>.pdf` in the completed folder, assesses the report, asks the FM, then closes the ticket and writes `CBM_MaintenanceLog` into a new IFC version.
7. WF3 lets the FM ask about any ticket and mails a weekly digest with status changes and tickets open longer than 30 days.

---

## 3. What was verified

All commands ran on a copy of the folder under the session scratchpad, never on the release. The copy was committed first so that builder drift could be measured with `git status`.

| Command | Result | Note |
|---|---|---|
| `node phase_b/build-workflow.js` | **DRIFT** | Removes 22 Demo nodes from WF1 (74 → 52 nodes, −726 lines). Everything else reproduced byte for byte. |
| `node phase_b/test-dispatch.js` | 25 / 25 | PGlite 0.5.8, mocked Gmail, simulated tool selection. |
| `node knowledge/test_knowledge.js` | 15 / 15 | PGlite + pgvector, synthetic vectors. |
| `node database/tests/test_database.js` | 40 / 40 | 27 tables match the proposal document. |
| `python database/tests/test_migrate.py`, `python -m unittest knowledge.test_extract` | 6 + 9 | Python 3.14, stdlib only. |
| `wf2/validate_wf2.py`, `test_wf2_nodes.mjs`, `test_migration.mjs` | 14 + 41 + 31 | |
| `wf3/validate_wf3.py`, `test_wf3_nodes.mjs`, `test_wf3_queries.mjs` | 32 + 55 + 82 | |
| `python wf2/build_wf2.py`, `python wf3/build_wf3.py` | reproducible | Both exports rebuilt byte for byte; hash pins unchanged. |
| `node phase_b/.test-runtime/demo-ingestion/test.js` / `build.js` | 11 / 11, path drift | Rebuild changes one line: the absolute folder path baked into `Demo - Source Settings`. |
| SHA-256 pins in `test-dispatch.js`, `build-workflow.js`, validation reports | consistent | WF2, WF3, `schema.sql`, `original_wf1.json`, `original_wf2.json`, `knowledge/schema.sql` all match. |

**Not verified, and not verifiable here:** import into a live n8n instance (node `typeVersion` compatibility), pg-promise's handling of the multi-statement parameterised queries in transaction mode, Supabase RPC and Default Data Loader serialisation, the Python services (dependencies missing on this machine), MultiSet, Gmail, Anthropic, OpenAI and Mistral calls.

---

## 4. Findings

Each finding states where it is, what goes wrong, and the fix. Line references point at source files, not at the generated exports.

### Repository and build integrity

#### R1 · CRITICAL · The shipped WF1 export cannot be rebuilt from tracked sources

- **Where:** `phase_b/build-workflow.js` (writes the whole export), commit `3feeff8` (adds 22 Demo nodes to the JSON only), `phase_b/.test-runtime/demo-ingestion/build.js` + `before.json` (git-ignored by `phase_b/.gitignore`).
- **Problem:** The demo-ingestion branch was generated by an untracked script on top of an untracked snapshot and pasted into the export. The README's first build step regenerates the export from `original_wf1.json` plus Phase B and knowledge code, so it deletes the Demo section (verified: 74 → 52 nodes). `test-dispatch.js` only asserts that the first 15 nodes are preserved, so nothing would catch the loss. A clone of the repository has no way to recreate those nodes. The Demo sticky note even says "the existing Phase B builder does not regenerate these added nodes; preserve this section when rebuilding", which is a manual instruction where a guard is needed.
- **Fix:** Move `build.js`, `test.js` and `before.json` out of `.test-runtime` into a tracked folder (for example `demo_ingestion/`). Make `build-workflow.js` either call that builder as its last step or copy every node whose name starts with `Demo - ` (and their connections) from the current export into the new one. Add a test that the export contains the 22 Demo node names. Then `before.json` becomes unnecessary: the demo builder can take the freshly built WF1 as input.

#### R2 · HIGH · Working tree, branch and GitHub are three different states

- **Where:** `git status`: `README.md` and `phase_b/test-dispatch.js` modified; `wf3/`, `n8n_wf3_fm_dashboard.json`, `schema_wf3_dashboard.sql`, `technical_sheets/` untracked. `origin/main` lacks `knowledge/`, the Demo nodes and WF3.
- **Problem:** The WF3 deliverable and the WF3 hash pin exist only on this disk. `technical_sheets/` holds 22 MB of Kermi manufacturer PDFs that are neither tracked nor ignored, so the next `git add -A` commits third-party documents whose redistribution rights are unclear. `main` on GitHub still describes a two-workflow project.
- **Fix:** Commit WF3 and the doc edits on the branch; add `technical_sheets/` to `.gitignore` (keep a `technical_sheets/README.md` naming the expected files); merge the branch into `main`. The GPL-3.0 `LICENSE` lives only on `main`; the merge keeps it, but confirm that licence is intended.

#### R3 · HIGH · An absolute path from this PC is baked into the WF1 export

- **Where:** `wf1_ticket_intake_and_dispatch.json` line 1395, node `Demo - Source Settings`; generated by `root.replace(/\\/g,'/')+'/technical_sheets'` in the demo builder.
- **Problem:** The committed export contains `C:/Users/USER/Desktop/Progetti Dottorato/…/technical_sheets`. It is wrong on every other machine and inside Docker, and it publishes a local user path. Rebuilding on another machine changes the export.
- **Fix:** Set the value to an n8n expression such as `{{ $env.CBM_TECHNICAL_SHEETS_DIR }}` or a `REPLACE_…` placeholder, and document it next to the other placeholders.

#### R4 · LOW · Test coverage gaps that let the bugs below through

- **Where:** `phase_b/test-dispatch.js` (only nodes 0–14 compared), `wf2/validate_wf2.py` (checks node names in `$('…')`, not field names), `wf2/test_wf2_nodes.mjs` (never runs Download BEFORE Photo or Parse Verification with real ticket columns).
- **Fix:** Add: a node-count/name assertion for the full WF1 export; a WF2 check that every `$('Fetch Ticket').item.json.<field>` is a column of `tickets` or an alias in the query; a cross-workflow test that the filename WF1 asks for is one WF2 accepts.

### Cross-workflow contracts

#### X1 · HIGH · WF1 asks for a photo; WF2 only accepts a PDF and ignores photos silently

- **Where:** `phase_b/operations.js`, `processEvents()`: the `assigned:technician` e-mail says "upload the after-photo to 02_completed_snapshots as TICKET-<id>_after.jpg". `wf2/build_wf2.py`, `EXTRACT_TICKET_JS`: `if (!isReport) return [];`.
- **Problem:** The completion contract changed to report-first but the instruction in the assignment e-mail did not. A technician who does exactly what WF1 told them uploads a JPEG, WF2 ends the run quietly, no assessment starts, nobody is notified, and the ticket stays `ASSIGNED` until it appears in the WF3 overdue list a month later. The database proposal still mentions `TICKET-123_after.jpg` too.
- **Fix:** Rewrite the assignment message: "upload your written report as TICKET-<id>.pdf; a photo named TICKET-<id>.jpg is optional". Rebuild WF1. In WF2, when an image arrives for an `ASSIGNED`/`REWORK` ticket that has no report yet, send the technician a short reminder instead of returning no items.

#### X2 · MEDIUM · Three different addresses for the same IFC service

- **Where:** WF1 node `Find IFC Element`: `http://localhost:8000` hard-coded. WF1 node `Prepare Image & Metadata`: `$env.IFC_SERVICE_URL` with a localhost default. WF2 `Closure Context`: `http://ifc-service:8000` (a Docker hostname).
- **Fix:** Use one `$env.IFC_SERVICE_URL` everywhere and document it once.

#### X3 · MEDIUM · The sample model and the localisation service do not know radiators

- **Where:** `ifc_service.py` `MAINTAINABLE_CLASSES` (no `IfcSpaceHeater`); `create_sample_ifc.py` (door, window, light); `knowledge/catalog.example.json` (`IfcSpaceHeater`); `technical_sheets/` (radiator datasheets); the agent tool is named "Radiator Technical Knowledge".
- **Problem:** Phase A calls `/elements/nearest` without a class hint, so a photo of a radiator is matched to the nearest door, window or light, and the knowledge filter (exact GlobalId) then finds nothing. The whole knowledge feature cannot be demonstrated on the sample model.
- **Fix:** Add `IfcSpaceHeater`, `IfcFlowTerminal` and `IfcUnitaryEquipment` to the candidate classes (or read the list from an environment variable), and add a radiator to the sample generator so the end-to-end demo is possible.

### WF1 Phase A (preserved from the original export)

#### A1 · HIGH · SQL built by string interpolation from the uploaded filename

- **Where:** Nodes `Create Triage Ticket`, `Check Duplicate`, `Log Duplicate Report` (Postgres v2.4, `=INSERT … '{{ $('Prepare Image & Metadata').first().json.reporterEmail }}' …`). `reporterEmail` is `parts[1]` of the Drive filename whenever it contains an `@`.
- **Problem:** A file named `report_x'@y_a.jpg` breaks the statement; a crafted name can run arbitrary SQL with the workflow's database credential. Anyone who can drop a file into the incoming folder reaches this. Phase B was written with parameters precisely to avoid this, but Phase A was frozen byte for byte.
- **Fix:** Convert the three nodes to `queryReplacement` parameters (`$1`, `$2`…), then re-pin `original_wf1.json` (the builder refuses to run if the Phase A fingerprint differs, so this is a deliberate baseline change).

#### A2 · MEDIUM · Anthropic key as a plain HTTP header instead of a credential

- **Where:** Node `Vision Triage (Claude)`: header `x-api-key: REPLACE_WITH_ANTHROPIC_API_KEY_or_use_n8n_credential`.
- **Problem:** Filling the placeholder stores the secret inside the workflow JSON and every export. Phase B and WF2 use the Anthropic credential type.
- **Fix:** Switch to `authentication: predefinedCredentialType` with `anthropicApi`, or replace the node with a Basic LLM Chain and the existing Anthropic model node.

#### A3 · MEDIUM · Unparseable triage silently becomes a severity-3 "general" ticket

- **Where:** Node `Parse Triage JSON`: `catch (e) { triage = { category:'unknown', severity:3, … required_skill:'general' } }`; `mapCode` falls back to the literal `REPLACE_WITH_MULTISET_MAP_CODE`.
- **Problem:** A model outage or malformed reply is not a triage result, yet it passes the Phase B contract check and dispatches a job to "general" technicians with an invented severity, and can store a placeholder string in `tickets.map_code`.
- **Fix:** On parse failure route to the `NEEDS_TRIAGE` branch (same path as low confidence) and never write the placeholder.

#### A4 · MEDIUM · Dead ends: manual triage, duplicates, escalation and provider errors

- **Where:** Nodes `Create Triage Ticket`, `Log Duplicate Report`, `MultiSet - Get Token`, `MultiSet - Localize Snapshot`; `operations.js` `escalate()`.
- **Problem:** `NEEDS_TRIAGE` tickets ask the FM to "localize manually and re-dispatch", but no node, tool or webhook re-enters Phase B for an existing ticket without a Drive upload. `DUPLICATE` rows are written without telling the reporter or the FM. `ESCALATED` tickets require "manual dispatch" but the legacy workflows have no manual-assignment path (the `cbm` schema has one, unused). The two MultiSet HTTP nodes have no `onError`, so a 4xx/5xx stops the execution with no ticket and no e-mail.
- **Fix:** Add a small FM-facing "resume ticket" entry (a webhook or a WF3 action) that sets the element and skill and hands the ticket to Phase B; e-mail the reporter on duplicates; give the MultiSet nodes `onError: continueErrorOutput` wired to the manual-triage branch.

#### A5 · LOW · Phase A note contradicts the current intrinsics design

- **Where:** Sticky note `Note -380x-260`: "override the CONFIG block there with your phone's real fx/fy/px/py".
- **Fix:** Intrinsics now come from EXIF through the service; update the note (it is part of the pinned baseline, so re-pin together with A1).

### WF1 Phase B (dispatch)

This is the strongest part of the release. The policy code and its SQL mirror are consistent (`facts()` in `operations.js` was compared against the `unfinished`/`outcome` logic in `PUBLIC_CONTEXT` clause by clause), tokens never reach the model, HTML is escaped, GET is read-only, and concurrency is guarded by the `updated_at` revision. The remaining points are edge cases and deployment risks.

#### B1 · MEDIUM · Local deployment file carries a Google OAuth client id where an n8n credential id belongs

- **Where:** `phase_b/deployment.local.json`: `"gmailCredentialId": "901403356630-….apps.googleusercontent.com"`; `callbackBase`, Postgres and Anthropic ids still `REPLACE_…`; no `knowledge` or `workflowIds` block (the builder merges defaults, which is fine).
- **Problem:** n8n credential ids are short internal identifiers; this value will not resolve, and `Phase B Context` throws on activation while `callbackBase` contains `REPLACE`. The file is git-ignored, so this is a deployment blocker, not a leak.
- **Fix:** Copy the ids from the n8n credentials page after import; set the real public webhook prefix.

#### B2 · MEDIUM · Late Gmail acknowledgement can promise an ordinary slot that starts before the response window ends

- **Where:** `operations.js`: `offer()` computes the appointment date from the reservation time; `acknowledge()` resets `expires_at` to acknowledgement time + 48 h without re-checking the date.
- **Problem:** The e-mail already went out with the date. The new `cbm.record_delivery` function halts dispatch in exactly this case; the legacy JavaScript only documents it ("unusually long delays still require operational review").
- **Fix:** In `acknowledge()`, if `!urgent && atRome(o.date,14) <= newDeadline + 10 min`, mark the offer `UNCERTAIN` and call `block()`, mirroring the SQL.

#### B3 · LOW · Multi-statement parameterised queries depend on pg-promise behaviour that has not been exercised live

- **Where:** `queries.js` `CREATE` (`LOCK TABLE …; WITH …`) and `RECORD_RESPONSE` (`SELECT … FOR UPDATE; WITH …`), run with `queryBatching: transaction`. The tests split the statements by hand.
- **Fix:** On first import, run one ticket end to end and confirm `Response Receipt` receives `response_result` (the node should return only the last statement's rows). If not, move the lock into the CTE query as `SELECT pg_advisory_xact_lock(…)` or split into two nodes.

#### B4 · LOW · Node versions to confirm against the target n8n release

- **Where:** Demo nodes: `n8n-nodes-base.crypto` typeVersion 2, `readWriteFile` 1.1, `set` 3.4; WF3 `chatTrigger` 1.1; everywhere `postgres`/`postgresTool` 2.6, `vectorStoreSupabase` 1.3, `agent` 2, `toolWorkflow` 2.1. Phase A still uses `postgres` 2.4 and `if` 2.
- **Fix:** Record the n8n version the exports were written for in the README and import all four workflows into that version once before relying on the JSON.

### Knowledge and demo ingestion

#### K1 · MEDIUM · Every new fingerprint blacks out retrieval until the rebuild publishes, and every WF2 closure creates a new fingerprint

- **Where:** `knowledge/schema.sql` `cbm_begin_knowledge`: `UPDATE cbm_knowledge_head SET generation=k, status='BUILDING'` as soon as a new fingerprint is observed; `match_cbm_knowledge` and `cbm_offer_knowledge` require `READY`. `knowledge/extract.py`: the fingerprint includes the IFC file hash, and IFC-property chunk ids include the model filename (`revision=model_path.name`).
- **Problem:** Each approved closure writes `room_v(N+1).ifc` and moves the pointer, so the next sync tick supersedes the current generation; offers sent during the rebuild carry "no verified technical excerpt", and a failed build leaves knowledge unavailable for the 10-minute `BUSY` lease. IFC-property chunk ids also change on every version, so an agent selection made just before a tick is rejected as stale.
- **Fix:** Keep two pointers in `cbm_knowledge_head` (published and building) and only switch on publish; derive the IFC chunk id and `source_revision` from the model lineage or content hash rather than the filename.

#### K2 · MEDIUM · If the native loader alters the text, publication fails forever and nobody is told

- **Where:** Sync workflow: `Approved Document Loader` (JSON mode, expression `{{ $json.content }}`) → `Preserve Source Chunk` → Supabase insert; `cbm_publish_knowledge` requires `v.content = s.content` exactly. The README flags native-node serialisation as untested.
- **Problem:** Should the loader JSON-encode the string or the splitter trim whitespace, every build ends in "Incomplete or altered vector build", the head stays `BUILDING`, and the only signal is a failed execution in n8n's list.
- **Fix:** Validate with one real document first; attach an n8n error workflow that e-mails the FM/operator; compare a normalised form (trimmed) in the publication check if the loader proves to trim.

#### K3 · MEDIUM · Sync execution timeout is too short for real manuals

- **Where:** `knowledge/nodes.js`: sync workflow `settings.executionTimeout: 300`, batch size 1 per chunk, one OpenAI call per chunk.
- **Problem:** The demo sheets alone are 336 pages (hundreds of chunks). A corpus that takes longer than five minutes never reaches `Publish Complete Generation`; the next tick sees `BUSY`, then after ten minutes starts over, reusing embeddings but repeating the timeout.
- **Fix:** Raise the timeout (or remove it), or embed in batches of 20–50 through the native node's multi-item input while keeping per-item metadata.

#### K4 · MEDIUM · The demo library is undocumented and needs a table nobody ships

- **Where:** Demo nodes reference `public.cbm_demo_technical_documents`; no SQL creates it (the sticky note says "configure manually"); no README mentions the Demo branch, the Mistral OCR credential, or how the demo library relates to the production knowledge (it does not).
- **Fix:** Add `knowledge/demo_schema.sql` (table + RLS + grants, same style as `schema.sql`) and a README section; state that the demo library is never searched by the dispatch agent.

#### K5 · LOW · Two Postgres credentials with near-identical names point at different databases

- **Where:** "CBM Postgres" (dispatch DB) versus "CBM Supabase Postgres" (knowledge DB); WF2's original nodes still call the dispatch credential "Postgres (Supabase) account".
- **Fix:** Rename the WF2 credential placeholders to the Phase B names (the builder can do it) so that a Supabase project is never picked as the dispatch database by mistake.

### WF2 (completion, approval, IFC update)

#### W1 · HIGH · The BEFORE photo is downloaded from a column that does not exist

- **Where:** Node `Download BEFORE Photo`: `fileId = {{ $('Fetch Ticket').item.json.drive_file_id }}`. `drive_file_id` appears in no schema file; WF1 stores only `photo_before_url` (a Drive `webViewLink`). Inherited from `original_wf2.json`.
- **Problem:** Whenever a photo accompanies the report, `Photo Available?` is true, the Drive node receives an undefined id and errors, and the execution stops before assessment, before the FM e-mail and before any notification. Only report-only completions work. The offline tests never execute this node.
- **Fix:** Have WF1 keep the Drive file id (add `before_file_id` in the next legacy migration and set it from `Drive Trigger - New Snapshot` in `create_ticket`), or extract the id from `photo_before_url` with a regex (`/d/([^/]+)`). Add the field to the WF2 migration test.

#### W2 · MEDIUM · Regression from the rebuild: renamed fields, un-renamed reader

- **Where:** `wf2/build_wf2.py` changed `Extract Ticket ID` to emit `report_file_id`/`report_link` (the original emitted `file_id`/`after_link`); node `Parse Verification` still reads `x.file_id` and `x.after_link`.
- **Problem:** When the vision branch does run, `after_file_id` and `after_link` are `undefined`; `tickets.after_file_id` is written as NULL and the FM approval e-mail shows an empty "AFTER photo" line.
- **Fix:** Read `$('Find AFTER Photo').first().json.id` and `.webViewLink` in `Parse Verification` (patch it from the builder like the other nodes) and assert it in `test_wf2_nodes.mjs`.

#### W3 · HIGH · FM silence is treated as rejection

- **Where:** Node `FM Approval (Email + Wait)` with `limitWaitTime` 72 h; `FM Approved?` tests `$json.data.approved`; `CLOSURE_CONTEXT_JS`: `approved = decisionRaw && decisionRaw.data ? … : false` → `REJECTED`; `test_wf2_nodes.mjs` asserts "a missing approval payload is treated as REJECTED".
- **Problem:** After the timeout the ticket is moved to `REWORK`, `fm_reject_reason` is filled by the agent's `$fromAI("reason")`, and the technician is e-mailed that rework is required although nobody rejected anything. The database design explicitly says expiry is neither approval nor rejection (`cbm.expire_approval`), and the README repeats that guarantee.
- **Fix:** Add a third outcome: if `$json.data` is absent, set a `CBM_WF2_APPROVAL_EXPIRED` event, leave the status `PENDING_APPROVAL`, e-mail the FM a reminder with a fresh approval link, and change the test accordingly.

#### W4 · MEDIUM · The agent is told to record IFC_SYNC_FAILED and the FM is told "IFC updated" regardless

- **Where:** `close_ticket` tool description ("or IFC_SYNC_FAILED if the IFC write could not be completed"); `notify_fm` subject "closed - IFC updated"; `docs/database_schema_proposal.md` §7: "A failed synchronization does not replace a version filename with a sentinel string such as IFC_SYNC_FAILED"; `database/README.md`: "Notifications must not claim the model was updated while its job is pending or uncertain".
- **Fix:** Keep `ifc_new_version` NULL on failure, record a `CBM_WF2_ATTEMPT` with the error, and make the FM subject conditional on the IFC result.

#### W5 · MEDIUM · Report text is interpolated into SQL

- **Where:** Node `Set Pending Approval`: `report_text = '{{ $json.report_text_sql }}'` with quote doubling done in code; `report_file_id` and `after_file_id` are not escaped at all.
- **Problem:** The text comes from a PDF uploaded by the technician. Quote doubling is correct under `standard_conforming_strings = on` (the default) but the pattern is fragile and inconsistent with every other write in the release, which uses `queryReplacement`.
- **Fix:** Parameterise: `report_text = $2`, `verification = $5::jsonb`, and pass an array from the expression.

#### W6 · LOW · Guard names promise more than they check

- **Where:** `Ticket Open and Assigned?` only checks that the ticket exists and is not `CLOSED`; a report for a `DISPATCHING` or `NEEDS_TRIAGE` ticket is assessed. `Closure Context` sends `ifcGlobalId: null` for tickets without an element, producing `/elements/null/maintenance`.
- **Fix:** Require `status IN ('ASSIGNED','WORK_DONE','REWORK')` and skip `log_ifc_maintenance` when there is no GlobalId.

#### W7 · LOW · Stale text inside the WF2 export

- **Where:** The three sticky notes describe the old photo-first flow, "TICKET-<id>.jpg" and the sentinel; `Notify FM - Photo Problem` talks about an unmatched photo although it now receives PDFs; its expressions use `.item` on the trigger.
- **Fix:** Rewrite these in `build_wf2.py` as it already does for other inherited nodes.

### WF3 (facility manager dashboard)

Clean design: read-only tools, one bind parameter, dates fixed in code, figures computed in SQL. Small points only.

#### D1 · MEDIUM · "Mondays at 07:00" has no timezone

- **Where:** `wf3/build_wf3.py`: `settings: {executionOrder: "v1"}`; WF1 helpers set `timezone: Europe/Rome`. The report window is computed in UTC in `Report Window`.
- **Fix:** Add `timezone: "Europe/Rome"` to the workflow settings and label the window in Rome time, so the chat anchors, the e-mail and the schedule agree.

#### D2 · LOW · Unordered LIMIT inside the weekly CTEs

- **Where:** `WEEKLY_SQL`: `changes … LIMIT 500` and `stale … LIMIT 200` without `ORDER BY` inside the CTE.
- **Fix:** Order by `created_at` inside each CTE so a busy week drops the newest rows, not arbitrary ones.

#### D3 · LOW · The chat surface is public with Basic Auth only

- **Where:** `FM Chat`: `public: true`, `authentication: basicAuth`; tools return technician e-mails and full report text.
- **Fix:** Acceptable for a single FM if n8n is behind TLS; add an IP allow-list or SSO at the reverse proxy before wider use.

### Python services

#### S1 · HIGH · The IFC maintenance endpoint is neither idempotent nor serialised, yet the agent is told it is safe to retry

- **Where:** `ifc_service.py` `log_maintenance()`: reads the active model, appends to `History`, writes `_next_version_path()`, rewrites `active_model.txt`; no lock, no request key. WF2 `log_ifc_maintenance` tool description: "Safe to retry: the service versions each write". `database/README.md`: "The external IFC service still needs idempotency keyed by `ifc_sync_jobs.operation_key`".
- **Problem:** Two closures approved in the same minute both read `room_v3.ifc` and both write `room_v4.ifc`; the second overwrites the first and one maintenance record is lost. A retried call after a lost HTTP response appends the ticket twice to the history and creates an extra version.
- **Fix:** Accept an `operation_key` (ticket id + approval id), store it in the audit JSONL and return the earlier result on replay; wrap read-modify-write in a file lock (`portalocker` or `msvcrt`/`fcntl`) around the pointer file.

#### S2 · LOW · Ultrawide captures are rejected although the docstring says they are handled

- **Where:** `capture_normalize.py`: docstring "a 0.5x or 3x capture is handled correctly"; `gate()` requires `0.5·W ≤ fx`. A 13–16 mm-equivalent lens gives `fx = f35·W/36 ≈ 0.36–0.44·W`.
- **Fix:** Either widen the lower bound to about `0.3·W` (that is the true range of phone ultrawides) or state that ultrawide captures go to manual triage.

#### S3 · LOW · Services have never been started on this machine

- **Where:** Python 3.14 and Anaconda 3.13 are installed; `pypdf`, `ifcopenshell`, `fastapi`, `uvicorn`, `psycopg` are missing from both; no `.venv` in the release.
- **Fix:** Create the venv the README describes and smoke-test `/health`, `/captures/normalize` with one of the case-study photos, and `/knowledge/snapshot` with a one-page TXT before the n8n import. Note `ifcopenshell` wheels for 3.14 may not exist yet; use the 3.13 Anaconda interpreter.

### Database packages

#### DB1 · HIGH · Two data models, and the new one already contradicts the shipped WF2 contract

- **Where:** Legacy: `schema.sql` + `schema_wf2_completion.sql` + `schema_wf3_dashboard.sql`, used by everything. New: `database/migrations/001–003`, used by nothing. `001_tables.sql` `assessments` CHECK requires `after_file_id` for `REPAIR_VERIFICATION`; `002_integrity.sql` `guard_approval` raises "Completion requires evidence" when `completion_files` is empty; the ticket status list lacks `DUPLICATE` (moved to reports).
- **Problem:** A report-only completion, the normal case in the rebuilt WF2, cannot be verified or sent for approval in the `cbm` schema. Every legacy migration added for WF2 and WF3 widens the gap the cutover will have to close. `wf2/README.md` acknowledges the first CHECK but not the second.
- **Fix:** Decide now whether the cutover happens: if yes, add migration `004` relaxing both checks (report text is evidence; a PDF is a `completion_files` row with role `REPORT`), and write the WF1/WF2/WF3 SQL against the `cbm.*` functions; if no, mark `database/` as a design study in the README so nobody applies it next to production.

#### DB2 · MEDIUM · NOT VALID check will bite existing closed tickets

- **Where:** `schema_wf2_completion.sql`: `tickets_closed_at_consistent CHECK ((status='CLOSED') = (closed_at IS NOT NULL)) NOT VALID`.
- **Problem:** `NOT VALID` skips old rows only until they are next updated. Any ticket closed by the previous WF2 (no `closed_at` column then) fails its next UPDATE, including a WF3-era correction typed in psql.
- **Fix:** Backfill `UPDATE tickets SET closed_at = updated_at WHERE status='CLOSED' AND closed_at IS NULL` before adding the constraint, then `VALIDATE CONSTRAINT`.

#### DB3 · LOW · Legacy "one open ticket per element" can be bypassed by Phase A itself

- **Where:** `schema.sql` index `idx_tickets_open_element` is not unique; Phase A's `Check Duplicate` and Phase B's `CREATE` both guard in code. `CREATE` takes a table lock; Phase A does not.
- **Fix:** Make the partial index unique (`CREATE UNIQUE INDEX … WHERE status NOT IN ('CLOSED','DUPLICATE')`) in the next legacy migration; the `cbm` schema already does this.

### Documentation and configuration

#### C1 · MEDIUM · Documents disagree with the code they describe

- **Where:**
  - `README.md` "Build and test" opens with the command that destroys the Demo section (R1) and never mentions the Demo branch, Mistral or `technical_sheets/`.
  - `docs/WF1_Native_Tools_Guide.docx` predates the knowledge tool (acknowledged) and the Demo nodes (not acknowledged).
  - `docs/database_schema_proposal.md` still names `TICKET-123_after.jpg` and forbids the sentinel WF2 uses (W4).
  - `phase_b/README.md` says Phase A "is preserved exactly" and lists WF2 columns as "now closed"; it does not mention that Phase A carries A1–A4.
  - `knowledge/README.md` describes `IfcSpaceHeater` assets the service cannot localise (X3).
  - Validation counts in `README.md` match the suites today; they will drift unless the reports are regenerated in CI.
- **Fix:** One "Rebuild everything" section listing the exact command order (WF1 builder, demo builder, WF2, WF3, all tests) and the same list as a script (`rebuild.ps1`) so the pins and reports stay consistent.

#### C2 · LOW · Placeholder conventions differ per era

- **Where:** Phase A: `REPLACE_CRED_ID`, `REPLACE_ME`, `REPLACE_FOLDER_ID_01_INCOMING_SNAPSHOTS`; Phase B/WF3: `REPLACE_POSTGRES_CREDENTIAL_ID`…; WF2 original nodes: `REPLACE_ME`; demo: `REPLACE_MISTRAL_HEADER_CREDENTIAL_ID`.
- **Fix:** A single table of placeholders in the README, and a grep-based test that no export contains a value that is neither a placeholder nor an n8n-generated id.

---

## 5. Suggested order of work

1. **Stop the bleeding (half a day).** R1, R3, R2: move the demo builder into the repository, make the Phase B builder preserve or regenerate the Demo section, replace the absolute path, ignore `technical_sheets/`, commit WF3, merge to `main`.
2. **Fix the contract seams (one day).** X1 assignment e-mail; W1 and W2 in `build_wf2.py` with tests; W3 approval-expiry branch; X3 radiator classes; S1 idempotent IFC writes.
3. **Harden Phase A (half a day, requires re-pinning the baseline).** A1 parameters, A2 credential, A3 parse failure → manual triage, A4 error outputs, A5 note. Update `original_wf1.json`, `originalHash` in the builder and the test fixture together.
4. **First live run.** Create the Python venv, start the service, import the four workflows into the target n8n version, run one ordinary and one urgent ticket end to end with a controlled mailbox. Check B3, B4, K2 during this run.
5. **Decide the database future.** DB1: either schedule the `cbm` cutover (migration 004 + SQL rewrite) or freeze it as a design study. Apply DB2 and DB3 to the legacy schema in either case.
6. **Documentation pass.** C1, C2, W7, K4, D1.

---

*Method: every source, migration, builder, validator, test and export in the release was read; all suites and builders were executed on an isolated copy; the GitHub remote was compared with `git ls-remote` and a fetch of the repository page. No file in the release folder was written.*
