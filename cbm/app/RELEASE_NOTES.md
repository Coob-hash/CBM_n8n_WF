# Release 2026.09.14 — review implementation

Created independently from `13_09_2026 release CBM`. No change was made to the predecessor's source, files or Git repository. This is a local inactive release; external activation and repository merges were not performed.

| Review IDs | Disposition |
|---|---|
| R1, R3, R4 | Tracked deterministic demo builder; no ignored before.json; environment-based source directory; full node-name and cross-workflow regression checks. |
| R2 | WF3, docs, test pins and all new source are included in this new release. PDFs are ignored/excluded from the archive. Previous repository/branch/main are untouched per the user's instruction. Remote merge and license confirmation remain pending. |
| X1, W1, W2 | PDF-first assignment instructions, lone-photo report reminder, real BEFORE alias, correct AFTER file/link. |
| X2, X3 | Shared IFC_SERVICE_URL; explicit radiator candidate classes and sample radiator. |
| A1–A5 | Parameterized intake SQL, Anthropic credential, strict triage failure routing, provider error branches, authenticated FM resume, duplicate notification and corrected intrinsics note; reviewed baseline re-pinned. |
| B1 | Bad OAuth client IDs rejected by the builder; copied private deployment settings omitted. Actual credential IDs remain deployment inputs. |
| B2, B3 | Late ordinary acknowledgement halts with UNCERTAIN; transactional stored routines remove multi-statement node result dependence. |
| B4 | Node versions inventoried; target n8n version/import unverified because no instance/version was supplied. |
| K1 | Separate building/published pointers; stable IFC property chunk identities. Published knowledge survives rebuilds within the documented observation freshness policy. |
| K2, K3 | Error notification workflow supplied/bound; one-hour timeout and 65-minute build lease. Native loader serialization still needs a real n8n/Supabase document run. |
| K4, K5 | Demo table/RLS/grants shipped and documented; database credential names normalized. |
| W3 | Explicit decision versus expiry, renewal loop, per-submission approval identity, persisted decision guards and fixed rejection reason. |
| W4–W7 | Guarded IFC helper with real persisted receipts, NULL on failure, truthful FM mail, parameterized report writes, strict intake status, missing-element skip and revised notes. |
| D1–D3 | Rome schedule/labels and ordered limits; TLS/IP allow-list example supplied. Deployment proxy changes remain site-specific. |
| S1, S2 | Cross-process lock, idempotent operation-key journal, atomic version publication/recovery, ultrawide plausibility lower bound. |
| S3 | Isolated Python 3.13 environment installed; real IfcOpenShell/FastAPI behavior and loopback HTTP endpoints smoke-tested with synthetic EXIF image/model/TXT. No case-study photo was supplied in the release. |
| DB1 | Explicitly freeze the unused cbm schema as a design study. No unrequested database cutover. |
| DB2, DB3 | Backfill/validate closed_at; unique open-element index with a clear refusal on historical duplicates. |
| C1, C2 | Current guides/configuration table, exact rebuild script, credential/path assertions, generated validation and node-version reports. Word guide explicitly labeled historical. |

Additional safeguards: throughput counting is idempotent; stale approval identities cannot close/reopen a later submission; uncertain FM email claims are not blindly retried. Existing advisory model-attempt budgets and technician-email delivery limitations are documented in the WF2 guide.

Validation details are generated in `validation/release-validation.json`; individual logs are in `output/validation/`. External n8n/Gmail/Anthropic/OpenAI/Mistral/MultiSet/Supabase acceptance is tracked in `deployment/acceptance.json` and is not claimed as completed.
