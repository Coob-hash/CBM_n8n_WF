"""
MultiSet map frame  ->  IFC project frame:  compute T_map->ifc
=============================================================
The VPS returns poses in the map's own frame; the IFC model lives in its own
project frame. `ifc_service.py` bridges them with a single 4x4 rigid transform
read from the MULTISET_TO_IFC_MATRIX environment variable. This script produces
that matrix, and — more importantly — tells you how much to trust it.

Two ways in
-----------
1. Cloud-to-cloud (preferred, centimetre-level).
   MultiSet publishes every processed map as `PointCloud/map.pcd` (binary PCD,
   XYZ at 5 cm spacing, right-handed, +Z up) on the Map Details page. Align it
   against the survey scan the BIM was modelled on (the Leica .e57) in
   CloudCompare: rough align with 4 picked point pairs, then Fine Registration
   (ICP). CloudCompare prints the 4x4 in the console and can save it to a .txt.
   Feed that file here:

       python calibrate_registration.py --matrix cc_transform.txt

   If the BIM was modelled on that same scan and never moved, T_scan->ifc is the
   identity and you are done. Verify it: import the .e57 into the authoring tool
   and check the cloud lands on the modelled walls. If it does not, register the
   cloud to the model first and compose the two transforms with --compose.

2. Point pairs (fallback, decimetre-level).
   Measure >= 3 non-collinear points — ideally 5-6, spread across the whole
   space and not all at the same height — in both frames, and list them in a
   CSV. Then:

       python calibrate_registration.py --pairs pairs.csv

   CSV columns (a header row is optional):
       label, map_x, map_y, map_z, ifc_x, ifc_y, ifc_z

How good is good enough?
------------------------
Report the RMS this script prints. The threshold is set by how close together
your maintainable elements are: you need the total error budget to stay well
under half the distance between the two nearest ones. In `Base ufficio.ifc` the
closest two doors are 1.20 m apart, so aim for RMS <= 0.15 m and treat anything
above 0.30 m as unusable — widening `max_distance` in the workflow hides the
problem instead of fixing it.

Requires: numpy
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def kabsch(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """Rigid transform (no scale) taking points A onto points B, as a 4x4.

    A, B are (N, 3) arrays of corresponding points. Reflections are suppressed:
    a mirrored 'fit' means the two frames differ in handedness, which a rigid
    transform cannot express and which must be fixed upstream instead (see
    --left-handed).
    """
    ca, cb = A.mean(axis=0), B.mean(axis=0)
    H = (A - ca).T @ (B - cb)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = cb - R @ ca
    return T


def apply(T: np.ndarray, P: np.ndarray) -> np.ndarray:
    P = np.atleast_2d(P)
    return (T[:3, :3] @ P.T).T + T[:3, 3]


def residuals(T: np.ndarray, A: np.ndarray, B: np.ndarray) -> np.ndarray:
    return np.linalg.norm(apply(T, A) - B, axis=1)


# MultiSet queries default to isRightHanded=false, i.e. a left-handed Unity map
# frame; the published map.pcd is right-handed +Z up. Mixing the two is the
# classic "the fit is perfect but mirrored" symptom.
FLIP_Z = np.diag([1.0, 1.0, -1.0, 1.0])


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

def read_pairs(path: Path) -> tuple[list[str], np.ndarray, np.ndarray]:
    labels, A, B = [], [], []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            row = [c.strip() for c in row if c.strip() != ""]
            if len(row) < 6:
                continue
            nums = row[-6:]
            try:
                vals = [float(v) for v in nums]
            except ValueError:
                continue  # header row
            labels.append(row[0] if len(row) == 7 else f"P{len(labels) + 1}")
            A.append(vals[:3])
            B.append(vals[3:])
    if len(A) < 3:
        sys.exit(f"{path}: need at least 3 usable point pairs, found {len(A)}.")
    return labels, np.array(A), np.array(B)


def read_matrix(path: Path) -> np.ndarray:
    """Read a 4x4 from a CloudCompare-style transformation .txt (16 numbers)."""
    nums = []
    for tok in Path(path).read_text().replace(",", " ").split():
        try:
            nums.append(float(tok))
        except ValueError:
            pass
    if len(nums) < 16:
        sys.exit(f"{path}: expected 16 numbers, found {len(nums)}.")
    return np.array(nums[:16], dtype=float).reshape(4, 4)


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def describe(T: np.ndarray) -> None:
    R, t = T[:3, :3], T[:3, 3]
    # Rotation angle from the trace, and the yaw a Z-up frame usually needs.
    ang = np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)))
    yaw = np.degrees(np.arctan2(R[1, 0], R[0, 0]))
    print(f"  translation     ({t[0]:+.4f}, {t[1]:+.4f}, {t[2]:+.4f}) m")
    print(f"  rotation        {ang:.3f} deg total, {yaw:+.3f} deg about Z")
    print(f"  determinant     {np.linalg.det(R):+.6f}  (must be +1)")
    if np.linalg.det(R) < 0:
        print("  !! reflection detected — the two frames differ in handedness.")
        print("     Re-export one side consistently, or pass --left-handed.")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Compute T_map->ifc for ifc_service.py (MULTISET_TO_IFC_MATRIX).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--pairs", type=Path,
                     help="CSV of corresponding points: label,map_xyz,ifc_xyz")
    src.add_argument("--matrix", type=Path,
                     help="4x4 transform from CloudCompare (16 numbers).")
    ap.add_argument("--compose", type=Path,
                    help="Second 4x4 applied after the first, e.g. T_scan->ifc "
                         "when the BIM does not sit on the survey scan.")
    ap.add_argument("--left-handed", action="store_true",
                    help="Negate Z on the map side first. Use when the poses "
                         "come from queries with isRightHanded=false but the "
                         "matrix was computed from the right-handed map.pcd.")
    ap.add_argument("--check", type=Path,
                    help="CSV of point pairs used only to score the transform, "
                         "never to fit it. This is the honest number to report.")
    ap.add_argument("--tolerance", type=float, default=0.15,
                    help="RMS above which the fit is called bad (default 0.15 m).")
    args = ap.parse_args()

    if args.pairs:
        labels, A, B = read_pairs(args.pairs)
        T = kabsch(A, B)
        print(f"\nFitted on {len(A)} point pairs from {args.pairs.name}")
    else:
        T = read_matrix(args.matrix)
        labels = A = B = None
        print(f"\nRead 4x4 from {args.matrix.name}")

    if args.compose:
        T = read_matrix(args.compose) @ T
        print(f"Composed with {args.compose.name}")
    if args.left_handed:
        T = T @ FLIP_Z
        print("Applied left-handed map correction (Z negated on the map side)")

    print("\nTransform")
    describe(T)

    worst = None
    if A is not None:
        r = residuals(T, A, B)
        rms = float(np.sqrt((r ** 2).mean()))
        worst = rms
        print("\nFit residuals (in-sample — optimistic by construction)")
        for lab, d in zip(labels, r):
            print(f"  {lab:<16} {d:7.4f} m")
        print(f"  {'RMS':<16} {rms:7.4f} m     max {r.max():.4f} m")

    if args.check:
        labels_c, Ac, Bc = read_pairs(args.check)
        r = residuals(T, Ac, Bc)
        rms = float(np.sqrt((r ** 2).mean()))
        worst = rms
        print(f"\nHold-out residuals ({args.check.name} — report this one)")
        for lab, d in zip(labels_c, r):
            print(f"  {lab:<16} {d:7.4f} m")
        print(f"  {'RMS':<16} {rms:7.4f} m     max {r.max():.4f} m")

    if worst is not None:
        if worst <= args.tolerance:
            print(f"\n  OK — RMS {worst:.4f} m is within {args.tolerance} m.")
        else:
            print(f"\n  TOO COARSE — RMS {worst:.4f} m exceeds {args.tolerance} m.")
            print("  Add better-spread correspondences, or register the clouds "
                  "instead of picking points by hand.")

    flat = json.dumps([[round(v, 9) for v in row] for row in T.tolist()])
    print("\nSet this before launching the service:")
    print(f"\n  PowerShell:  $env:MULTISET_TO_IFC_MATRIX = '{flat}'")
    print(f"  bash:        export MULTISET_TO_IFC_MATRIX='{flat}'")
    print("\n  Leave AXIS_MODE=identity — this matrix already carries the axis swap.\n")


if __name__ == "__main__":
    main()
