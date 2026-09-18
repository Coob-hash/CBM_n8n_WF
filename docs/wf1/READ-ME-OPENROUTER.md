# OpenRouter vision and dispatch update

## Installed result

The replacement API key works and is stored in n8n as **CBM OpenRouter - New Account**. It belongs to the newly supplied account. The older **OpenRouter account** credential remains separate.

The existing WF1 draft now uses:

| Stage | Model | Purpose |
| --- | --- | --- |
| Observe Room Image | `google/gemini-3.1-flash-lite` | Read the photo; describe visible objects, bounding boxes and visible maintenance evidence. |
| Match IFC Asset and Describe Issue | `google/gemini-3.8-flash` | Match clear validated observations to the supplied IFC candidates and prepare the maintenance description. This call receives text, not the image. |
| Dispatch OpenRouter Model | `google/gemini-3.8-flash` | Operate the Dispatch Agent's existing guarded tools for one bound ticket. |

The current simplification removes the second image review and keeps the vision stages together. WF1's name and ID remain unchanged. See [the single-ticket update](../dispatch/READ-ME-SINGLE-TICKET.md). Refresh the n8n editor before editing the saved draft; an old open editor can overwrite the update.

## How image processing works

```text
IFC candidates → Observe Room Image → Validate Room Observations → Vision Clear?
  unclear/invalid → Classify Capture Failure → replacement photo / IT escalation
  clear → Match IFC Asset and Describe Issue → Parse Triage JSON → Triage Valid?
  accepted triage → Prepare Ticket Request → FM authorization
```

Unclear vision, invalid model output or rejected IFC matching goes to the existing capture-failure path, which requests a replacement photo and eventually escalates to IT under the report's existing retry policy. No second model receives the image.

Code checks required fields, string/list limits, unique object IDs, four coordinates between 0 and 1, an exact candidate IFC ID, compatible object types, and confidence thresholds of 0.85. The text model cannot add a fault when the image observations contain no maintenance evidence. Such a photo becomes an inspection request with severity 1.

**Recognizing objects does not reveal the reporter's intended target.** A scene containing three or more substantial objects, where the proposed target occupies less than 25% of the image, is conservatively held for a closer photo. Pipes and valves do not count as separate substantial objects for this rule. This is a heuristic, not a calibrated accuracy score.

No model guarantees flawless recognition. The validation checks format and consistency; they cannot prove that every visual observation is true. MultiSet-to-IFC registration still needs its separate end-to-end validation.

## Provider compatibility

Live testing found that the fully bounded nested JSON schema was rejected by the provider. Requests now use strict required fields, types, enums and numeric bounds; code enforces the remaining length, pattern and array constraints. Temperature is 1, following Google's guidance for Gemini 3 models. Invalid or truncated JSON is rejected, not repaired into an accepted ticket.

References: [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), [Gemini temperature guidance](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3), [OpenRouter structured output](https://openrouter.ai/docs/guides/features/structured-outputs), [Flash-Lite](https://openrouter.ai/google/gemini-3.1-flash-lite), [Flash](https://openrouter.ai/google/gemini-3.8-flash).

## Database connections

| Purpose | Verified configuration |
| --- | --- |
| Knowledge vectors/API | **Supabase account 3**, project **ISTEA_Group1** (`ocamtlpixevrpcbcgrra`) |
| Knowledge SQL/publishing/verification | **CBM Supabase Postgres - ISTEA_Group1**, session pooler `aws-1-eu-central-1.pooler.supabase.com:5432` |
| Ticket/report/dispatch data | **Decision pending.** Existing `Postgres account 2` points to older project `wljuwuxclnmuknusthfm`, which has no CBM ticket tables. |

Both Supabase SQL and its REST API passed connection checks. SQL verifies the server certificate using Supabase's official CA. The CA is mounted through Docker Compose and n8n has been restarted to use it.

The CBM knowledge schema and the separate demo-document table are installed in ISTEA_Group1. Both libraries are currently empty. The approved-knowledge verifier returns `UNAVAILABLE` rather than supplying invented technical references. Existing generic tables were retained.

The bundled local database (`cbm-postgres:5432`, database `cbm_demo`) already contains the tested application schema. The pending choice is whether ticket/report data should use that database, move to ISTEA_Group1, or install the schema in the older project. No ticket-database migration or rebinding was inferred from the supplied credential names.

## Dispatch policy retained

At most five actionable tickets per batch: four newest plus a reserved older unfinished ticket. Each child agent execution is bound to one ticket. The portfolio contains a paginated overview of all non-closed tickets. The obsolete agent `create_ticket` tool and old helper references were removed again from the saved WF1 where an older draft had reappeared.

See [the dispatch explanation and complete get_context examples](../dispatch/READ-ME-DISPATCH.md). All 14 CBM drafts remain inactive. No real emails were sent and no CBM workflow was published. WF2's separate model configuration was not migrated by this WF1 update.

## Validation

- 12 vision/schema/graph tests, 20 dispatch regressions and 9 queue/context tests passed: **41 local tests**.
- The final live run made seven successful provider calls: three image observations, one image review, two text resolutions and one tool-call compatibility check.
- `IMG_7911.jpg`: radiator and small outlet recognized; radiator selected for the close-up.
- `IMG_7914.jpg`: electrical outlet recognized; missing outer faceplate and visible paint residue described.
- `IMG_7918.jpg`: radiator, outlet, chair and table recognized; target held for clarification after review.
- Both text resolutions passed against **synthetic IFC candidates and a synthetic pose**. These do not prove real spatial localization.
- Final run provider-reported cost: **US$0.00920475**. Earlier diagnostic requests are separate.
- The 14 saved drafts were read back and their nodes/connections matched the imported update. n8n health check passed.

Evidence: [final live results](../../validation-openrouter/model-results.json), [local vision tests](../../validation-openrouter/vision-tests.json), [installation verification](../../validation-openrouter/verification.json). Older diagnostic results are retained with descriptive filenames. Backups are in `validation-openrouter/before-workflows.json` and `validation-openrouter/before-deployment/`.

Deployment source: `C:\Users\USER\Desktop\n8n_deploy`. Rerunning `scripts/workflows/Prepare-CbmWorkflows.ps1` preserves the new model stages and knowledge bindings. It prepares files only; it does not publish workflows or resolve the pending ticket-database choice.
