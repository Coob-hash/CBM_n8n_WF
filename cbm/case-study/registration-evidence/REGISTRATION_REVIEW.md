# Registration review — office demo

**Status: approved by the user and installed on 17 September 2026.** The live service confirms registration and returns four candidates for execution 280. The WF1 configuration-pause repair is also installed.

## Proposed transform

Map `MAP_J964JX6MGEGO` → original `Base ufficio.ifc` (metres):

`IFC x = MultiSet x`, `IFC y = -MultiSet z`, `IFC z = MultiSet y`.

```json
[
  [
    1.0,
    0.0,
    0.0,
    0.0
  ],
  [
    0.0,
    0.0,
    -1.0,
    0.0
  ],
  [
    0.0,
    1.0,
    0.0,
    0.0
  ],
  [
    0.0,
    0.0,
    0.0,
    1.0
  ]
]
```

This is a proper rotation (determinant +1), with no translation, scaling or reflection.

## Evidence

- All **7 MultiSet panorama stations** match the original `maddaloni 1.e57` camera centres under this axis conversion. Maximum difference: **0.00000063 m** (rounding of MultiSet coordinates).
- IFC SHA256: `3998286248fe687a4353b4cc3efde8275a2bff617319738942cb8738ac36cdc7`.
- Scan sample: **504,157 points** from 50,415,679, read without changing the source scan.
- Initial structural audit: 446 IFC triangles of at least 0.3 m²; 110 have over 70% of sampled points within 15 cm of the scan, covering 25 elements.
- Independent resampling: **21 distinct structural elements**, spanning three normal directions. Median of per-element median differences: **2.77 cm**; median within-15-cm coverage: **99%**. A 50 cm shift along the surface normal raises the median difference to **38.5 cm**.
- Surface checks use exposed patches; unsampled/occluded geometry is not certified. These measurements support the scan-to-IFC identity transform for this demo, not survey-grade accuracy.

## Execution 280 — proposed result

The stored camera pose would map to `[-2.403297, -0.514284, -0.395825]` metres in IFC coordinates. Offline calculation gives these nearby candidates:

| IFC GlobalId | Class | Distance from camera |
|---|---|---|
| `3kcZF9AH16IwPfuL_CGFlR` | IfcBuildingElementProxy | 1.789 m |
| `1qMgWWNHzE3egAZbWFbgXF` | IfcBuildingElementProxy | 1.804 m |
| `0iXsb6cUbFTwXlliOwbsbD` | IfcDoor | 2.091 m |
| `0iXsb6cUbFTwXlliOwbsaH` | IfcDoor | 2.989 m |

These are spatial candidates, not an automatic choice of the nearest object. The existing vision and IFC matching stages must still identify the photographed asset and describe the issue. No ticket was created or email sent by this validation.

## Installed configuration handling

- `Capture Input` → **`Check IFC Registration`** → `Claim Capture Attempt` → `Capture Accepted?`.
- Registration/configuration faults pause the report as `CONFIGURATION_REQUIRED`, restore the photo allowance and queue an IT configuration notice.
- After registration is enabled, run the **same stored Drive file** through the updated WF1. The report and reserved capture slot resume once; successful/ordinary failed files remain protected from duplicate reprocessing.
- Execution 280's report is now paused with **0 consumed attempts**. Its old pending replacement-photo notice was cancelled; history is preserved.
- **10 PostgreSQL regression tests** and **8 workflow configuration checks** passed. No workflow was activated.

## Approval and deployment

Automatic approval review rejected enabling this registration while the export alignment was uncertain, because a wrong transform could select the wrong IFC asset. The user then explicitly approved this measured transform. It was installed in source and deployment copies; the live IFC endpoint was checked successfully. The retained file can resume, verified in a rolled-back database transaction. No email or ticket-creation workflow was executed.
