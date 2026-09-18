"""
CBM IFC Microservice
====================
A thin FastAPI wrapper around IfcOpenShell that gives n8n three capabilities the
pipeline needs and that n8n cannot do natively (IfcOpenShell and Pillow are both
compiled libraries and cannot run inside n8n Code nodes):

  1. POST /elements/nearest
     Map a 3D position (coming from the MultiSet VPS, expressed in the map
     frame) to the closest maintainable IFC element -> returns its GlobalId.

  2. POST /elements/{global_id}/maintenance
     Write a maintenance record into the model as a custom property set
     (CBM_MaintenanceLog) attached to that element, then save the model as a
     NEW versioned file (the model is never overwritten -> full audit trail,
     in the spirit of ISO 19650 information management).

  3. POST /captures/normalize
     Turn a loose smartphone photograph into a MultiSet query image: bake the
     EXIF rotation into the pixels, downscale to MultiSet's 1280 px limit, and
     derive the camera intrinsics that belong to exactly those pixels from
     FocalLengthIn35mmFilm. Replaces the fixed HFOV guess in WF1's
     `Prepare Image & Metadata`. Implemented in capture_normalize.py.

Extra endpoints: GET /health, GET /elements, GET /elements/{global_id}.

Install & run
-------------
    pip install fastapi uvicorn "ifcopenshell>=0.8" numpy pydantic Pillow
    python initialize_model.py          # imports the configured office IFC once
    uvicorn ifc_service:app --host 0.0.0.0 --port 8000

Environment variables
----------------------
    IFC_MODEL_DIR   directory holding the versioned IFC files (default ./models)
    AXIS_MODE       'identity' (default) or 'y_up_to_z_up'
                    MultiSet returns poses in its map frame (Y-up; right-handed
                    if you query with isRightHanded=true). IFC is Z-up. When
                    the map frame and the IFC frame are not aligned you must
                    register them: AXIS_MODE handles the axis swap, and
                    REGISTRATION (a 4x4 matrix, see below) handles the full
                    rigid transform obtained from a one-off calibration
                    (measure >= 3 known points in both frames).
"""

from __future__ import annotations

import json
import hashlib
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from service_lock import model_lock, atomic_text

import numpy as np
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element
import ifcopenshell.util.placement
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from capture_normalize import (
    MAX_UPLOAD_LONG_SIDE,
    CaptureRejected,
    normalize_b64,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_DIR = Path(os.environ.get("IFC_MODEL_DIR", "./models"))
POINTER_FILE = MODEL_DIR / "active_model.txt"
AUDIT_FILE = MODEL_DIR / "maintenance_audit.jsonl"
AXIS_MODE = os.environ.get("AXIS_MODE", "identity")

# Optional full rigid registration map->IFC (row-major 4x4). Identity by
# default: the PoC generator places elements directly in "map" coordinates.
REGISTRATION = np.array(
    json.loads(os.environ.get("MULTISET_TO_IFC_MATRIX", "null")) or np.eye(4).tolist(),
    dtype=float,
).reshape(4, 4)

PSET_NAME = "CBM_MaintenanceLog"

# IFC classes considered "maintainable assets" when no class hint is provided.
MAINTAINABLE_CLASSES = [
    "IfcDoor", "IfcWindow", "IfcLightFixture", "IfcSanitaryTerminal",
    "IfcAirTerminal", "IfcFurniture", "IfcDistributionElement",
    "IfcBuildingElementProxy",
    "IfcSpaceHeater", "IfcFlowTerminal", "IfcUnitaryEquipment",
]

app = FastAPI(title="CBM IFC Service", version="2026.09.14")

# ---------------------------------------------------------------------------
# Model versioning helpers
# ---------------------------------------------------------------------------

def _active_model_path() -> Path:
    if not POINTER_FILE.exists():
        raise HTTPException(500, "No active model. Run the configured IFC importer first.")
    p = MODEL_DIR / POINTER_FILE.read_text().strip()
    if not p.exists():
        raise HTTPException(500, f"Active model file missing: {p.name}")
    return p


def _next_version_path(current: Path) -> Path:
    m = re.match(r"(.*)_v(\d+)\.ifc$", current.name)
    if m:
        return MODEL_DIR / f"{m.group(1)}_v{int(m.group(2)) + 1}.ifc"
    return MODEL_DIR / f"{current.stem}_v2.ifc"


def _load_model() -> tuple[ifcopenshell.file, Path]:
    path = _active_model_path()
    return ifcopenshell.open(str(path)), path

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def map_to_ifc(p: np.ndarray) -> np.ndarray:
    """Transform a point from the MultiSet map frame to the IFC frame."""
    if AXIS_MODE == "y_up_to_z_up":
        # right-handed Y-up  ->  right-handed Z-up:  (x, y, z) -> (x, -z, y)
        p = np.array([p[0], -p[2], p[1]], dtype=float)
    ph = REGISTRATION @ np.array([p[0], p[1], p[2], 1.0])
    return ph[:3]


def element_position(el) -> np.ndarray | None:
    """World translation of an element from its ObjectPlacement (4x4)."""
    if not getattr(el, "ObjectPlacement", None):
        return None
    m = ifcopenshell.util.placement.get_local_placement(el.ObjectPlacement)
    return np.array(m, dtype=float)[:3, 3]


def iter_candidates(model, ifc_class: str | None):
    classes = [ifc_class] if ifc_class else MAINTAINABLE_CLASSES
    seen = set()
    for cls in classes:
        try:
            products = model.by_type(cls)
        except Exception:
            continue
        for el in products:
            if el.id() in seen:
                continue
            seen.add(el.id())
            yield el

# ---------------------------------------------------------------------------
# Pset helpers
# ---------------------------------------------------------------------------

def _find_pset(el, name: str):
    for rel in getattr(el, "IsDefinedBy", []) or []:
        if rel.is_a("IfcRelDefinesByProperties"):
            pdef = rel.RelatingPropertyDefinition
            if pdef.is_a("IfcPropertySet") and pdef.Name == name:
                return pdef
    return None

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class NearestRequest(BaseModel):
    x: float
    y: float
    z: float
    ifc_class: str | None = Field(default=None, description="Optional IFC class hint, e.g. IfcDoor")
    max_distance: float = Field(default=10.0, description="Reject matches farther than this (meters)")


class MaintenanceRequest(BaseModel):
    ticket_id: int | str
    operation_key: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:-]+$")
    maintenance_date: str | None = None
    technician: str | None = None
    description: str | None = None
    condition: str = "Repaired"
    approved_by: str | None = None


