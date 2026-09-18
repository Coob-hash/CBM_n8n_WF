"""Read-only IFC/document extraction. Embeddings and publication belong to n8n."""
from __future__ import annotations
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

MODEL = "text-embedding-3-small"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def contained(root: Path, value: str) -> Path:
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Source path must remain in its configured directory")
    return path


def split_text(text: str, limit=850):
    """Bounded verbatim slices, split at whitespace; never concatenate PDF pages."""
    text = text.strip()
    while text:
        end = len(text) if len(text) <= limit else text.rfind(" ", 0, limit + 1)
        if end <= 0:
            end = limit
        part, text = text[:end].strip(), text[end:].strip()
        if part:
            yield part


def read_document(path: Path):
    if path.suffix.lower() == ".pdf":
        from pypdf import PdfReader
        pages = [(str(i + 1), page.extract_text() or "") for i, page in enumerate(PdfReader(path).pages)]
    elif path.suffix.lower() in (".txt", ".md"):
        pages = [("text", path.read_text(encoding="utf-8"))]
    else:
        raise ValueError("Approved sources must be text PDFs, TXT or Markdown")
    if not pages or any(not text.strip() for _, text in pages):
        raise ValueError("Empty/unextractable page: provide reviewed text or OCR before publishing")
    return pages


def extract_snapshot(catalog_path: Path, model_dir: Path, open_model=None, get_psets=None, get_type=None):
    observed = datetime.now(timezone.utc).isoformat()
    catalog_bytes = catalog_path.read_bytes()
    config = json.loads(catalog_bytes)
    if config.get("approved") is not True:
        raise ValueError("The product mapping must be reviewed and approved")
    pointer = model_dir / "active_model.txt"
    pointer_bytes = pointer.read_bytes()
    model_path = contained(model_dir, pointer_bytes.decode().strip())
    model_bytes = model_path.read_bytes()
    model_hash = sha(model_bytes)
    if open_model is None:
        import ifcopenshell
        import ifcopenshell.util.element
        open_model = ifcopenshell.open
        get_psets = ifcopenshell.util.element.get_psets
        get_type = ifcopenshell.util.element.get_type
    model = open_model(str(model_path))
    products = {p["id"]: p for p in config["products"]}
    if len(products) != len(config["products"]):
        raise ValueError("Duplicate product IDs")
    document_root = contained(catalog_path.parent, config.get("document_dir", "documents"))
    source_hashes, documents, chunks, seen = {}, {}, [], set()
    for product in products.values():
        if not product.get("manufacturer") or not product.get("model"):
            raise ValueError("Every product needs its actual manufacturer and model")
        for doc in product.get("documents", []):
            if doc.get("approved") is not True or not all(doc.get(k) for k in ("id", "title", "revision", "path")):
                raise ValueError("Every document requires approval and provenance")
            if doc.get("url") and not doc["url"].startswith("https://"):
                raise ValueError("Document reference URLs must use HTTPS")
            key = (product["id"], doc["id"])
            if key in documents:
                raise ValueError("Duplicate document ID for product")
            path = contained(document_root, doc["path"])
            source_hashes[str(path)] = sha(path.read_bytes())
            documents[key] = (doc, read_document(path), source_hashes[str(path)])

    def add(asset, product, source_id, title, revision, page, text, source_hash, url="", ordinal=0):
        # The identity heading is deliberately part of the semantic content.
        content = f"{product['manufacturer']} | {product['model']}\n{text}"
        digest = sha(content.encode())
        chunk_id = sha(canonical([asset["global_id"], product["id"], source_id, revision, page, ordinal, digest]))
        chunks.append({"content": content, "metadata": {
            "chunk_id": chunk_id, "ifc_global_id": asset["global_id"], "product_id": product["id"],
            "source_id": source_id, "source_title": title, "source_revision": revision,
            "page": page, "source_sha256": source_hash, "source_url": url,
            "content_sha256": digest, "embedding_model": MODEL,
        }})

    missing = []
    for asset in config["assets"]:
        gid = asset["global_id"]
        if not re.fullmatch(r"[0-3][0-9A-Za-z_$]{21}", gid) or gid in seen:
            raise ValueError("Invalid or duplicate IFC GlobalId")
        seen.add(gid)
        product = products[asset["product_id"]]
        try:
            element = model.by_guid(gid)
        except RuntimeError:
            element = None
        if element is None:
            missing.append(gid)
            continue  # Omitted from the next generation: removed assets stop matching.
        if not element.is_a(asset["ifc_class"]):
            raise ValueError("Mapped IFC class changed: review product mapping")
        element_type = get_type(element)
        actual_type = getattr(element_type, "GlobalId", None)
        if "ifc_type_global_id" not in asset or asset["ifc_type_global_id"] != actual_type:
            raise ValueError("Mapped IFC type changed: review product mapping")
        psets = get_psets(element)
        for prop in asset.get("properties", []):
            value = psets.get(prop["pset"], {}).get(prop["name"])
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                raise ValueError("Only reviewed scalar IFC properties can be included")
            # Units are explicitly reviewed in the mapping, never inferred by the LLM.
            if isinstance(value, (int, float)) and not isinstance(value, bool) and "unit" not in prop:
                raise ValueError("Numeric IFC property needs an explicit unit (or empty string for dimensionless)")
            text = f"{prop.get('label', prop['name'])}: {value} {prop.get('unit', '')}".strip()
            add(asset, product, "ifc:" + prop["pset"] + "." + prop["name"],
                "IFC property " + prop["pset"] + "." + prop["name"],
                sha(canonical([gid, prop["pset"], prop["name"], text])), "IFC", text, model_hash)
        for (pid, _), (doc, pages, digest) in documents.items():
            if pid != product["id"]:
                continue
            for page, text in pages:
                for index, part in enumerate(split_text(text)):
                    add(asset, product, doc["id"], doc["title"], doc["revision"], page, part, digest, doc.get("url", ""), index)
    # Reject torn snapshots if the active pointer, IFC or any document changed during extraction.
    if pointer.read_bytes() != pointer_bytes or sha(model_path.read_bytes()) != model_hash or catalog_path.read_bytes() != catalog_bytes:
        raise ValueError("Sources changed during extraction; retry")
    if any(sha(Path(p).read_bytes()) != digest for p, digest in source_hashes.items()):
        raise ValueError("Documents changed during extraction; retry")
    chunks.sort(key=lambda c: c["metadata"]["chunk_id"])
    fingerprint = sha(canonical({"model": model_hash, "catalog": sha(catalog_bytes), "chunks": chunks, "embedding_model": MODEL}))
    return {"fingerprint": fingerprint, "model_sha256": model_hash, "observed_at": observed,
            "embedding_model": MODEL, "chunks": chunks, "missing_assets": missing}
