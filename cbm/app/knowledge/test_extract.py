"""Source synchronization contracts with synthetic IFC adapters; no real product claims."""
import json
import tempfile
import unittest
from pathlib import Path
from knowledge.extract import extract_snapshot, split_text

GID = "0abcdefghijklmnopqrstu"
# IFC GlobalId is 22 characters, first digit 0..3.


class Element:
    def is_a(self, name):
        return name == "IfcSpaceHeater"


class Model:
    def __init__(self, present=True):
        self.present = present

    def by_guid(self, gid):
        return Element() if self.present else None


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.models = self.root / "models"
        self.models.mkdir()
        (self.models / "active_model.txt").write_text("one.ifc")
        (self.models / "one.ifc").write_text("synthetic IFC bytes")
        (self.root / "documents").mkdir()
        (self.root / "documents" / "manual.txt").write_text("TEST ONLY. Rated pressure: 10 bar.")
        self.config = {"approved": True, "products": [{"id": "p1", "manufacturer": "TEST ONLY", "model": "Fixture", "documents": [
            {"approved": True, "id": "manual", "path": "manual.txt", "title": "Synthetic manual", "revision": "1"}]}],
            "assets": [{"global_id": GID, "product_id": "p1", "ifc_class": "IfcSpaceHeater", "ifc_type_global_id": None,
                        "properties": [{"pset": "Specifications", "name": "Pressure", "unit": "bar"}]}]}
        self.path = self.root / "catalog.local.json"
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.path.write_text(json.dumps(self.config))

    def extract(self, present=True, **kwargs):
        return extract_snapshot(self.path, self.models, open_model=lambda _: Model(present),
                                get_psets=lambda _: {"Specifications": {"Pressure": 10}},
                                get_type=kwargs.get("get_type", lambda _: None))

    def test_stable_fingerprint_and_citations(self):
        first, second = self.extract(), self.extract()
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertEqual(len(first["chunks"]), 2)
        for chunk in first["chunks"]:
            self.assertEqual(chunk["metadata"]["ifc_global_id"], GID)
            self.assertTrue(chunk["metadata"]["source_sha256"])
        self.assertTrue(any("Pressure: 10 bar" in c["content"] for c in first["chunks"]))

    def test_geometry_change_changes_publication_but_not_embedded_text(self):
        first = self.extract()
        (self.models / "one.ifc").write_text("changed geometry / maintenance log")
        second = self.extract()
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])
        self.assertEqual([c["content"] for c in first["chunks"]], [c["content"] for c in second["chunks"]])

    def test_document_change_invalidates_ids(self):
        first = self.extract()
        (self.root / "documents" / "manual.txt").write_text("TEST ONLY. Rated pressure: 8 bar.")
        second = self.extract()
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])
        self.assertNotEqual([c["metadata"]["chunk_id"] for c in first["chunks"]], [c["metadata"]["chunk_id"] for c in second["chunks"]])

    def test_removed_ifc_object_is_omitted(self):
        result = self.extract(present=False)
        self.assertEqual(result["chunks"], [])
        self.assertEqual(result["missing_assets"], [GID])

    def test_changed_ifc_type_requires_review(self):
        with self.assertRaisesRegex(ValueError, "type changed"):
            self.extract(get_type=lambda _: type("Type", (), {"GlobalId": "new-type"})())

    def test_unapproved_or_empty_source_not_published(self):
        self.config["approved"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "approved"):
            self.extract()
        self.config["approved"] = True
        self.save()
        (self.root / "documents" / "manual.txt").write_text("")
        with self.assertRaisesRegex(ValueError, "Empty"):
            self.extract()

    def test_numeric_units_and_duplicate_assets_rejected(self):
        del self.config["assets"][0]["properties"][0]["unit"]
        self.save()
        with self.assertRaisesRegex(ValueError, "unit"):
            self.extract()
        self.config["assets"][0]["properties"] = []
        self.config["assets"].append(self.config["assets"][0].copy())
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.extract()

    def test_path_escape_and_torn_snapshot_rejected(self):
        (self.models / "active_model.txt").write_text("../catalog.local.json")
        with self.assertRaisesRegex(ValueError, "directory"):
            self.extract()
        (self.models / "active_model.txt").write_text("one.ifc")
        def change(_):
            (self.models / "one.ifc").write_text("concurrent change")
            return None
        with self.assertRaisesRegex(ValueError, "during extraction"):
            self.extract(get_type=change)

    def test_chunk_size_is_bounded_without_dropping_words(self):
        text = "Important specification. " * 100
        chunks = list(split_text(text))
        self.assertTrue(all(len(c) <= 850 for c in chunks))
        self.assertEqual(" ".join(chunks).split(), text.split())


if __name__ == "__main__":
    unittest.main()
