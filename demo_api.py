"""Demo extension: keep all IFC routes and add bounded PDF report extraction."""
import base64
import binascii
import io
from pathlib import Path
from fastapi import HTTPException
from pydantic import BaseModel, Field
from pypdf import PdfReader
from report_photo import extract_report_photo
from ifc_service import app
from case_study import router as case_study_router

app.include_router(case_study_router)

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 200
MAX_TEXT = 100_000

@app.get('/reports/template')
def report_template():
    return {'html': (Path(__file__).parent / 'technician-portal.html').read_text(encoding='utf-8')}

class ReportRequest(BaseModel):
    pdfB64: str = Field(min_length=8, max_length=4 * ((MAX_BYTES + 2) // 3))

@app.post('/reports/extract')
def extract_report(request: ReportRequest):
    try:
        raw = base64.b64decode(request.pdfB64, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(422, 'Report must contain valid base64 PDF bytes') from None
    if len(raw) > MAX_BYTES or not raw.startswith(b'%PDF-'):
        raise HTTPException(422, 'Expected a PDF no larger than 20 MiB')
    try:
        reader = PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            raise HTTPException(422, 'Provide an unencrypted completion report')
        pages = len(reader.pages)
        if pages > MAX_PAGES:
            raise HTTPException(422, 'Report exceeds 200 pages')
        parts, length = [], 0
        for page in reader.pages:
            text = page.extract_text() or ''
            length += len(text) + 1
            if length > MAX_TEXT:
                raise HTTPException(422, 'Extracted report exceeds 100000 characters')
            parts.append(text)
        # Image failures must not discard otherwise readable report text.
        photo = extract_report_photo(reader)
        return {'text': '\n'.join(parts).strip(), 'numpages': pages, 'parser': 'pypdf', **photo}
    except HTTPException:
        raise
    except Exception:
        # The caller records PARSE_ERROR; never return invented report text.
        raise HTTPException(422, 'PDF could not be parsed; provide a readable text-based report') from None
