"""Private read-only endpoint for the n8n knowledge synchronization workflow."""
import os
import secrets
from pathlib import Path
from fastapi import FastAPI, Header, HTTPException
from .extract import extract_snapshot

app = FastAPI(title="CBM technical knowledge extraction")


@app.get("/knowledge/snapshot")
def snapshot(x_cbm_knowledge_key: str = Header(default="")):
    key = os.environ.get("CBM_KNOWLEDGE_KEY", "")
    if not key:
        raise HTTPException(503, "Configure CBM_KNOWLEDGE_KEY")
    if not secrets.compare_digest(key, x_cbm_knowledge_key):
        raise HTTPException(401, "Unauthorized")
    try:
        return extract_snapshot(Path(os.environ.get("CBM_KNOWLEDGE_CATALOG", "knowledge/catalog.local.json")),
                                Path(os.environ.get("IFC_MODEL_DIR", "models")))
    except Exception as exc:
        # No source paths, document text or credentials in the HTTP error response.
        raise HTTPException(503, "Snapshot unavailable; check approved local sources (" + type(exc).__name__ + ")") from exc
