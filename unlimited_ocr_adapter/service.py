"""PDF adapter for Baidu Unlimited OCR's OpenAI-compatible vLLM server."""

from __future__ import annotations

import asyncio
import base64
import os
import re
from typing import Any

import fitz
import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


MODEL = os.getenv("UNLIMITED_OCR_MODEL", "Unlimited-OCR")
VLLM_URL = os.getenv("UNLIMITED_OCR_VLLM_URL", "http://unlimited-ocr:8000").rstrip("/")
PDF_DPI = int(os.getenv("UNLIMITED_OCR_PDF_DPI", "200"))
CONCURRENCY = max(1, int(os.getenv("UNLIMITED_OCR_CONCURRENCY", "1")))
MAX_PDF_BYTES = int(os.getenv("UNLIMITED_OCR_MAX_PDF_BYTES", str(50 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("UNLIMITED_OCR_MAX_PAGES", "500"))
REQUEST_TIMEOUT = float(os.getenv("UNLIMITED_OCR_REQUEST_TIMEOUT", "1200"))

DET_LINE_RE = re.compile(
    r"<\|det\|>\s*([^<\s]+)(?:\s*(\[[^\]]*\]))?\s*<\|/det\|>(.*)",
    re.DOTALL,
)
REF_DET_RE = re.compile(
    r"<\|ref\|>(.*?)<\|/ref\|>\s*<\|det\|>(.*?)<\|/det\|>",
    re.DOTALL,
)
REF_TAG_RE = re.compile(r"<\|/?ref\|>")
DET_TAG_RE = re.compile(r"<\|det\|>.*?<\|/det\|>", re.DOTALL)

app = FastAPI(title="CBM Unlimited OCR adapter", version="1.0.0")


class OCRRequest(BaseModel):
    pdf_b64: str = Field(min_length=8)
    filename: str = "document.pdf"


def decode_pdf(value: str) -> bytes:
    encoded = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("pdf_b64 is not valid base64") from exc
    if len(data) > MAX_PDF_BYTES:
        raise ValueError(f"PDF exceeds {MAX_PDF_BYTES} bytes")
    if not data.startswith(b"%PDF-"):
        raise ValueError("Input is not a PDF")
    return data


def render_pages(data: bytes) -> list[str]:
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise ValueError("PDF cannot be opened") from exc
    try:
        if document.page_count < 1:
            raise ValueError("PDF has no pages")
        if document.page_count > MAX_PAGES:
            raise ValueError(f"PDF exceeds {MAX_PAGES} pages")
        scale = PDF_DPI / 72
        matrix = fitz.Matrix(scale, scale)
        result: list[str] = []
        for page in document:
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            encoded = base64.b64encode(pixmap.tobytes("jpeg", jpg_quality=90)).decode("ascii")
            result.append(f"data:image/jpeg;base64,{encoded}")
        return result
    finally:
        document.close()


def normalize_page(raw: str, index: int) -> dict[str, Any]:
    """Remove grounding boxes while retaining text and explicit figure records."""
    blocks: list[str] = []
    images: list[dict[str, Any]] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        body = "\n".join(current).strip()
        if body:
            blocks.append(body)
        current = []

    for source_line in raw.replace("<PAGE>", "\n").splitlines():
        line = source_line.rstrip()
        if not line:
            flush()
            continue
        match = DET_LINE_RE.match(line)
        if match:
            category = match.group(1).strip().lower()
            bbox = (match.group(2) or "").strip()
            content = REF_TAG_RE.sub("", match.group(3)).strip()
            if category == "image":
                flush()
                figure_id = f"page-{index + 1}-figure-{len(images) + 1}"
                images.append(
                    {
                        "id": figure_id,
                        "image_annotation": {
                            "kind": "document figure",
                            "description": "Unlimited OCR detected a figure region in the source page.",
                            "visible_text": content,
                            "uncertainties": (
                                "The OCR model detects and grounds this figure but does not provide a full visual "
                                f"interpretation. Review the original PDF. Grounding box: {bbox or 'unavailable'}."
                            ),
                        },
                    }
                )
                blocks.append(f"![Detected figure]({figure_id})")
            elif content:
                flush()
                current.append(content)
            continue
        # Alternate upstream form: <|ref|>text/type<|/ref|><|det|>box<|/det|>
        def replace_ref_det(match: re.Match[str]) -> str:
            reference = match.group(1).strip()
            box = match.group(2).strip()
            if reference.lower() == "image":
                figure_id = f"page-{index + 1}-figure-{len(images) + 1}"
                images.append(
                    {
                        "id": figure_id,
                        "image_annotation": {
                            "kind": "document figure",
                            "description": "Unlimited OCR detected a figure region in the source page.",
                            "visible_text": "",
                            "uncertainties": (
                                "The OCR model detects and grounds this figure but does not provide a full visual "
                                f"interpretation. Review the original PDF. Grounding box: {box or 'unavailable'}."
                            ),
                        },
                    }
                )
                return f"![Detected figure]({figure_id})"
            return reference

        line = REF_DET_RE.sub(replace_ref_det, line)
        line = REF_TAG_RE.sub("", DET_TAG_RE.sub("", line)).strip()
        if line:
            current.append(line)
    flush()
    return {"index": index, "markdown": "\n\n".join(blocks).strip(), "images": images, "tables": []}


async def recognize_page(client: httpx.AsyncClient, image_url: str, index: int, gate: asyncio.Semaphore) -> dict[str, Any]:
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "<image>document parsing."},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
        "max_tokens": 8192,
        "temperature": 0.0,
        "skip_special_tokens": False,
        "vllm_xargs": {"ngram_size": 35, "window_size": 128},
    }
    async with gate:
        response = await client.post(f"{VLLM_URL}/v1/chat/completions", json=payload)
    if response.status_code >= 400:
        detail = response.text[:1000]
        raise RuntimeError(f"Unlimited OCR failed on page {index + 1}: HTTP {response.status_code}: {detail}")
    body = response.json()
    try:
        raw = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unlimited OCR returned an invalid response on page {index + 1}") from exc
    if not isinstance(raw, str):
        raise RuntimeError(f"Unlimited OCR returned non-text content on page {index + 1}")
    return normalize_page(raw, index)


@app.get("/health")
async def health() -> dict[str, Any]:
    model_ready = False
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.get(f"{VLLM_URL}/health")
            model_ready = response.status_code == 200
    except httpx.HTTPError:
        pass
    return {"status": "ok", "model": MODEL, "model_ready": model_ready}


@app.post("/ocr")
async def ocr(request: OCRRequest) -> dict[str, Any]:
    try:
        pdf = decode_pdf(request.pdf_b64)
        page_images = await asyncio.to_thread(render_pages, pdf)
        gate = asyncio.Semaphore(CONCURRENCY)
        timeout = httpx.Timeout(REQUEST_TIMEOUT, connect=30)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            pages = await asyncio.gather(
                *(recognize_page(client, image, index, gate) for index, image in enumerate(page_images))
            )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    pages.sort(key=lambda page: page["index"])
    return {
        "model": "baidu/Unlimited-OCR",
        "filename": request.filename,
        "pages": pages,
        "usage_info": {"pages_processed": len(pages)},
    }
