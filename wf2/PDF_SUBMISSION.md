# WF2: one PDF submission

Upload `TICKET-<id>.pdf` from the Italian-English technician template. It contains the written report and optional AFTER photo. Standalone image uploads are ignored; there is no separate Drive image search or upload-order requirement.

## Canvas route

Existing Drive trigger and ticket validation → Download Report PDF → Extract Report Text and Photo → Photo Available?

- A readable report with a usable AFTER photo and a BEFORE reference → Download BEFORE Photo → Prepare Verification Images → Verification Images Ready? → existing vision chain → Build Assessment Input.
- No photo, unreadable/ambiguous image, no BEFORE reference, or failed BEFORE download → Build Assessment Input, with an explicit evidence limitation.
- Both routes → written assessment → FM approval. Ticket closure still requires an explicit FM decision.

## Python response and provenance

`POST /reports/extract` retains `text`, `numpages`, `parser` and adds `photo_status`, `photo`, `photo_count`, `photo_error`. `photo_status` is `OK`, `NONE`, `AMBIGUOUS` or `ERROR`. Only `OK` carries a JPEG payload. Image-extraction failures do not discard valid report text. A PDF/text failure remains a 422 response, recorded as `PARSE_ERROR` in n8n.

The template's named `cbm-after-photo.jpg` PDF attachment identifies the selected AFTER photo. Earlier PDFs are supported when exactly one distinct image with both dimensions at least 128 pixels is present. Multiple distinct images without the named attachment are ambiguous; the service does not guess which is AFTER. A small decorative image is ignored by this legacy fallback. Use the supplied template for reliable identification, especially when adding logos. The vision chain must still verify that the photo shows the correct asset.

Limits: 20 MiB PDF, 200 pages, 100,000 extracted characters; 10 MiB photo, 24 megapixels, at most 12 inspected page-image occurrences. Returned images are JPEGs scaled to at most 1600 pixels per dimension. This is extraction, not OCR.

The extracted image is n8n binary data, not a new Drive file. `after_file_id` remains null. The existing `verification` JSON records photo status/source/page/error and the vision verdict; the PDF's `report_file_id` and link remain the durable evidence reference for the FM.

## Rebuild and tests

`apply-report-submission.cjs` is an idempotent overlay used by preparation and the WF2 builder. It retains the saved model/credential choices when applied to a current export. The original builder still reconstructs its baseline, so use the current workflow export when preserving manual canvas changes.

- `python cbm/app/wf2/test_pdf_photo.py`: real template and legacy PDFs, absent/duplicate/ambiguous/corrupt images.
- `node cbm/app/wf2/test-pdf-submission.cjs`: the exported node code, both evidence branches, API errors and provenance.

The Python image must be rebuilt and `ifc-service` recreated after changing the extraction code. Saving the n8n draft alone does not update the service.
