"""Real PDFs: current/legacy template, no photo, ambiguous and corrupt evidence."""
import io
import sys
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from report_photo import extract_report_photo, ATTACHMENT


def pdf(images=(), attachments=()):
    stream = io.BytesIO()
    c = canvas.Canvas(stream)
    c.drawString(40, 780, 'The door was repaired and tested successfully by the technician.')
    for i, (colour, size) in enumerate(images):
        img = Image.new('RGB', size, colour)
        c.drawImage(ImageReader(img), 40 + i * 170, 400, width=150, height=150)
    c.save()
    if attachments:
        w = PdfWriter(clone_from=io.BytesIO(stream.getvalue()))
        for content in attachments: w.add_attachment(ATTACHMENT, content)
        stream = io.BytesIO(); w.write(stream)
    return PdfReader(io.BytesIO(stream.getvalue()))


class PhotoTests(unittest.TestCase):
    def test_absent(self):
        self.assertEqual(extract_report_photo(pdf())['photo_status'], 'NONE')

    def test_single_embedded(self):
        r = extract_report_photo(pdf([('red', (800, 600))]))
        self.assertEqual((r['photo_status'], r['photo']['page']), ('OK', 1))

    def test_small_logo_ignored(self):
        self.assertEqual(extract_report_photo(pdf([('red', (40, 40))]))['photo_status'], 'NONE')

    def test_multiple_images_ambiguous(self):
        self.assertEqual(extract_report_photo(pdf([('red',(800,600)),('blue',(800,600))]))['photo_status'], 'AMBIGUOUS')

    def test_duplicate_image_reused(self):
        self.assertEqual(extract_report_photo(pdf([('red',(800,600)),('red',(800,600))]))['photo_status'], 'OK')

    def test_bad_attachment_preserves_text(self):
        reader = pdf(attachments=[b'not an image'])
        self.assertEqual(extract_report_photo(reader)['photo_status'], 'ERROR')
        self.assertIn('repaired', reader.pages[0].extract_text())

    def test_duplicate_attachment_ambiguous(self):
        self.assertEqual(extract_report_photo(pdf(attachments=[b'1',b'2']))['photo_status'], 'AMBIGUOUS')

    def test_real_template_attachment_and_legacy(self):
        root = Path(__file__).resolve().parents[4]
        sample = root/'output/technician-report-qa/sample-report.pdf'
        reader=PdfReader(sample)
        r=extract_report_photo(reader)
        self.assertEqual((r['photo_status'],r['photo']['source']),('OK','PDF_ATTACHMENT'))
        w=PdfWriter(clone_from=sample)
        w.root_object.pop(NameObject('/Names'),None)
        stream=io.BytesIO();w.write(stream)
        legacy=extract_report_photo(PdfReader(io.BytesIO(stream.getvalue())))
        self.assertEqual((legacy['photo_status'],legacy['photo']['page']),('OK',2))


if __name__ == '__main__': unittest.main()
