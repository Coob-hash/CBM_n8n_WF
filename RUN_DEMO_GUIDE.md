# Run the CBM office demo

**Current runbook — 17 September 2026.** This guide describes the installed single-ticket workflows and the new bilingual technician report page. Use it for the next demonstration; the older deployment tutorial is historical installation material.

## 1. What is ready, and what still needs setup

| Component | Verified state | Next action |
|---|---|---|
| Docker, n8n, local PostgreSQL, Python IFC/report service | Running; business tables and functions installed | Start/check them using section 3 |
| Office IFC | `office_v1.ifc`, 13 maintainable assets | Use the matching office photos and map |
| Google Drive account 2 | OAuth refresh/profile check now succeeds | Confirm access to both folders below; no live upload was made during development |
| Gmail account 3 | Connected; all application Gmail nodes are bound to this credential | Use it for the controlled email steps below |
| MultiSet map | `MAP_J964JX6MGEGO` configured; you can see it in the portal | Credentials section is empty: create/bind a Query credential and verify an API query |
| MultiSet-to-IFC alignment | Not completed: `approved: false`, `matrix: null` | Measure and validate the transform; section 5 |
| OpenRouter, Anthropic, OpenAI, Supabase | Read-only authentication checks succeeded | Existing bindings retained; this was not an end-to-end model run |
| Technician | One active demo identity: `giuseppe.desiderio123@gmail.com` | Ready for dispatch once the earlier steps work |
| Technician report page | Implemented, imported into n8n, inactive | Publish with the other demo entry workflows after setup |
| WF1 / WF2 / WF3 | Saved, inactive at verification | Follow section 6 |
| WF3 public chat | Basic Auth credential missing | Configure before publishing WF3 |
| Optional technical-sheet OCR import | Mistral credential returned 401 | Repair only if demonstrating that separate import route |

**A full successful photo-to-closure demonstration is not ready yet. MultiSet API access and map alignment are the remaining core setup tasks.** Repeated uploads while those are missing would consume the report's retry allowance without resolving the cause.

The demo database currently has no maintenance tickets or technician submissions. Development tests used synthetic fixtures outside the live business tables; no real report was uploaded and no email was sent.

## 2. The system at a glance

```text
Original photo → incoming Drive folder → WF1
  → Python image preparation → MultiSet localization → Python IFC matching
  → vision observations + asset/issue validation
  → ticket → FM authorization → dispatch → technician acceptance

Assignment email → technician web form + optional photo
  → one PDF → completed Drive folder → WF2
  → Python text/photo extraction → assessment → FM completion approval
  → verified IFC version → ticket closure → recorded notifications

WF3 → FM questions and weekly summary of the stored results
```

### Local services and external services

This is **one Docker Compose project with several containers**. Services reach one another by Compose service name; `localhost` inside a container refers to that container.

| Service | Address used by n8n | Purpose |
|---|---|---|
| n8n | Public HTTPS address below; local editor `http://localhost:5678` | Triggers, web pages, approvals, agents, helper workflows |
| CBM PostgreSQL | `cbm-postgres:5432`, database `cbm_demo` | Tickets, reports, offers, claims, events and receipts |
| Python IFC/report API | `http://ifc-service:8000` | Image metadata, IFC candidates, PDF extraction, report template, IFC maintenance updates |
| Knowledge API | `http://knowledge-service:8001` | Approved asset/document snapshot |
| Task runners | Internal n8n runner connection | Executes Code nodes |
| ngrok | Forwards the public HTTPS domain to `n8n:5678` | Lets email links reach this computer |
| MultiSet cloud | `https://api.multiset.ai` | Localizes the photograph in the existing map |
| Google Drive / Gmail | Google APIs | Stores files / sends notifications and approval messages |
| Model providers / Supabase | External APIs | AI inference, embeddings and approved knowledge retrieval |

The `ifc-init` container performs initialization and normally exits successfully. It is not a web service that must stay running. n8n's own workflow/credential database is separate from the CBM ticket database.