class NormalizeCaptureRequest(BaseModel):
    imageB64: str = Field(description="The photograph, base64. A data: prefix is tolerated.")
    longSide: int = Field(default=MAX_UPLOAD_LONG_SIDE, ge=64, le=4096,
                          description="Target size of the longer side. MultiSet accepts 1280.")

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    model, path = _load_model()
    count = sum(1 for _ in iter_candidates(model, None))
    return {"status": "ok", "active_model": path.name, "maintainable_elements": count,
            "axis_mode": AXIS_MODE}


@app.get("/elements")
def list_elements(ifc_class: str | None = None):
    model, _ = _load_model()
    out = []
    for el in iter_candidates(model, ifc_class):
        pos = element_position(el)
        out.append({
            "global_id": el.GlobalId,
            "name": el.Name,
            "ifc_class": el.is_a(),
            "position": None if pos is None else {"x": pos[0], "y": pos[1], "z": pos[2]},
        })
    return {"count": len(out), "elements": out}


@app.get("/maintenance")
def inspect_maintenance(
    global_id: str = Query(default="", max_length=22),
    global_ids: str = Query(default="", max_length=2300),
    search: str = Query(default="", max_length=200),
    model_version: str = Query(default="", max_length=200),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
):
    """Read actual maintenance properties from one consistent active IFC version.

    This is a model inventory, not a claim that every entry represents a closed
    ticket. Ticket state remains the database's responsibility. Older history is
    available in the downloadable IFC; responses include the last 20 entries.
    """
    try:
        with model_lock(MODEL_DIR):
            if model_version:
                path = _inspection_version_path(model_version)
                model = ifcopenshell.open(str(path))
            else:
                model, path = _load_model()
            version_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
            selected = set(filter(None, global_ids.split(',')))
            if len(selected) > 100 or any(not re.fullmatch(r'[A-Za-z0-9_$]{22}', gid) for gid in selected):
                raise HTTPException(422, 'Expected at most 100 comma-separated IFC GlobalIds')
            if global_id:
                selected.add(global_id)
            if global_id:
                try:
                    products = [model.by_guid(global_id)]
                except Exception:
                    raise HTTPException(404, "IFC asset not found") from None
                if products[0] is None:
                    raise HTTPException(404, "IFC asset not found")
            else:
                products = model.by_type("IfcProduct")
            assets = []
            for element in products:
                if selected and element.GlobalId not in selected:
                    continue
                props = ifcopenshell.util.element.get_psets(
                    element, should_inherit=False).get(PSET_NAME)
                if not props:
                    continue
                try:
                    history = json.loads(props.get("History", "[]"))
                    if not isinstance(history, list) or any(not isinstance(x, dict) for x in history):
                        raise ValueError("Invalid history")
                except (TypeError, ValueError):
                    raise HTTPException(500, f"Invalid IFC maintenance history for {element.GlobalId}") from None
                container = ifcopenshell.util.element.get_container(element)
                if search and search.casefold() not in ' '.join(str(v or '') for v in
                        (element.Name, element.GlobalId, element.is_a(), getattr(container, 'Name', None))).casefold():
                    continue
                assets.append({
                    "global_id": element.GlobalId, "name": element.Name,
                    "ifc_class": element.is_a(),
                    "location": getattr(container, "Name", None),
                    "last_ticket_id": props.get("LastTicketId"),
                    "last_maintenance_date": props.get("LastMaintenanceDate"),
                    "last_technician": props.get("LastTechnician"),
                    "last_description": props.get("LastDescription"),
                    "condition": props.get("ConditionStatus"),
                    "approved_by": props.get("ApprovedBy"),
                    "history_count": len(history), "history": list(reversed(history[-20:])),
                    "history_truncated": len(history) > 20,
                })
            def date_order(asset):
                try:
                    when = datetime.fromisoformat(str(asset['last_maintenance_date']).replace('Z', '+00:00'))
                    return (when.replace(tzinfo=timezone.utc) if when.tzinfo is None else when).timestamp()
                except (TypeError, ValueError, OverflowError):
                    return float('-inf')
            assets.sort(key=lambda x: (date_order(x), x['global_id']), reverse=True)
            total = len(assets)
            return {"source": "IFC", "property_set": PSET_NAME,
                    "version_file": path.name, "version_sha256": version_sha256,
                    "inspected_at": datetime.now(timezone.utc).isoformat(),
                    "global_id_filter": global_id or None,
                    "global_ids_filter": sorted(selected), "search": search,
                    "order": "last_maintenance_date_desc_global_id_desc",
                    "total_maintained_assets": total,
                    "total_interventions": sum(x["history_count"] for x in assets),
                    "offset": offset, "limit": limit,
                    "has_more": offset + limit < total,
                    "assets": assets[offset:offset + limit]}
    except TimeoutError as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/models/{version_file}/download")
