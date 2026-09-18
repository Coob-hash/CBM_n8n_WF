import base64
import unittest

import fitz

import service


class AdapterTests(unittest.TestCase):
    def test_pdf_render_and_validation(self):
        document = fitz.open()
        page = document.new_page()
        page.insert_text((72, 72), "CBM test")
        data = document.tobytes()
        document.close()
        encoded = base64.b64encode(data).decode("ascii")
        self.assertEqual(service.decode_pdf(encoded), data)
        rendered = service.render_pages(data)
        self.assertEqual(len(rendered), 1)
        self.assertTrue(rendered[0].startswith("data:image/jpeg;base64,"))

    def test_grounding_is_cleaned_and_figures_are_explicit(self):
        raw = (
            "<|det|>title [10, 20, 300, 60]<|/det|># Pump manual\n"
            "<|det|>text [10, 80, 900, 120]<|/det|>Maximum pressure 6 bar\n"
            "<|det|>image [100, 200, 800, 700]<|/det|>P1 inlet\n"
        )
        page = service.normalize_page(raw, 0)
        self.assertIn("# Pump manual", page["markdown"])
        self.assertIn("Maximum pressure 6 bar", page["markdown"])
        self.assertNotIn("<|det|>", page["markdown"])
        self.assertEqual(page["images"][0]["id"], "page-1-figure-1")
        self.assertIn("P1 inlet", page["images"][0]["image_annotation"]["visible_text"])


if __name__ == "__main__":
    unittest.main()
