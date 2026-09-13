"""Offline tests of migration history and local configuration validation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json

spec = importlib.util.spec_from_file_location("cbm_migrate", Path(__file__).resolve().parents[1] / "migrate.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def test_migration_history(self):
        files = migration.migration_files()
        self.assertEqual(len(files), 3)
        migration.validate_history(files, {})
        migration.validate_history(files, {files[0][0]: files[0][1]})
        migration.validate_history(files, {n: h for n, h, _ in files})

    def test_modified_and_unknown_migrations_fail(self):
        files = migration.migration_files()
        with self.assertRaisesRegex(ValueError, "edited"):
            migration.validate_history(files, {files[0][0]: "modified"})
        with self.assertRaisesRegex(ValueError, "unknown"):
            migration.validate_history(files, {"999_missing.sql": "missing"})

    def test_history_gap_fails(self):
        files = migration.migration_files()
        with self.assertRaisesRegex(ValueError, "contiguous"):
            migration.validate_history(files, {files[1][0]: files[1][1]})

    def test_unique_numeric_prefixes(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "001_first.sql").write_text("SELECT 1")
            Path(d, "001_second.sql").write_text("SELECT 2")
            with self.assertRaisesRegex(ValueError, "unique"):
                migration.migration_files(Path(d))

    def test_site_placeholders_rejected(self):
        with self.assertRaisesRegex(ValueError, "placeholders"):
            migration.site_config(Path(__file__).resolve().parents[1] / "site.example.json")

    def test_site_validation(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d, "site.json")
            data = {"building_code": "building-A", "building_name": "Building A", "fm_name": "FM", "fm_email": "fm@example.test"}
            f.write_text(json.dumps(data))
            self.assertEqual(migration.site_config(f), data)
            data["password"] = "not-allowed"
            f.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "exactly"):
                migration.site_config(f)


if __name__ == "__main__":
    unittest.main()
