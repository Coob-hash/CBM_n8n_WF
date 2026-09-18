"""
Capture normalisation: loose smartphone photograph -> MultiSet VPS query image.

Sits alongside `ifc_service.py` for the same reason that file gives: Pillow, like
IfcOpenShell, is a compiled library and cannot run inside an n8n Code node. The n8n
deployment permits only `pdf-parse` as an external module, so the rotate/resize/EXIF work
has to live in the service that n8n already calls on port 8000.

What it fixes in `WF1 -> Prepare Image & Metadata`, which currently:

  * fabricates intrinsics from a fixed `HFOV_DEG = 69` constant, which is only correct for
    a ~26 mm-equivalent lens and is badly wrong for an ultrawide or a telephoto;
  * ignores the EXIF Orientation tag entirely, so a portrait capture is sent to MultiSet as
    a sideways landscape buffer and cannot match an upright map;
  * never downscales, so a modern phone photograph exceeds MultiSet's documented limit of
    1280 px on the longer side;
  * ignores the ICC profile, so Display P3 pixels are sent as though they were sRGB.

The transform pipeline is the one specified in the project's INTRINSICS note. Each
transform is applied to the image and to K in the same operation, so the two cannot drift:

    sensor frame --rotate(k quarter-turns CW)--> upright frame --resize(s)--> transmitted

Intrinsics come from the EXIF estimate `fx = f35 * W / 36`. This is brand-agnostic and
needs no per-device configuration: FocalLengthIn35mmFilm describes the lens that actually
took the photograph, so a 0.5x or 3x capture is handled correctly with no constant to tune.

Used two ways:

    # as a module, from ifc_service.py
    from capture_normalize import normalize_jpeg
    result = normalize_jpeg(jpeg_bytes)

    # as a CLI, to convert a folder
    python capture_normalize.py "<src folder>" "<out folder>"

Requires Pillow, in addition to ifc_service.py's own dependencies:

    pip install Pillow
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys

from PIL import Image, ImageCms
from PIL.ExifTags import TAGS

MAX_UPLOAD_LONG_SIDE = 1280       # MultiSet query limit on the longer side
FULL_FRAME_WIDTH_MM = 36.0        # the width the 35 mm equivalent is defined against
JPEG_QUALITY = 92

# EXIF Orientation -> quarter-turns clockwise needed to make the pixels upright.
# Mirrored orientations (2, 4, 5, 7) are not produced by phone cameras; refuse rather
# than guess, because guessing wrong rotates the ray by 90 degrees in silence.
QUARTER_TURNS_CW = {1: 0, 6: 1, 3: 2, 8: 3}

SRGB_PROFILE = ImageCms.createProfile("sRGB")


class CaptureRejected(Exception):
    """The photograph cannot be turned into a trustworthy query image."""


# ---------------------------------------------------------------------------
# Intrinsics
# ---------------------------------------------------------------------------

def rotate_k(cam: dict, k: int) -> dict:
    """Transform K by k quarter-turns clockwise. INTRINSICS note, section 2.1."""
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    w, h = cam["width"], cam["height"]
    if k == 0:
        return dict(fx=fx, fy=fy, cx=cx, cy=cy, width=w, height=h)
    if k == 1:
        return dict(fx=fy, fy=fx, cx=h - cy, cy=cx, width=h, height=w)
    if k == 2:
        return dict(fx=fx, fy=fy, cx=w - cx, cy=h - cy, width=w, height=h)
    if k == 3:
        return dict(fx=fy, fy=fx, cx=cy, cy=w - cx, width=h, height=w)
    raise ValueError("k must be 0..3, got {}".format(k))


def resize_to(cam: dict, out_w: int, out_h: int) -> dict:
    """Scale K to a new resolution using the realised per-axis ratios, not the
    requested factor: integer rounding of the output size makes them differ."""
    sx = out_w / cam["width"]
    sy = out_h / cam["height"]
    return dict(fx=sx * cam["fx"], fy=sy * cam["fy"],
                cx=sx * cam["cx"], cy=sy * cam["cy"],
                width=out_w, height=out_h)


def gate(cam: dict) -> list:
    """Plausibility check on the final transmitted-frame K. Never repairs a value:
    a silently substituted fallback is what produces confidently wrong GlobalIds."""
    w, h = cam["width"], cam["height"]
    fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]
    out = []
    if not all(map(lambda v: v == v and abs(v) != float("inf"), (fx, fy, cx, cy))):
        return ["non-finite value in K"]
    if not (0.3 * w <= fx <= 2.5 * w):
        out.append("fx {:.1f} outside [{:.0f}, {:.0f}]".format(fx, 0.3 * w, 2.5 * w))
    if not (0.3 * h <= fy <= 2.5 * h):
        out.append("fy {:.1f} outside [{:.0f}, {:.0f}]".format(fy, 0.3 * h, 2.5 * h))
    if not (0.30 * w <= cx <= 0.70 * w):
        out.append("px {:.1f} outside [{:.0f}, {:.0f}]".format(cx, 0.30 * w, 0.70 * w))
    if not (0.30 * h <= cy <= 0.70 * h):
        out.append("py {:.1f} outside [{:.0f}, {:.0f}]".format(cy, 0.30 * h, 0.70 * h))
    if max(fx, fy) > 0 and abs(fx - fy) / max(fx, fy) > 0.05:
        out.append("fx/fy disagree by {:.1%} (> 5%)".format(abs(fx - fy) / max(fx, fy)))
    return out


# ---------------------------------------------------------------------------
# Pixels
# ---------------------------------------------------------------------------

def _exif(img: Image.Image) -> dict:
    ex = img.getexif()
    out = {TAGS.get(k, k): v for k, v in ex.items()}
    try:
        out.update({TAGS.get(k, k): v for k, v in ex.get_ifd(0x8769).items()})
    except Exception:
        pass
    return out


def _to_srgb(img: Image.Image, icc: bytes | None) -> Image.Image:
    if not icc:
        return img.convert("RGB")
    try:
        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        return ImageCms.profileToProfile(img, src, SRGB_PROFILE, outputMode="RGB")
    except Exception:
        return img.convert("RGB")


def normalize_jpeg(data: bytes, long_side: int = MAX_UPLOAD_LONG_SIDE,
                   quality: int = JPEG_QUALITY) -> dict:
    """Normalise one photograph. Returns the transmitted JPEG bytes and the K that
    belongs to exactly those pixels. Raises CaptureRejected when K cannot be derived."""
    try:
        img = Image.open(io.BytesIO(data))
        img.seek(0)                      # MPO container: frame 0, never the HDR gain map
        src_w, src_h = img.size
    except Exception as exc:
        # Well-formed base64 that is not an image still reaches here, so this is a
        # client error, not a service fault.
        raise CaptureRejected("not a decodable image: {}".format(exc))
    ex = _exif(img)

    orientation = int(ex.get("Orientation", 1) or 1)
    if orientation not in QUARTER_TURNS_CW:
        raise CaptureRejected(
            "mirrored or unknown EXIF Orientation {}; refusing to guess".format(orientation))
    k = QUARTER_TURNS_CW[orientation]

    f35 = ex.get("FocalLengthIn35mmFilm")
    if not f35 or float(f35) <= 0:
        # A physical focal length with no sensor width cannot produce a focal length in
        # pixels, and inventing a sensor size is the silent fallback this replaces.
        raise CaptureRejected("no FocalLengthIn35mmFilm in EXIF; cannot derive intrinsics")
    f35 = float(f35)

    f_px = f35 * src_w / FULL_FRAME_WIDTH_MM
    cam = dict(fx=f_px, fy=f_px, cx=src_w / 2.0, cy=src_h / 2.0, width=src_w, height=src_h)

    pixels = _to_srgb(img, img.info.get("icc_profile"))
    if k:
        pixels = pixels.rotate(-90 * k, expand=True)     # PIL rotates CCW; negate for CW
    cam = rotate_k(cam, k)
    if (pixels.width, pixels.height) != (cam["width"], cam["height"]):
        raise CaptureRejected("internal: pixel and K frames disagree after rotation")

    scale = long_side / max(pixels.size)
    out_w = max(1, round(pixels.width * scale))
    out_h = max(1, round(pixels.height * scale))
    pixels = pixels.resize((out_w, out_h), Image.LANCZOS)
    cam = resize_to(cam, out_w, out_h)

    buf = io.BytesIO()
    pixels.save(buf, "JPEG", quality=quality, optimize=True)   # no exif= : tags dropped
    jpeg = buf.getvalue()

    # The invariant, re-checked against the JPEG that was actually encoded.
    if Image.open(io.BytesIO(jpeg)).size != (cam["width"], cam["height"]):
        raise CaptureRejected("internal: encoded JPEG does not match K frame")

    rejections = gate(cam)
    return {
        "jpeg": jpeg,
        "image": {
            "width": out_w, "height": out_h, "mime_type": "image/jpeg",
            "sha256": hashlib.sha256(jpeg).hexdigest(), "byte_length": len(jpeg),
            "orientation_applied": k, "source_width": src_w, "source_height": src_h,
            "scale": round(scale, 6),
        },
        # px/py rather than cx/cy: this is the naming the MultiSet query body and the
        # existing WF1 node already use, so the result drops straight in.
        "camera": {
            "source": "EXIF_ESTIMATE", "trusted": not rejections,
            "calibrated": False,
            "quality": "PLAUSIBLE_ESTIMATE" if not rejections else "REJECTED_ESTIMATE",
            "method": "f35_times_source_width_divided_by_36",
            "principal_point_assumption": "image_center",
            "accuracy_verified": False,
            "fx": round(cam["fx"], 4), "fy": round(cam["fy"], 4),
            "px": round(cam["cx"], 4), "py": round(cam["cy"], 4),
            "width": out_w, "height": out_h,
            "lens": ex.get("LensModel"),
        },
        "provenance": {
            "exif_orientation": orientation, "focal_length_35mm": f35,
            "focal_length_mm": float(ex.get("FocalLength", 0) or 0) or None,
            "make": ex.get("Make"), "model": ex.get("Model"),
            "datetime_original": ex.get("DateTimeOriginal"),
            "original_sha256": hashlib.sha256(data).hexdigest(),
        },
        "gate_rejections": rejections,
    }


def normalize_b64(image_b64: str, long_side: int = MAX_UPLOAD_LONG_SIDE) -> dict:
    """Base64 in, base64 out. The form `ifc_service` exposes to n8n."""
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[-1]
    try:
        data = base64.b64decode(image_b64, validate=True)
    except Exception as exc:
        raise CaptureRejected("imageB64 is not valid base64: {}".format(exc))
    result = normalize_jpeg(data, long_side=long_side)
    jpeg = result.pop("jpeg")
    result["imageB64"] = base64.b64encode(jpeg).decode("ascii")
    return result


# ---------------------------------------------------------------------------
# CLI: convert a folder
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Convert a folder of photographs into MultiSet query images.")
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--long-side", type=int, default=MAX_UPLOAD_LONG_SIDE)
    ap.add_argument("--quality", type=int, default=JPEG_QUALITY)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    files = sorted(os.path.join(a.src, f) for f in os.listdir(a.src)
                   if f.lower().endswith((".jpg", ".jpeg")))
    if not files:
        print("no JPEGs in " + a.src, file=sys.stderr)
        return 1

    results = []
    for path in files:
        name = os.path.basename(path)
        with open(path, "rb") as fh:
            data = fh.read()
        try:
            r = normalize_jpeg(data, a.long_side, a.quality)
        except CaptureRejected as exc:
            results.append({"file": name, "status": "REJECTED", "reason": str(exc)})
            continue
        stem = os.path.splitext(name)[0]
        out_path = os.path.join(a.out, stem + ".jpg")
        with open(out_path, "wb") as fh:
            fh.write(r.pop("jpeg"))
        r["file"], r["status"], r["output"] = name, "OK", stem + ".jpg"
        results.append(r)

    with open(os.path.join(a.out, "queries.json"), "w", encoding="utf-8") as fh:
        json.dump({"source_folder": a.src, "long_side": a.long_side,
                   "captures": results}, fh, indent=2)

    hdr = "{:<15}{:<5}{:<3}{:<12}{:<9}{:<9}{:<8}{:<8}{}".format(
        "file", "ori", "k", "out", "fx", "fy", "px", "py", "trusted")
    print(hdr)
    print("-" * len(hdr))
    for r in results:
        if r["status"] != "OK":
            print("{:<15}REJECTED  {}".format(r["file"], r["reason"]))
            continue
        c, i = r["camera"], r["image"]
        print("{:<15}{:<5}{:<3}{:<12}{:<9.2f}{:<9.2f}{:<8.1f}{:<8.1f}{}".format(
            r["file"], r["provenance"]["exif_orientation"], i["orientation_applied"],
            "{}x{}".format(c["width"], c["height"]),
            c["fx"], c["fy"], c["px"], c["py"], c["trusted"]))
        for rej in r["gate_rejections"]:
            print("{:<15}  gate: {}".format("", rej))
    ok = sum(1 for r in results if r["status"] == "OK" and r["camera"]["trusted"])
    print("\n{}/{} query-ready -> {}".format(
        ok, len(results), os.path.join(a.out, "queries.json")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
