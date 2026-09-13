"""Apply checked, transactional CBM migrations to an explicitly configured database.

Connection: CBM_DATABASE_URL, or standard libpq PGDATABASE/PGHOST/PGUSER settings.
Use PGPASSFILE or another libpq credential mechanism; no password argument is accepted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
LOCK_ID = 132849001


def migration_files(directory: Path = ROOT / "migrations") -> list[tuple[str, str, str]]:
    result = []
    for file in sorted(directory.glob("*.sql")):
        if not re.fullmatch(r"\d{3}_[a-z_]+\.sql", file.name):
            raise ValueError(f"Invalid migration filename: {file.name}")
        data = file.read_bytes()
        result.append((file.name, hashlib.sha256(data).hexdigest(), data.decode("utf-8")))
    if not result or len({name.split("_")[0] for name, _, _ in result}) != len(result):
        raise ValueError("Migrations must have unique numeric prefixes and cannot be empty")
    return result


def validate_history(files: list[tuple[str, str, str]], applied: dict[str, str]) -> None:
    expected = {name: digest for name, digest, _ in files}
    for name, digest in applied.items():
        if name not in expected:
            raise ValueError(f"Database contains an unknown migration: {name}")
        if expected[name] != digest:
            raise ValueError(f"Applied migration has been edited: {name}")
    seen_gap = False
    for name, _, _ in files:
        if name not in applied:
            seen_gap = True
        elif seen_gap:
            raise ValueError("Database migration history is not a contiguous prefix")


def site_config(file: Path) -> dict[str, str]:
    data = json.loads(file.read_text(encoding="utf-8-sig"))
    required = {"building_code", "building_name", "fm_name", "fm_email"}
    if set(data) != required or any(not isinstance(v, str) or not v.strip() for v in data.values()):
        raise ValueError("Site configuration requires exactly building_code, building_name, fm_name and fm_email")
    if any("REPLACE" in v.upper() for v in data.values()) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", data["fm_email"]):
        raise ValueError("Replace the site placeholders with real local settings")
    return {k: v.strip() for k, v in data.items()}


def configure_site(conn, data: dict[str, str]) -> None:
    with conn.transaction():
        system = conn.execute("SELECT id FROM cbm.actors WHERE external_identity='cbm.database'").fetchone()[0]
        conn.execute("SELECT set_config('cbm.actor_id',%s,true)", (str(system),))
        fm = conn.execute("SELECT id,kind,active FROM cbm.actors WHERE lower(email)=lower(%s) FOR UPDATE", (data["fm_email"],)).fetchone()
        if fm:
            if fm[1:] != ("HUMAN", True):
                raise ValueError("Configured FM address already belongs to an inactive or nonhuman actor")
            fm_id = fm[0]
        else:
            fm_id = conn.execute("INSERT INTO cbm.actors(kind,name,email) VALUES('HUMAN',%s,%s) RETURNING id", (data["fm_name"], data["fm_email"])).fetchone()[0]
        conn.execute("""INSERT INTO cbm.site_settings(building_code,building_name,facility_manager_actor_id)
            VALUES(%s,%s,%s) ON CONFLICT(id) DO UPDATE SET building_code=excluded.building_code,
            building_name=excluded.building_name,facility_manager_actor_id=excluded.facility_manager_actor_id,
            updated_at=clock_timestamp()""", (data["building_code"], data["building_name"], fm_id))


def run(conn, files: list[tuple[str, str, str]], check_only: bool = False, config=None) -> list[str]:
    # Session lock spans the migration transactions. Connection close releases it on failure.
    conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
    try:
        installed = conn.execute("SELECT to_regclass('cbm_meta.migrations')").fetchone()[0] is not None
        applied = dict(conn.execute("SELECT filename,sha256 FROM cbm_meta.migrations ORDER BY filename").fetchall()) if installed else {}
        validate_history(files, applied)
        pending = [name for name, _, _ in files if name not in applied]
        if check_only:
            return pending
        if not installed:
            # Refuse to infer ownership of a hand-created or incomplete cbm schema.
            if conn.execute("SELECT to_regnamespace('cbm')").fetchone()[0] is not None:
                raise ValueError("cbm exists without migration history; inspect it before applying migrations")
            with conn.transaction():
                conn.execute("CREATE SCHEMA cbm_meta")
                conn.execute("REVOKE ALL ON SCHEMA cbm_meta FROM PUBLIC")
                conn.execute("""CREATE TABLE cbm_meta.migrations (
                    filename text PRIMARY KEY, sha256 text NOT NULL,
                    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), applied_by text NOT NULL DEFAULT current_user)""")
        for name, digest, sql in files:
            if name in applied:
                continue
            with conn.transaction():
                conn.execute(sql, prepare=False)
                conn.execute("INSERT INTO cbm_meta.migrations(filename,sha256) VALUES(%s,%s)", (name, digest))
            print(f"Applied {name}")
        if config is not None:
            configure_site(conn, config)
            print("Site configuration applied")
        return pending
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Read migration status without changing the database")
    parser.add_argument("--site-config", type=Path, help="Apply a private site JSON after migrations")
    args = parser.parse_args()
    if args.check and args.site_config:
        parser.error("--check cannot configure the site")
    files = migration_files()
    config = site_config(args.site_config) if args.site_config else None
    if not os.getenv("CBM_DATABASE_URL") and not os.getenv("PGDATABASE"):
        raise ValueError("Set CBM_DATABASE_URL or PGDATABASE explicitly; no default database will be modified")
    try:
        import psycopg
    except ImportError as exc:
        raise ValueError("Install database/requirements.txt in your virtual environment first") from exc
    # Keep DSNs and provider error strings out of console output.
    try:
        with psycopg.connect(os.getenv("CBM_DATABASE_URL", ""), autocommit=True, connect_timeout=10) as conn:
            if conn.info.server_version < 140000:
                raise ValueError("PostgreSQL 14 or newer is required")
            pending = run(conn, files, args.check, config)
    except psycopg.Error as exc:
        print(f"Database operation failed ({type(exc).__name__}, SQLSTATE {exc.sqlstate or 'unavailable'}). The current migration transaction was rolled back. Check database configuration and server logs.", file=sys.stderr)
        return 1
    if args.check:
        print("Pending: " + ", ".join(pending) if pending else "All migrations are applied")
    else:
        print("Database migrations are up to date")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