### Addresses and folders

- [Open n8n](https://bonanza-progress-hangover.ngrok-free.dev).
- [Incoming photographs](https://drive.google.com/drive/folders/199SEqJvMdyufnea4zrwabimyztWTDYJ7).
- [Completed technician reports](https://drive.google.com/drive/folders/1M0uJMr10KQBJPDp6aua1cgkOwXqWbmeC).
- FM: `gruppo1isteagiovani@gmail.com`.
- Reporter/technician for the demo: `giuseppe.desiderio123@gmail.com`.
- MultiSet map: `MAP_J964JX6MGEGO`.

When a node asks for a Drive folder ID, enter only the identifier after `/folders/`. The two folders serve different stages.

## 3. Start the existing installation

1. Start Docker Desktop and wait for its engine to be ready.
2. Open PowerShell **7.3 or later**. If your current terminal is Windows PowerShell 5.1, this opens the bundled newer shell:

```powershell
& 'C:\Users\USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' -NoProfile
```

3. In that shell, run:

```powershell
Set-Location -LiteralPath 'C:\Users\USER\Desktop\n8n_deploy'
.\Cbm-Compose.ps1 up -d
.\Cbm-Compose.ps1 ps -a
.\Test-Cbm.ps1
```

The wrapper supplies both environment files and the correct Compose project. Check the output for n8n readiness, Python health, the 13 office assets and PostgreSQL tables. `registration verified: False` remains a real missing prerequisite even if the infrastructure checks pass.

Ordinary startup needs no workflow rebuild or import. `Prepare-CbmWorkflows.ps1` produces files; it does not update the workflows already saved in n8n. Avoid running old import packages over your edited main workflows.

Keep this computer, Docker and ngrok running while a person opens an approval or report link. If the ngrok domain changes, generated email/form URLs and OAuth redirect configuration must be updated together.

## 4. Finish the Google connection

Drive and Gmail use separate saved credentials. Drive succeeding does not prove Gmail works.

### Google Drive account 2

Open this saved credential and confirm the connected Google account can open both folder links. WF1 reads the incoming folder; WF2 reads the completed folder; the portal must also be able to create a file in the completed folder. The recent check proved authentication, not a live write.

### Gmail account 3

This saved credential is connected and all Gmail nodes in the 15-workflow application are bound to it. If Google access is revoked later, reconnect **Gmail account 3** in n8n; do not replace the credential reference in individual nodes. See [n8n's Google OAuth setup](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service).

The Gmail sender can differ from the FM recipient. During the demo, inspect the sender's Sent folder as well as the FM and technician inboxes. A normal reply saying “yes” is not parsed by this implementation: use the action links/buttons supplied by the workflow.

## 5. Configure MultiSet together

### A. API credentials

Your email identifies the account, and the map code identifies the map. The workflow additionally needs a **Client ID and Client Secret**.

1. Sign in to the [MultiSet Developer Portal](https://developer.multiset.ai) with your account.
2. Check that `MAP_J964JX6MGEGO` belongs to, or is accessible by, that account and is ready for localization.
3. Open **Credentials → Create New**, give the credential a demo name and enable **Query** scope. Save the Client ID and Secret directly into n8n; the secret is shown at creation. See [MultiSet credentials](https://docs.multiset.ai/multiset/fundamentals/credentials).
4. In WF1, open **MultiSet - Get Token**, create/select an **HTTP Basic Auth** credential: Username = Client ID; Password = Client Secret. Use a descriptive saved name such as `CBM MultiSet - Office Demo`.
5. The node already uses `POST https://api.multiset.ai/v1/m2m/token`. Its result supplies the bearer token used by **MultiSet - Localize Snapshot**. Do not put the website password in this credential. See [MultiSet authentication](https://docs.multiset.ai/multiset/fundamentals/rest-api-docs/authentication).
6. Verify token acquisition, then a single controlled query against the configured map. Token success alone does not prove the photograph localizes correctly.

Once the credential is saved, also record its n8n ID/name in `cbm/app/runtime-bindings.json` under `credentials.multisetBasic` in the source and deployment copies, so later preparation preserves the binding. The binding file stores the reference, not the secret.

### B. Align the map with the IFC model

MultiSet returns a camera pose in its map coordinates. The IFC has its own origin and orientation. The Python service needs a measured transform to compare them correctly.

A proposed registration was measured on 17 September: MultiSet `(x,y,z)` maps to IFC `(x,-z,y)`. Seven scan stations match within 0.00000063 m, and independent checks across 21 structural elements have a median surface difference of 0.0277 m. See `validation-registration-fix/registration-validation.json`. The user approved this measured registration and it was enabled on 17 September. The live service reports `registration_verified: true`; replaying execution 280 gives four IFC candidates. Future registration/configuration faults pause without consuming photo attempts.

The installed registration file now contains the measured matrix and approval evidence. The service reads it on each request, so no container rebuild was required. To inspect it:

```powershell
.\Cbm-Compose.ps1 exec -T ifc-service python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/case-study/status").read().decode())'
```

The response must identify this map and matching IFC source, with `registration_verified: true`. That flag confirms the configured transform is accepted; the separate measured checks establish whether it is accurate. This demo alignment was measured, approved and verified on 17 September; reassess it if the map or model coordinate frame changes.

## 6. Prepare n8n for the demonstration

The installed project now has **15 workflows: three main workflows, eleven existing supporting workflows and the new technician portal**. No additional imports are needed for this update.

| Workflow | How to use it |
|---|---|
| [WF1 — Ticket Intake & Dispatch](https://bonanza-progress-hangover.ngrok-free.dev/workflow/YZb99Du8CBtsSy7f) | Publish after Gmail, MultiSet and alignment are ready |
| [WF2 — Completion, Approval & IFC Update](https://bonanza-progress-hangover.ngrok-free.dev/workflow/5quLJucpa0K4jWZS) | Publish to watch newly uploaded completed reports |
| [Technician Report Portal](https://bonanza-progress-hangover.ngrok-free.dev/workflow/cbmTechnicianPortal20260917) | Publish to register its production GET/POST webhooks |
| [WF3 — Facility Manager Dashboard](https://bonanza-progress-hangover.ngrok-free.dev/workflow/658IWGwRtDMsPri7) | Configure the chat Basic Auth credential before publishing; publication also enables the weekly schedule |
| Called helper workflows | Keep the imported IDs and save changes; parents invoke them through Execute Workflow/tool calls |
| Knowledge sync/error workflows | Separate supporting pipeline; enable its scheduled route when demonstrating knowledge synchronization |

Save the current versions before publishing. Refreshing an editor displays saved changes; it does not publish a workflow. The portal and updated assignment/rework helpers are already installed. WF1, WF2 and WF3 were not overwritten by the portal installation.

Production email links use `/webhook/…`. `/webhook-test/…` is a temporary test listener and is unsuitable for the full asynchronous demo. A report URL without its valid ticket/token is deliberately unavailable.

### Technician identity

The controlled email is now active with demo skills and zone `building-A`. One identity is enough for the complete acceptance path. PostgreSQL makes technician email unique, so using the same email twice means the same person. The setup command now handles this correctly:

```powershell
.\Set-CbmDemoTechnicians.ps1 -Email1 'giuseppe.desiderio123@gmail.com'
```

There is no need to rerun it now. A two-person competition scenario would need two distinct controlled addresses/aliases. The old fictitious technicians remain inactive.

## 7. Run WF1: photo to assignment

### Step 1 — Prepare one original photograph

Use a photograph of the mapped office that corresponds to the IFC. The case-study script preserves the original JPEG/EXIF and gives it a report UUID:

```powershell
.\Prepare-CaseStudyPhotos.ps1 -ReporterEmail 'giuseppe.desiderio123@gmail.com' -Photo 'IMG_7911.JPG'
```

Open the printed subfolder under `cbm\case-study\upload-ready`. Upload **only that one generated photo** into the incoming Drive folder after WF1 is published. Its filename has this structure:

```text
report_<reporter-email>_<report-UUID>_<photo>.jpg
```

The angle-bracket names above explain the structure; the script writes actual values. Avoid screenshots, messaging-app recompression and panoramas for this calibrated case-study route. The current camera data is an audited EXIF estimate, not factory calibration; live localization remains a validation step.

### Step 2 — Inspect the intake execution

The Drive trigger polls every minute. In WF1's **Executions**, follow the newly received file:

1. **Drive Trigger - New Snapshot** passes uploaded file items directly to **Capture Input** in the same execution. Phase A uses each item and its linked metadata, so a poll containing several photos keeps their files, reporters and reports separate. There is no self-call or waiting parent execution.
2. **Capture Input → Check IFC Registration → Claim Capture Attempt → Capture Accepted?** validates the filename and uses PostgreSQL to claim the report attempt. The Drive file ID prevents duplicate processing. A configuration-paused file can resume once registration is repaired; concurrent executions cannot claim the same file twice. After the diagnosed execution-283 framing-rule correction, that retained file was also made resumable without consuming an attempt.
3. **Download Snapshot → Prepare Image & Metadata → Capture Normalized?** gets the image and prepares its metadata through Python.
4. **MultiSet - Get Token → MultiSet - Localize Snapshot → Confidence Gate** obtains and checks the camera pose.
5. **Find IFC Element → IFC Candidates Available?** uses Python and the registered pose to find plausible IFC assets.
6. The observation chain adds image context. **Vision Clear?** rejects unclear evidence. **Match IFC Asset and Describe Issue** checks the candidate object and describes/classifies the issue. Structured parsers validate the model outputs.
7. **Submit Ticket for FM Authorization** calls `cbm_capture_identified()`; ticket creation/reuse happens through `cbm_create_ticket()`.

At this point the report should be `IDENTIFIED` and the ticket normally `PENDING_AUTHORIZATION`. A report is the photo session; a ticket is the maintenance job. Earlier localization failures create attempts on the report, not a new maintenance job each time.

### Step 3 — Act as the FM: authorize the intervention

Open the authorization message at `gruppo1isteagiovani@gmail.com`. Open the supplied link and submit the confirmation form. Merely opening a page does not authorize dispatch.

After ticket creation, WF1 immediately claims and sends that ticket's FM authorization email, including the secure approval link, and records Gmail's receipt. The separate submitter receipt is informational and cannot authorize the intervention. Recovery runs every minute to deliver outstanding notifications; if no ticket is eligible for dispatch, only the dispatch branch stops. If authorization remains pending, recovery queues one reminder 24 hours after the original email was sent; expiry after 72 hours creates a fresh link.

- Approve: PostgreSQL records authorization and the ticket becomes eligible for dispatch (`LOCALIZED`).
- Reject: the request becomes `REJECTED`; no offer should be sent.

This first FM decision authorizes starting the maintenance intervention. WF2 later asks for a separate decision about the completed work.

### Step 4 — Let the Dispatch Agent work

Authorization callbacks and the minute recovery tick can start Phase B. **Claim One Dispatch Ticket** binds one ticket to the execution. The agent reads that ticket's context, initializes its eligible shortlist, sends the opening notice and offers, and processes persisted responses. The overview can show other tickets; mutation tools remain scoped to the selected ticket.

The agent finishes when no immediate action remains. It does not sit running while a technician is deciding. A response or a later recovery tick resumes processing.

### Step 5 — Act as the technician: accept

Open the offer in `giuseppe.desiderio123@gmail.com`, select acceptance and submit its confirmation page. WF1 records the response, chooses the valid winner and updates the ticket to `ASSIGNED`.

Wait for the assignment confirmation. **That email contains “Compila il rapporto / Complete technician report”.** Keep the personal link; it is the entry point for section 8. An accepted offer and a completed assignment are separate checkpoints.

### If identification fails

The retry email contains the existing report UUID. Preserve it when preparing a replacement:

```powershell
$reportId = Read-Host 'Paste the report UUID from the retry email'
.\Prepare-CaseStudyPhotos.ps1 -ReporterEmail 'giuseppe.desiderio123@gmail.com' -Photo 'IMG_7915.JPG' -ReportId $reportId
```

Upload the resulting replacement as a **new Drive file**. A new UUID creates a different report; the same email alone does not group photos. Each accepted photo has its own execution but shares the report counter.

Registration and IFC-service configuration faults instead enter `CONFIGURATION_REQUIRED`: they do not consume a photo attempt or request a replacement photo. Repair the configuration and run the SAME Drive file through WF1 again. The retained file ID and report are reused, with pause/resume history stored in `cbm_capture_configuration_events`.

**The installed limit is one original plus three replacements: four attempts total.** If all four fail, the report becomes `IT_ISSUE` and the IT notification is queued. Do not upload all replacements together: wait for the result before selecting a useful new view.

For duplicate jobs, the same source file reuses its ticket; an already-open ticket for the same IFC GlobalId is also reused. A closed/rejected/duplicate ticket does not block a later new report on that asset.

## 8. Submit the technician report through the new page

### What the technician does

1. Open the report link in the assignment email. It expires after 30 days and is tied to the assigned technician and ticket.
2. Check the prefilled ticket, technician and asset details. Those fields come from PostgreSQL and are read-only.
3. Fill in the work date, findings, work performed, materials, checks, outcome and any remaining issues. The form uses Italian and English labels.
4. Optionally attach one intervention photo and describe what it shows. The image limit is 10 MiB; the browser resizes the image before embedding it.
5. Confirm the declaration and press **Invia rapporto / Submit report**. Reloading before submission discards unsent edits.
6. Wait for the successful submission page. It means the PDF was uploaded for review; it does not mean the ticket is closed.

The browser generates `TICKET-<id>.pdf` containing the written report and optional photo. The portal validates the current assignment, checks required content against the PDF, claims one submission for the current approval cycle and uploads to the completed Drive folder. The PDF limit is 8 MiB. A repeat submission does not blindly create a second file.

### How WF2 receives it

The **Completed Upload (Drive Trigger)** sees the PDF within its polling interval. No Gmail attachment ingestion was added. Gmail delivers the links and notifications; Drive remains the input to WF2.

The two public portal routes use the same path, `/webhook/cbm-technician-report`: GET displays the authenticated form and POST submits it. The ticket-specific token is supplied by the email. The link is personal and should not be shared as a generic demo URL.

### Manual fallback

Open `cbm/templates/technician-report/technician-report.html` from the release or deployment folder. This editable offline form generates a PDF with the photo. Enter the real assigned ticket ID, download its `TICKET-<id>.pdf`, then upload that PDF to the completed folder. The offline form does not perform the portal's assignment validation and duplicate claim.

You can attach the PDF to a human email if useful, but sending it through Gmail alone will not start WF2. The existing blank PDF is a printable example; the HTML form is the editable template.

## 9. Run WF2: report to verified closure

| Stage / nodes | What to inspect |
|---|---|
| Extract Ticket ID → Fetch Ticket → Ticket Open and Assigned? | Filename resolves to the intended ticket; it has a current technician |
| Download Report PDF → Extract Report Text and Photo | Python `/reports/extract` returns text, page count, extraction quality and available photo evidence |
| Photo Available? / Verification Images Ready? | A missing intervention photo is explicit. Comparison runs only with usable images |
| Assess Completion (Report) → Parse Completion Assessment | Written evidence is assessed; lack of visual evidence remains visible |
| Set Pending Approval → FM Approval (Email + Wait) | Ticket is `PENDING_APPROVAL`; FM receives the second approval request |
| Persist FM Decision → Closure Supervisor | Tools act on the recorded decision and current approval cycle |
| log_ifc_maintenance | Calls the **WF2 Guarded IFC Write** helper; Python writes and verifies the new IFC version |
| close_ticket / update_technician_stats / notification tools | Records closure/statistics and sends the required FM and technician notices |
| Verify Closure Outcome → Closure Settled? | Verifies all required stored outcomes and email receipts |

### FM approves completed work

Use the new approval message's controls. The closure supervisor must record a successful IFC update and a real new version before closing the ticket. Successful completion should show `CLOSED`, a nonempty `ifc_new_version`, the current approval's successful IFC event, updated statistics and both required notification receipts.

An IFC error blocks closure. A closed ticket with a missing notification receipt is still an **unsettled workflow outcome** and requires attention. An API receipt confirms Gmail accepted the send; it is not proof that a person read the email.

### FM asks for rework

Rejection of completion changes the ticket to `REWORK`. The technician notification includes a report link for the revised work. After the correction, submit a new report for that approval cycle and let WF2 request another FM decision. The portal permits the new cycle while preserving the previous submission history.

## 10. Use WF3 at the end

Configure the **FM Chat** Basic Auth credential before exposing the chat. Ask concrete questions such as “Show ticket 1 and its history” or “Which tickets still need attention?” The dashboard tools read stored facts; they do not assign or close tickets.

The weekly route collects data, creates report tables, adds a narrative and sends the styled email. Its configured schedule is **Monday at 07:00, Europe/Rome**. A manual run that reaches **Email Weekly Report** sends a real message. For a preview, stop before that node and inspect **Compose Weekly Email**.

The approved knowledge library is a separate feature. An empty approved library is possible; do not treat an unrelated technical sheet as evidence for the office asset. The optional OCR import currently needs its Mistral credential repaired.

## 11. Inspect the database and services

From the deployment PowerShell shell, enter an interactive database session:

```powershell
.\Cbm-Compose.ps1 exec cbm-postgres psql -U cbm_app -d cbm_demo
```

Run these read-only queries. They omit bearer tokens and email bodies:

```sql
SELECT id, status, ifc_name, technician_id,
       dispatch_authorized_at, ifc_new_version, created_at
FROM tickets ORDER BY id DESC LIMIT 10;

SELECT id, reporter_email, state, attempts, ticket_id
FROM cbm_intake_reports ORDER BY created_at DESC LIMIT 10;

SELECT report_id, attempt, status, reason, file_id
FROM cbm_capture_attempts ORDER BY started_at DESC LIMIT 10;

SELECT ticket_id, approval_cycle, status, drive_file_id, submitted_at
FROM cbm_technician_submissions ORDER BY created_at DESC LIMIT 10;

SELECT ticket_id, event, created_at
FROM ticket_events ORDER BY id DESC LIMIT 30;
```

To inspect SQL function definitions:

```sql
\sf cbm_capture_begin
\sf cbm_capture_failed
\sf cbm_technician_report_access
\q
```

Read the last service logs without restarting anything:

```powershell
.\Cbm-Compose.ps1 logs --tail 60 n8n ifc-service cbm-postgres
```

Use n8n's execution data to inspect the selected ticket, diagnostic reason, model output, helper result and settled check. Avoid sharing complete node dumps containing images, private links or credentials.

## 12. Troubleshooting at the relevant checkpoint

| Symptom | Check / next action |
|---|---|
| No execution after uploading | WF1/WF2 published, correct watched folder, valid Drive credential, new file, next poll |
| Email link returns webhook 404 | Corresponding workflow published, production `/webhook/` URL, current ngrok domain |
| Drive works but email fails | Reconnect **Gmail account 3**, not the Drive credential |
| MultiSet token 401/403 | Client ID/Secret, active credential/account and scope; account email is not the API username |
| Token works but localization fails | Map access/readiness, original image and intrinsics, query response; inspect failure reason |
| Registration required / no trustworthy IFC match | Complete measured map-to-IFC alignment; no forced bypass |
| Another photo creates another session | Reuse the original report UUID in the new filename |
| Dispatch escalates without an offer | Check active technician, required skill, zone, capacity and stored eligibility reason |
| Report page unavailable | Valid personal link, unexpired token, accepted current assignment, ticket status |
| Report already submitted | Inspect the completed Drive folder and WF2 execution; do not upload another copy blindly |
| Submission “unconfirmed” | An upload may have succeeded without its receipt. Reconcile the Drive file and submission row before resetting/retrying |
| PDF unreadable / empty | Inspect extraction error; submit the generated report with actual written content |
| No intervention photo | Report still proceeds with limited evidence; FM decides whether rework is necessary |
| IFC error after FM approval | Ticket must stay unclosed; inspect Guarded IFC Write and Python logs |
| CLOSED but Closure Settled? is false | Inspect missing receipts/statistics/current approval proof; status alone is insufficient |

## 13. Finish a demonstration and restart later

Record the report UUID, ticket ID, important execution IDs and final IFC version. Unpublish the entry workflows when you want to stop new trigger activity; existing waiting executions need separate attention. To stop the local services while retaining their volumes:

```powershell
.\Cbm-Compose.ps1 stop
```

Start again with section 3. Keep existing database and IFC volumes. A new valid report on an asset whose earlier ticket is closed can create a new maintenance ticket; do not erase the database between demonstrations merely to obtain a new ID.

## 14. What was implemented and tested in this update

- Added the bilingual web portal workflow and Python template endpoint.
- Added ticket-bound report links to existing assignment and rework notifications.
- Added persistent submission claims and Drive receipts, with one submission per approval cycle.
- Preserved the existing main workflows and WF2's strict IFC/notification completion rules.
- Fixed the technician setup script so a repeated email uses one identity; configured your controlled address.
- Passed 32 portal checks covering authorization, expiry, assignment, duplicate/rework behavior and workflow construction; dispatch and strict-closure regression checks also passed.
- Tested text submission inside a sandboxed browser frame. Generated PDFs with and without a photo passed the actual Python extractor and portal validator; rendered PDF pages were visually checked.

**Validation boundary:** the browser automation could not operate the photo file picker reliably, so a real user photo selection followed by a live Drive upload remains an acceptance test. No full MultiSet/Gmail/Drive maintenance lifecycle was claimed or executed. The new portal remains inactive until the demonstration is enabled.

## WF1 direct intake and vision correction — 17 September

`Process Each Drive Capture` and `One Capture Input` were removed. The Drive trigger now connects directly to `Capture Input`; the current execution continues through Phase A. This removes the waiting parent/child pair. A direct connection does not change n8n's deployment concurrency limits or make the current execution finish before its model calls.

Execution 283 returned a valid image observation: image quality good, radiator selected, no target ambiguity. The JavaScript validator incorrectly counted floor tiles and skirting as competing objects. The corrected guard considers substantial alternative maintenance targets, preserves confidence/ambiguity/schema checks, and exposes `visionChecks` so the decision is inspectable. The selected models and prompts were preserved.

Validation: 12 vision regression cases; real n8n execution with three photos in one batch, the existing LLM Chain and Structured Output Parser nodes, isolated PostgreSQL and local provider simulators. Two clear files reached FM authorization with the correct assets/reporters, the unclear file requested a replacement, and duplicates made no extra provider calls. No live ticket or email was created by these tests.

## MultiSet DNS and provider failures

The two MultiSet HTTP nodes retry a transient DNS/network failure four times, waiting two seconds between attempts. If all attempts fail, `Pause for MultiSet Service Error` records `MULTISET_SERVICE_UNAVAILABLE`. PostgreSQL changes the report to `CONFIGURATION_REQUIRED`, restores the reserved photo allowance and retains the same Drive file. Run that same file again after the provider or network recovers; a replacement photograph is not required.

Execution 284 failed because Docker temporarily could not resolve `api.multiset.ai`. Host and container DNS subsequently resolved the name, and authenticated map metadata was read successfully. The attempt recorded by execution 284 was restored. The existing execution remains in history for diagnosis.
