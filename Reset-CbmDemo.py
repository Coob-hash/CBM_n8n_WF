"""Reset the local Docker CBM demo. Preview by default; use --execute to apply.

Requires Python 3 and Docker CLI. No Python packages or passwords are needed.
Only cbm_demo application rows and their identity counters are reset. n8n's
workflows/credentials/history, Supabase knowledge and files are not reset.
"""

import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


DB_CONTAINER = "n8n_deploy-cbm-postgres-1"
N8N_CONTAINER = "n8n_v1"
DB_NAME = "cbm_demo"
DB_USER = "cbm_app"
TABLES = (
    "cbm_capture_attempts", "cbm_capture_configuration_events",
    "cbm_dispatch_queue_visits", "cbm_intake_outbox", "cbm_intake_reports",
    "cbm_it_issues", "cbm_technician_submissions", "cbm_wf3_approval_emails",
    "technicians", "ticket_events", "tickets",
)
EMAIL = "giuseppe.desiderio123@gmail.com"


def run(args, *, data=None, output=None, timeout=120):
    result = subprocess.run(
        args, input=data, stdout=output or subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=timeout, check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def sql(query):
    return run([
        "docker", "exec", "-i", DB_CONTAINER, "psql", "-X", "-q", "-A", "-t",
        "-v", "ON_ERROR_STOP=1", "-U", DB_USER, "-d", DB_NAME,
    ], data=query.encode("utf-8")).decode("utf-8").strip()


def schema_dump():
    raw = run([
        "docker", "exec", DB_CONTAINER, "pg_dump", "-U", DB_USER,
        "-d", DB_NAME, "--schema-only",
    ]).decode("utf-8")
    # PostgreSQL adds a new random psql restriction token to each dump.
    return "\n".join(line for line in raw.splitlines()
                     if not line.startswith(("\\restrict ", "\\unrestrict ")))


def counts():
    query = " UNION ALL ".join(
        f"SELECT '{table}' AS table_name, count(*) AS rows FROM public.\"{table}\""
        for table in TABLES
    )
    return json.loads(sql(f"SELECT json_agg(x) FROM ({query}) x;"))


def check_target():
    if sql("SELECT current_database();") != DB_NAME:
        raise RuntimeError("Unexpected database; reset refused.")
    found = set(sql("""
        SELECT schemaname || '.' || tablename FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1;
    """).splitlines())
    expected = {"public." + name for name in TABLES}
    if found != expected:
        raise RuntimeError(
            "Application table inventory changed; review before resetting. "
            f"Unexpected: {sorted(found - expected)}; missing: {sorted(expected - found)}"
        )


def reset_sql():
    names = ", ".join(f'public."{name}"' for name in TABLES)
    checks = "\n".join(
        f"IF EXISTS (SELECT 1 FROM public.\"{table}\") THEN "
        f"RAISE EXCEPTION 'Reset verification failed: {table}'; END IF;"
        for table in TABLES if table != "technicians"
    )
    return f"""
BEGIN;
SET LOCAL lock_timeout = '15s';
TRUNCATE TABLE {names} RESTART IDENTITY RESTRICT;
INSERT INTO public.technicians
 (full_name,email,skills,zone,rating,active,profile_text,last_assigned_at,jobs_completed)
VALUES
 ('Giuseppe Desiderio','{EMAIL}',
  ARRAY['plumbing','hvac','electrical','carpentry','general'],
  'building-A',4.5,true,
  'Demo technician for the CBM application; eligible for all currently supported dispatch skills.',
  NULL,0);
DO $verify$
BEGIN
{checks}
IF (SELECT count(*) FROM public.technicians) <> 1 OR NOT EXISTS (
 SELECT 1 FROM public.technicians WHERE id=1 AND email='{EMAIL}'
 AND active=true AND jobs_completed=0 AND last_assigned_at IS NULL
) THEN RAISE EXCEPTION 'Demo technician verification failed'; END IF;
END $verify$;
COMMIT;
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Apply the reset (default: preview)")
    parser.add_argument("--backup-dir", type=Path,
                        default=Path(__file__).resolve().parent / "database-reset-backups")
    args = parser.parse_args()
    check_target()
    print(json.dumps({"database": DB_NAME, "before": counts(),
                      "technician_to_restore": EMAIL}, indent=2), flush=True)
    if not args.execute:
        print(f"Preview only. Add --execute to back up, clear all {len(TABLES)} "
              "tables and restore the technician.")
        return

    running = run(["docker", "inspect", "--format", "{{.State.Running}}", N8N_CONTAINER]).strip() == b"true"
    restart_needed = False
    try:
        if running:
            restart_needed = True
            print("Stopping n8n while the database is reset...", flush=True)
            run(["docker", "stop", "--time", "90", N8N_CONTAINER], timeout=110)
        check_target()
        # Refuse if another client could submit writes during the reset.
        clients = int(sql("""SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND backend_type='client backend';"""))
        if clients:
            raise RuntimeError("Other database clients are connected. Close them and retry.")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
        destination = args.backup_dir.resolve() / stamp
        destination.mkdir(parents=True, exist_ok=False)
        before = schema_dump()
        (destination / "schema-before.sql").write_text(before, encoding="utf-8")
        with (destination / "cbm_demo.dump").open("xb") as backup:
            run(["docker", "exec", DB_CONTAINER, "pg_dump", "-U", DB_USER,
                 "-d", DB_NAME, "--format=custom"], output=backup)
        print(f"Backup saved: {destination / 'cbm_demo.dump'}", flush=True)
        sql(reset_sql())
        after = schema_dump()
        (destination / "schema-after.sql").write_text(after, encoding="utf-8")
        report = {"database": DB_NAME, "after": counts(),
                  "technician": json.loads(sql("SELECT row_to_json(t) FROM public.technicians t;")),
                  "schema_unchanged": before == after,
                  "schema_sha256": hashlib.sha256(after.encode()).hexdigest()}
        (destination / "verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
        if before != after:
            raise RuntimeError("Schema comparison failed; inspect the saved schema dumps.")
        print("Reset complete. All application tables are empty except the demo technician.", flush=True)
    finally:
        if restart_needed:
            run(["docker", "start", N8N_CONTAINER])
            print("n8n restarted.", flush=True)


if __name__ == "__main__":
    main()
