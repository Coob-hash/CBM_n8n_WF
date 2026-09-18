"""Create/restore the local Ready for WF2 checkpoint. Python 3 + Docker only.

create saves a new checkpoint and sets it as the default. restore previews;
restore --execute restores it, first backing up the state being replaced.
The entire local cbm_demo database DATA and IFC model volume are included.
Schema, n8n configuration/history, Drive, Gmail and Supabase are not restored.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
HOME = ROOT / "wf2-checkpoints"
spec = importlib.util.spec_from_file_location("cbm_reset", ROOT / "Reset-CbmDemo.py")
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)
IFC = "n8n_deploy-ifc-service-1"
KNOWLEDGE = "n8n_deploy-knowledge-service-1"
VOLUME = "n8n_deploy_cbm_case_models"

# Runs inside the existing IFC image with only the model volume mounted.
MODEL_CODE = r'''
import hashlib,io,json,os,shutil,sys,tarfile
from pathlib import Path,PurePosixPath
root=Path('/snapshot')
assert root.resolve()==Path('/snapshot') and root.is_dir()
mode=sys.argv[1]
if mode=='pack':
    with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as t:
        for p in sorted(root.iterdir()):
            t.add(p,arcname=p.name)
elif mode=='unpack':
    with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:') as t:
        members=t.getmembers()
        for m in members:
            p=PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()):
                raise ValueError('Unsafe archive member: '+m.name)
        # Only the explicitly mounted model volume is cleared.
        for p in root.iterdir():
            if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
            else: p.unlink()
        t.extractall(root,filter='data')
elif mode=='hash':
    files={}
    for p in sorted(root.rglob('*')):
        if p.is_symlink(): raise ValueError('Unexpected model symlink')
        if p.is_file(): files[p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
    print(json.dumps(files,sort_keys=True))
'''


def inspect(name):
    return json.loads(db.run(["docker", "inspect", name]))[0]


def image_and_mount():
    info = inspect(IFC)
    if not any(m.get("Name") == VOLUME and m["Destination"] == "/app/models"
               for m in info["Mounts"]):
        raise RuntimeError("Unexpected IFC storage; checkpoint operation refused.")
    return info["Image"]


def models(image, mode, *, data=None, output=None):
    access = ",readonly" if mode != "unpack" else ""
    return db.run(["docker", "run", "--rm", "-i", "--network", "none",
                   "--mount", f"type=volume,src={VOLUME},dst=/snapshot{access}",
                   "--entrypoint", "python", image, "-c", MODEL_CODE, mode],
                  data=data, output=output)


def data_state():
    rows = {}
    for table in db.TABLES:
        rows[table] = json.loads(db.sql(f"""SELECT json_build_object(
            'count',count(*),'hash',md5(coalesce(string_agg(row_to_json(t)::text,
            E'\\n' ORDER BY row_to_json(t)::text),''))) FROM public."{table}" t;"""))
    seq = json.loads(db.sql("""SELECT coalesce(json_agg(s ORDER BY sequencename),'[]')
        FROM (SELECT schemaname,sequencename,last_value FROM pg_sequences
              WHERE schemaname='public') s;"""))
    return {"tables": rows, "sequences": seq}


def ready_tickets():
    # Validate tokens inside PostgreSQL; never print or put them in the manifest.
    return json.loads(db.sql("""
        SELECT coalesce(json_agg(x ORDER BY id),'[]') FROM (
          SELECT t.id,t.status,tech.email,
            o.value->>'report_expires_at' AS link_expires_at,
            cbm_technician_report_access(jsonb_build_object(
              'ticketId',t.id,'token',o.value->>'report_token'))->>'status' AS upload_access
          FROM tickets t JOIN technicians tech ON tech.id=t.technician_id
          CROSS JOIN LATERAL (SELECT payload FROM ticket_events
            WHERE ticket_id=t.id AND event='CBM_DISPATCH_STATE' ORDER BY id DESC LIMIT 1) e
          CROSS JOIN LATERAL jsonb_array_elements(e.payload->'offers') o(value)
          WHERE t.status='ASSIGNED' AND o.value->>'status'='ACCEPTED'
            AND (o.value->>'technician_id')::int=t.technician_id
        ) x;
    """))


@contextmanager
def stopped_services():
    running = []
    try:
        for name in (db.N8N_CONTAINER, KNOWLEDGE, IFC):
            if inspect(name)["State"]["Running"]:
                running.append(name)
                print("Stopping " + name, flush=True)
                db.run(["docker", "stop", "--time", "45", name], timeout=60)
        db.check_target()
        if int(db.sql("""SELECT count(*) FROM pg_stat_activity
             WHERE datname=current_database() AND pid<>pg_backend_pid()
             AND backend_type='client backend';""")):
            raise RuntimeError("Another database client is connected; close it and retry.")
        yield
    finally:
        # On failed rollback the marker deliberately keeps automation stopped.
        if not (HOME / "RESTORE_FAILED.txt").exists():
            for name in reversed(running):
                db.run(["docker", "start", name])
            if db.N8N_CONTAINER in running:
                db.run(["docker", "exec", db.N8N_CONTAINER, "node", "-e", """
                  (async()=>{for(let i=0;i<45;i++){
                    try {if((await fetch('http://127.0.0.1:5678/healthz/readiness')).ok){
                      console.log('n8n ready');return;}}catch{}
                    await new Promise(r=>setTimeout(r,1000));
                  }process.exitCode=1})()
                """], timeout=55)
            print("Previously running services restarted.", flush=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(image, prefix, ready=None):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    folder = HOME / (prefix + "-" + stamp)
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "schema.sql").write_text(db.schema_dump(), encoding="utf-8")
    for filename, options in (("database.dump", ["--format=custom"]),
                              ("data.sql", ["--data-only"])):
        with (folder / filename).open("xb") as f:
            db.run(["docker", "exec", db.DB_CONTAINER, "pg_dump", "-U", db.DB_USER,
                    "-d", db.DB_NAME, *options], output=f)
    with (folder / "models.tar").open("xb") as f:
        models(image, "pack", output=f)
    manifest = {"format": 1, "created_utc": stamp, "database": db.DB_NAME,
                "model_volume": VOLUME, "ready_tickets": ready or [],
                "data_state": data_state(), "models": json.loads(models(image, "hash")),
                "files": {n: digest(folder / n) for n in
                          ("schema.sql", "data.sql", "database.dump", "models.tar")}}
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("Saved: " + str(folder), flush=True)
    return folder


def validate(folder):
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if (manifest["format"], manifest["database"], manifest["model_volume"]) != (1, db.DB_NAME, VOLUME):
        raise RuntimeError("Unexpected checkpoint target or format.")
    for name in ("schema.sql", "data.sql", "database.dump", "models.tar"):
        if digest(folder / name) != manifest["files"][name]:
            raise RuntimeError("Checkpoint integrity check failed: " + name)
    if db.schema_dump() != (folder / "schema.sql").read_text(encoding="utf-8"):
        raise RuntimeError("Database schema changed since checkpoint; restore refused.")
    return manifest


def apply(folder, image):
    manifest = validate(folder)
    names = ", ".join(f'public."{t}"' for t in db.TABLES)
    # Single transaction: COPY + sequence values; avoid status-event triggers.
    prefix = ("SET LOCAL lock_timeout='15s'; SET LOCAL session_replication_role=replica;\n"
              f"TRUNCATE {names} RESTART IDENTITY RESTRICT;\n").encode()
    db.run(["docker", "exec", "-i", db.DB_CONTAINER, "psql", "-X", "-q", "-1",
            "-v", "ON_ERROR_STOP=1", "-U", db.DB_USER, "-d", db.DB_NAME],
           data=prefix + (folder / "data.sql").read_bytes())
    models(image, "unpack", data=(folder / "models.tar").read_bytes())
    if data_state() != manifest["data_state"]:
        raise RuntimeError("Restored database content differs from checkpoint.")
    if json.loads(models(image, "hash")) != manifest["models"]:
        raise RuntimeError("Restored IFC files differ from checkpoint.")
    validate(folder)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("create", "restore", "status"))
    p.add_argument("--checkpoint", type=Path, help="Specific checkpoint folder (default: latest ready checkpoint)")
    p.add_argument("--execute", action="store_true", help="Apply restore; otherwise preview only")
    args = p.parse_args()
    HOME.mkdir(exist_ok=True)
    if (HOME / "RESTORE_FAILED.txt").exists():
        raise RuntimeError("Resolve RESTORE_FAILED.txt before using this tool again.")
    image = image_and_mount()
    db.check_target()
    if args.action == "create":
        with stopped_services():
            ready = ready_tickets()
            if not ready or any(t["upload_access"] != "OK" for t in ready):
                raise RuntimeError("No assigned ticket with an unused, valid report link. Checkpoint refused.")
            if int(db.sql("SELECT count(*) FROM cbm_technician_submissions;")):
                raise RuntimeError("Reports already submitted; create the checkpoint before testing WF2.")
            folder = save(image, "ready", ready)
            (HOME / "latest-ready.txt").write_text(folder.name, encoding="utf-8")
            print(json.dumps(ready, indent=2), flush=True)
        return
    folder = args.checkpoint or HOME / (HOME / "latest-ready.txt").read_text(encoding="utf-8").strip()
    manifest = validate(folder)
    print(json.dumps({"checkpoint": str(folder), "ready_tickets": manifest["ready_tickets"]}, indent=2), flush=True)
    if args.action == "status" or not args.execute:
        print("Preview only. Use restore --execute to restore the entire local demo and IFC files.")
        return
    if not manifest["ready_tickets"]:
        raise RuntimeError("This is a safety backup, not a Ready for WF2 checkpoint.")
    for ticket in manifest["ready_tickets"]:
        if datetime.fromisoformat(ticket["link_expires_at"]) <= datetime.now(timezone.utc):
            raise RuntimeError("Checkpoint upload link has expired; it cannot be reused.")
    with stopped_services():
        validate(folder)
        backup = save(image, "before-restore")
        try:
            apply(folder, image)
            if ready_tickets() != manifest["ready_tickets"]:
                raise RuntimeError("Upload-link readiness verification failed.")
        except Exception:
            print("Restore failed; rolling back to the safety backup.", flush=True)
            try:
                apply(backup, image)
            except Exception as rollback_error:
                (HOME / "RESTORE_FAILED.txt").write_text(
                    f"Services kept stopped. Restore safety backup: {backup}\n{rollback_error}", encoding="utf-8")
                raise RuntimeError("Rollback failed; services remain stopped. See RESTORE_FAILED.txt.") from rollback_error
            raise
        (backup / "restore-verification.json").write_text(json.dumps({
            "restored_from": str(folder), "database_verified": True,
            "ifc_files_verified": True, "schema_unchanged": True,
            "upload_access": "OK"}, indent=2), encoding="utf-8")
        print("Ready for WF2 restored. Reopen the original email link and submit a fresh report.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        sys.exit(1)