def download_model(version_file: str):
    """Download the inspected immutable version, even if a newer one was published."""
    path = _inspection_version_path(version_file)
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


def _inspection_version_path(version_file: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_. -]+\.ifc", version_file):
        raise HTTPException(400, "Invalid IFC version filename")
    path = (MODEL_DIR / version_file).resolve()
    if path.parent != MODEL_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "IFC version not found")
    return path


@app.get("/elements/{global_id}")
def get_element(global_id: str):
    model, _ = _load_model()
    try:
        el = model.by_guid(global_id)
    except Exception:
        raise HTTPException(404, f"No element with GlobalId {global_id}")
    return {
        "global_id": el.GlobalId,
        "name": el.Name,
        "ifc_class": el.is_a(),
        "psets": ifcopenshell.util.element.get_psets(el),
    }


@app.post("/elements/nearest")
def nearest_element(req: NearestRequest):
    """Spatial query: MultiSet pose (map frame) -> closest IFC element."""
    if os.environ.get('CBM_CASE_STUDY_DIR'):
        return {"found":False,"global_id":None,"name":None,"ifc_class":None,"distance":None,
                "reason":"Use /case-study/resolve and automatic target identification for this real case study"}
    model, path = _load_model()
    target = map_to_ifc(np.array([req.x, req.y, req.z], dtype=float))

    best, best_d = None, float("inf")
    for el in iter_candidates(model, req.ifc_class):
        pos = element_position(el)
        if pos is None:
            continue
        d = float(np.linalg.norm(pos - target))
        if d < best_d:
            best, best_d = el, d

    # Class-hint miss (e.g. hint 'IfcDoor' but the model has none): retry
    # class-agnostic rather than failing the whole intake pipeline.
    if best is None and req.ifc_class:
        for el in iter_candidates(model, None):
            pos = element_position(el)
            if pos is None:
                continue
            d = float(np.linalg.norm(pos - target))
            if d < best_d:
                best, best_d = el, d

    if best is None or best_d > req.max_distance:
        return {"found": False, "global_id": None, "name": None,
                "ifc_class": None, "distance": None, "model": path.name}

    pos = element_position(best)
    return {
        "found": True,
        "global_id": best.GlobalId,
        "name": best.Name,
        "ifc_class": best.is_a(),
        "distance": round(best_d, 3),
        "position": {"x": pos[0], "y": pos[1], "z": pos[2]},
        "model": path.name,
    }


