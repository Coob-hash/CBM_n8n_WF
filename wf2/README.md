# WF2 completion and approval — single-PDF submission, 2026.09.17

Build with `python wf2/build_wf2.py`; the builder applies `review_fixes.py` to the historical `original_wf2.json`. Use the root `rebuild.ps1` for the complete validation sequence.

Technicians upload one `TICKET-<id>.pdf` from the bilingual template, optionally including an AFTER photo. Standalone image uploads are ignored. Intake requires a technician and status ASSIGNED, WORK_DONE or REWORK. Missing/mismatched tickets notify the FM. See [PDF_SUBMISSION.md](PDF_SUBMISSION.md) for extraction rules and the revised canvas route.

PDF text is mandatory evidence. `Extract Report Text and Photo` calls the internal Python `/reports/extract` service using pypdf. It extracts the optional photo from the named PDF attachment, or from an older PDF containing one distinct eligible image. Scanned PDFs require a readable written replacement; the extractor grades them EMPTY. The report assessment proposes PENDING_APPROVAL, REWORK or NEEDS_TRIAGE. Code validates that recommendation and stores it in verification. The persisted ticket waits in PENDING_APPROVAL for the FM's independent decision, even when the recommendation is negative.

BEFORE file IDs are derived from the stored `photo_before_url` (`/d/<id>` or `?id=<id>`). AFTER evidence now comes from the PDF; there is no folder search or separate AFTER Drive ID. The report ID/link and verification JSON preserve its provenance. If a comparable BEFORE file is absent or its download fails, the report remains assessable with an explicit evidence limitation.

An explicit true/false FM payload is APPROVED/REJECTED. A missing payload is EXPIRED: record CBM_WF2_APPROVAL_EXPIRED, retain PENDING_APPROVAL, and loop to Gmail sendAndWait for renewed links. The current submission has an `approval_id`; a persisted CBM_WF2_APPROVAL with that identity is required by closure/rework SQL. Rejection reasons are fixed from the explicit decision and never invented by the agent.

The closure supervisor retains nine tools and an advisory budget of three attempts per operation. Three tools use two saved helpers under `wf2/workflows/`: guarded IFC writing and verified notification sending for both recipients. Missing GlobalIds and failed IFC writes block closure. The helper uses `wf2:<ticket>:<approval>` as operation_key and persists the actual result. Closure requires a matching successful result and model version. The final check additionally requires the statistics receipt and all current-approval Gmail send receipts. Incomplete objectives are recorded before the FM attention email. Uncertain sends are not blindly repeated. See [STRICT_CLOSURE.md](STRICT_CLOSURE.md).

Apply the root legacy SQL files in the order documented in README.md. The 27-table `database/` package is a design study, including incompatible report-only evidence guards, and is not a deployment prerequisite.

`test_wf2_nodes.mjs` checks exported Code behavior; `validate_wf2.py` checks graph structure. `test_migration.mjs` retains historical migration compatibility cases. The WF1, WF2 and WF3 suites in `rebuild.ps1` execute the current exported queries, expiry paths, authorization guards, IFC receipts and field references. Full live n8n/Gmail/model acceptance remains pending.
