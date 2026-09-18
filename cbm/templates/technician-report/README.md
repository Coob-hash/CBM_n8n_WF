# Rapporto del tecnico / Technician report

## Modulo utilizzabile ora / Ready-to-use form

Aprire `technician-report.html` nel browser. Funziona localmente, senza server o connessioni esterne. Compilare i campi, aggiungere facoltativamente una foto e scaricare il rapporto PDF. Le etichette sono in italiano e inglese; i testi liberi possono essere scritti nella lingua scelta dal tecnico.

Open `technician-report.html` in a browser. It works locally with no server or external connections. Complete the fields, optionally attach one photo, and download the PDF. Labels are bilingual; the technician can write free-text answers in either language. The form does not translate those answers.

The printable blank PDF is `output/pdf/CBM_Technician_Report_IT_EN.pdf` in the project workspace. It is a paper/layout template, not an interactive PDF form. For the current demo, use the HTML form to produce a completed text-readable PDF; do not upload the empty template.

### Foto / Photo

- One optional AFTER photo inside the submission PDF.
- Accepts JPEG, PNG or WebP up to 10 MiB. The form prepares a JPEG with a maximum dimension of 1600 pixels and includes it in the report.
- The caption is required when a photo is attached. The photo should identify the same asset as the ticket and show the intervention result.
- The PDF displays the photo and contains a named `cbm-after-photo.jpg` attachment for reliable extraction. The optional JPG-copy button is for personal use; WF2 requires only the PDF.
- Photos and field values stay in the page until a download is requested. They are not sent to n8n, Drive, an AI model or another service. Closing/reloading the page discards the form values.

### Demo WF2

1. Complete the form and optionally choose an AFTER photo.
2. Download and upload `TICKET-<id>.pdf` to the completed-files Drive folder.
3. WF2 extracts text and the optional photo from that PDF, assesses the evidence and requests the Facility Manager's decision.

Caricare un solo PDF, con o senza foto. / Upload one PDF, with or without a photo. A standalone JPG is ignored. The template does not activate WF2 or bypass its credential requirements.

## Riutilizzo nell'app / Reuse in the future app

`submission.schema.json` defines the proposed report fields, independently of the layout. `report-pdf.js` is the shared PDF renderer. `form.source.html` is the readable UI source; `technician-report.html` bundles the renderer and pdf-lib so it can run offline. The pdf-lib MIT licence is retained in `pdf-lib-LICENSE.md`.

### Data supplied by the application

The app should prefill and lock the ticket number, technician identity, asset, location and original issue. Bind these to the authenticated technician and the selected assigned ticket on the server. The manual fields are editable in this demo only because no application exists yet.

The technician supplies the work date, findings, actual actions, materials, checks, declared outcome, remaining issues, confirmation and optional photo/caption. Trim strings, reject whitespace-only required answers and validate lengths/formats on the server as well as in the UI.

### Suggested submission handling

Receive the structured fields plus the photo as an attachment (multipart upload or a server-issued upload reference). Validate the assignment, attachment content, size and ticket association. Assign the submission ID, authenticated technician ID and submission timestamp on the server. These server-owned values should not be supplied as editable technician fields.

Generate the report PDF from the same saved fields. For the Drive demo, upload that single PDF; the renderer includes its photo as a visible image and a named PDF attachment. A future API adapter can pass stored report and image references directly to the assessment workflow; that adapter is not implemented by this template.

`outcome=COMPLETED` means **the technician declares the work completed**. It must never directly set `tickets.status=CLOSED`, create an approval decision, update the IFC model, or replace the FM approval process. `PARTIAL` and `NOT_COMPLETED` are report outcomes, not ticket status names.

### Notes for implementation

- Keep the original photo securely with the submission if full-resolution evidence is needed; the downloadable JPG is resized for this demo.
- The renderer uses standard PDF fonts with Latin character coverage, suitable for Italian and English. Unsupported characters produce an export error rather than being silently removed. Add an appropriately licensed Unicode font when extending the app to other scripts.
- The current UI has download actions only. It has no login, submission API, draft persistence or ticket-mutation capability.

## Verifica / Verification

The blank PDF, a populated report with a sample attachment and long-text pagination are checked locally. PDF text extraction uses `pypdf`, matching the library used by the current report-extraction service. Browser verification covers required-field validation and PDF export. Photo embedding is verified through the shared PDF renderer. Automated file selection was blocked by the Chrome extension's file-URL permission, so the browser photo preview, conditional caption validation and separate JPG download have not been verified end to end; the manual photo picker remains available. No report is uploaded to the live demo during these checks.