@app.post("/elements/{global_id}/maintenance")
def log_maintenance(global_id: str, req: MaintenanceRequest):
    """Serialize writers and replay the same operation without another IFC write.

    Durable audit precedes the atomic pointer switch. If a process exits between
    these writes, the next locked request finishes publishing that version.
    """
    try:
        with model_lock(MODEL_DIR):
            signature=hashlib.sha256(json.dumps({'global_id':global_id,**req.model_dump()},
                sort_keys=True,separators=(',',':')).encode()).hexdigest()
            records=[]
            if AUDIT_FILE.exists():
                with open(AUDIT_FILE,'rb+') as handle:
                    while True:
                        offset=handle.tell();line=handle.readline()
                        if not line:break
                        try:record=json.loads(line)
                        except (ValueError,UnicodeError):
                            # Only an incomplete final append is recoverable.
                            if handle.read():raise HTTPException(500,'IFC audit is corrupt')
                            handle.truncate(offset);handle.flush();os.fsync(handle.fileno());break
                        records.append(record)
            for record in records:
                if not record.get('result'):continue  # pre-release audit entry
                target=MODEL_DIR/record['to_model']
                if POINTER_FILE.read_text().strip()==record['from_model']:
                    if not target.is_file():raise HTTPException(500,'Pending IFC version is missing')
                    atomic_text(POINTER_FILE,target.name)
                if record.get('operation_key')==req.operation_key:
                    if record.get('request_sha256')!=signature:
                        raise HTTPException(409,'Operation key already used with different maintenance data')
                    return record['result']
            return _write_maintenance(global_id,req,signature)
    except TimeoutError as exc:
        raise HTTPException(503,str(exc)) from exc


def _write_maintenance(global_id: str, req: MaintenanceRequest, signature: str):
    model, current = _load_model()
    try:
        el = model.by_guid(global_id)
    except Exception:
        raise HTTPException(404, f"No element with GlobalId {global_id}")

    when = req.maintenance_date or datetime.now(timezone.utc).isoformat()

    pset = _find_pset(el, PSET_NAME)
    if pset is None:
        pset = ifcopenshell.api.run("pset.add_pset", model, product=el, name=PSET_NAME)

    # Append-only history stored alongside the "last-*" convenience fields.
    existing = ifcopenshell.util.element.get_psets(el).get(PSET_NAME, {})
    try:
        history = json.loads(existing.get("History", "[]"))
    except Exception:
        history = []
    history.append({
        "operation_key": req.operation_key,
        "ticket_id": str(req.ticket_id),
        "date": when,
        "technician": req.technician,
        "description": req.description,
        "condition": req.condition,
        "approved_by": req.approved_by,
    })

    ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={
        "LastTicketId": str(req.ticket_id),
        "LastMaintenanceDate": when,
        "LastTechnician": req.technician or "",
        "LastDescription": req.description or "",
        "ConditionStatus": req.condition,
        "ApprovedBy": req.approved_by or "",
        "History": json.dumps(history),
    })

    new_path = _next_version_path(current)
    # Preserve orphan versions left by an interrupted pre-journal write.
    while new_path.exists():
        new_path=_next_version_path(new_path)
    temporary=new_path.with_suffix('.ifc.tmp')
    model.write(str(temporary))
    with open(temporary,'rb+') as handle:os.fsync(handle.fileno())
    os.replace(temporary,new_path)
    result={"global_id":global_id,"element":el.Name,"pset":PSET_NAME,
            "version_file":new_path.name,"history_entries":len(history)}

    with open(AUDIT_FILE, "a", encoding='utf-8') as fh:
        fh.write(json.dumps({
            "operation_key": req.operation_key,
            "request_sha256": signature,
            "result": result,
            "ts": datetime.now(timezone.utc).isoformat(),
            "ticket_id": str(req.ticket_id),
            "global_id": global_id,
            "element": el.Name,
            "from_model": current.name,
            "to_model": new_path.name,
        }) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    atomic_text(POINTER_FILE,new_path.name)

    return result


@app.post("/captures/normalize")
def normalize_capture(req: NormalizeCaptureRequest):
    """Loose photograph -> MultiSet query image, with the intrinsics that belong to it.

    Exists here for the same reason /elements/nearest does: the work needs a compiled
    library (Pillow) that cannot run inside an n8n Code node.

    Replaces the `HFOV_DEG = 69` guess in WF1's `Prepare Image & Metadata`. That constant
    is only right for a ~26 mm-equivalent lens; this reads FocalLengthIn35mmFilm, so the
    lens that actually took the photograph is the one described. It also bakes the EXIF
    rotation into the pixels, which the current node does not do at all, and downscales to
    MultiSet's 1280 px limit.

    `trusted: false` means K failed the plausibility gate. Route such a capture to bounded photo retry
    triage rather than unprojecting it: a wrong K still returns a confident-looking pose.
    """
    try:
        result = normalize_b64(req.imageB64, long_side=req.longSide)
    except CaptureRejected as exc:
        raise HTTPException(422, str(exc))
    return result
