# Run the Maddaloni office case study

This revision uses your **Base ufficio.ifc** and your eleven iPhone photographs. It replaces the synthetic-model setup. The original IFC, Revit file, scans, photos and old `queries.json` remain untouched. The active APIs work on a versioned copy of the original IFC.

The complete demonstration is: upload an original photo to Drive → automatic VPS/IFC/vision identification → FM authorizes the intervention → dispatch → technician report → separate FM completion acceptance → new office IFC version → dashboard. Unresolved identification requests another photo, up to three replacements after the original; continued failure creates an IT bug and notification. The FM does not identify or correct the target asset. Camera localization still requires verified map registration and a supported automatic object match.

The main [CBM tutorial](<C:/Users/USER/Desktop/n8n_deploy/CBM_Demo_Tutorial.md>) still explains all eight WF1 entry points, dispatch helpers, WF2, WF3 and both knowledge pipelines. Start here for case-specific inputs and commands.

## 1. The files and their roles

| Input | Role in this demo |
|---|---|
| `Case_Study/case_study_e57/Base ufficio.ifc` | Runtime building model; IFC2X3 with metre units |
| `Base ufficio.rvt` | Authoring source; not read or modified by the Python runtime |
| `case_study_e57/e57/maddaloni 1.e57` | Confirmed source of MultiSet map `MAP_J964JX6MGEGO` |
| `FOTO CASO STUDIO/IMG_7911.JPG` through `IMG_7921.JPG` | Original user photographs to upload through the Drive trigger |
| `images360/*.jpg` | Scan panoramas/reference material; not iPhone pinhole captures |
| Old `query_ready/queries.json` | Audited historical output; not an input to WF1 |
| New `n8n_deploy/cbm/case-study/query-verified/` | Regenerated diagnostic JPEGs, per-image provenance and corrected API request examples |

The source root on this computer is `C:\Users\USER\Desktop\Progetti Dottorato\ISTEA_2026\Case_Study`.

The IFC copy under `Point_Cloud E57/leica_scan` is byte-identical to the selected IFC. There are several E57 exports, and they are not interchangeable: the selected `maddaloni 1.e57` contains 42 image records, `maddaloni 2.e57` has 24, and `Istea_Case_study_2.e57` has none. The map/source relationship above comes from your confirmation. These metadata checks do not certify the provider's processed map or the scan-to-BIM registration. MultiSet's Leica workflow expects structured E57 reference imagery. [Leica import documentation](https://docs.multiset.ai/multiset/fundamentals/third-party-scans/leica-scans).

The E57 and RVT files do not belong in the Python image. The E57 has already supplied the remote localization map; n8n sends query photographs to that map. The IFC supplies asset IDs, properties and maintenance history locally.

The downloadable package includes the IFC copy and normalized diagnostic images/requests. The large E57/RVT files and original full-resolution photographs stay in your source folder. To prepare uploads on another computer, copy the originals there and update `original_photo_directory` in `cbm/case-study/profile.json`; keep their audited hashes intact. Uploads to Drive can continue from your present computer even when the containers run on a VPS.

## 2. What the photo and JSON audit established

All eleven originals have a 5712 × 4284 primary image, intact Apple/iPhone 16 EXIF, the 5.96 mm wide-camera lens, and a reported 26 mm equivalent focal length. The first four use EXIF Orientation 6; the remaining seven use Orientation 1. The normalizer selects image frame zero, converts the embedded colour profile, applies orientation, and resizes pixels and intrinsics together.

| Files | Transmitted size | fx = fy | px | py |
|---|---:|---:|---:|---:|
| IMG_7911–IMG_7914 | 960 × 1280 | 924.4444 | 480 | 640 |
| IMG_7915–IMG_7921 | 1280 × 960 | 924.4444 | 640 | 480 |

Every old JPEG's stored hash was correct. Reprocessing every original reproduced the old JPEG bytes exactly. Its image rotation, dimensions and numbers are internally consistent with the documented **width-based EXIF estimate** `f35 × source_width / 36`.

What was wrong or overstated:

- The old manifest points at a source subfolder that does not exist in the supplied layout.
- Its principal-point labels are `cx/cy`; the MultiSet request uses `px/py`.
- `trusted: true` means the arithmetic passed a plausibility gate. It does not prove factory calibration, image-to-model accuracy or a seven-centimetre error bound.
- The 35 mm equivalent does not reveal the exact principal point, per-frame stabilization, distortion, or an independently verified width/diagonal convention. No numerical accuracy guarantee can be recovered from this JSON.
- The old n8n JSON request used flat intrinsics fields; the case-study workflow now sends the documented nested request structure.

The new metadata explicitly says `source: EXIF_ESTIMATE`, `calibrated: false`, `accuracy_verified: false`, and records the formula and original-photo hash. The compatibility field `trusted` remains a **plausibility** result so existing workflow fields remain usable. A plausible estimate is accepted for a VPS trial, while asset identity is selected automatically from registered IFC candidates and visible evidence.

These are already photographs taken on an iPhone. They do not need fabricated iPhone metadata. A future native capture app can supply a real matrix tied to its actual captured buffer and reference dimensions; rescaling an unrelated ARKit video matrix onto a saved high-resolution still is not established calibration for that still. [Apple matrix reference dimensions](https://developer.apple.com/documentation/avfoundation/avcameracalibrationdata/intrinsicmatrixreferencedimensions), [ARKit image resolution](https://developer.apple.com/documentation/arkit/arcamera/imageresolution).

**For the Drive-trigger demo, upload original photos, not the normalized diagnostic JPEGs.** The original EXIF is needed by `/captures/normalize`. The diagnostic JPEGs intentionally have no EXIF and must travel with their matching request metadata; dropping one of them alone into the original-photo path requests a replacement photo.

## 3. The active model and persistent storage

The import service checks the source IFC's SHA-256 and the expected target IDs, then copies it as `office_v1.ifc` without editing its contents. Later maintenance writes create `office_v2.ifc`, `office_v3.ifc`, and so on. `model_origin.json` records the source identity. Restarting preserves the active version; a conflicting or incomplete lineage is not regenerated.

| Store | Location |
|---|---|
| Original n8n workflows, credentials and executions | Existing `C:\Users\USER\Desktop\n8n_test` |
| Case-study IFC versions and audit | `n8n_deploy_cbm_case_models` Docker volume |
| Case-study tickets and events | `n8n_deploy_cbm_case_postgres` Docker volume |
| Immutable IFC input and diagnostic requests | `n8n_deploy/cbm/case-study`, mounted read-only in Python containers |
| Previous synthetic IFC/database | Preserved in the former `n8n_deploy_cbm_models` and `n8n_deploy_cbm_postgres` volumes |

Both Python services share the case-study model volume; knowledge reads it read-only. The application database connection remains host `cbm-postgres`, database `cbm_demo`, user `cbm_app`. Its private password is preserved in `cbm/cbm.env`; this update reuses the existing case-study business state and adds the intake migration.

From PowerShell 7.3 or newer:

```powershell
Set-Location -LiteralPath 'C:\Users\USER\Desktop\n8n_deploy'
.\Test-Cbm.ps1
.\Cbm-Compose.ps1 ps -a
```

Expect an `office_v*.ifc` active file and **13 maintainable assets**: seven doors, four windows and two proxies. `ifc-init` exiting with code zero is normal. No sample generator is used or included in the runtime image.

Import and manually run `cbm/Runtime-Check.json` for Code-node HTTP/binary support, Python report extraction, the real IFC asset set and honest camera metadata. This diagnostic does not call MultiSet or send messages.

## 4. Know the real asset IDs

| Physical role suggested by IFC authoring metadata | Actual IFC class | GlobalId |
|---|---|---|
| Radiator | IfcBuildingElementProxy | `3kcZF9AH16IwPfuL_CGFlR` |
| Electrical outlet box | IfcBuildingElementProxy | `1qMgWWNHzE3egAZbWFbgXF` |

The radiator's family name contains `HVAC_Heaters_Fondital_Calidor Super B4 BC 800 V03`. The electrical family contains `L22_EF_Box 503`. These are authoring labels, not proof that the installed product exactly matches that manufacturer's model. We preserve the original classes and GlobalIds; changing them to `IfcSpaceHeater` or `IfcOutlet` would change your model rather than merely configure the demo.

The photos mainly show a radiator and the adjacent electrical fitting. IMG_7914 is a close view of the fitting; IMG_7911/7912 and IMG_7915–7918 give broader views of the radiator/room. Several show both. Use the [contact sheet](<C:/Users/USER/Desktop/n8n_deploy/cbm/case-study/photos-contact-sheet.jpg>) to choose a scenario, then verify the object in the model. Visibility of a radiator does not prove that it leaks or fails to heat. Record an actual reported symptom or explicitly label a simulated inspection scenario.

The source radiator and outlet insertion points are close together. Object-placement translations can also differ from visible surface centres. Picking the closest insertion point to the **camera** is therefore not a reliable object-selection method, even with perfect camera localization.

## 5. Connect n8n to your MultiSet map

The installer sets `MULTISET_MAP_CODE=MAP_J964JX6MGEGO` in `cbm/cbm.env` while preserving private tokens/passwords. In n8n, create a **Basic Auth** credential for MultiSet: username is the M2M client ID; password is the client secret. Bind it to `MultiSet - Get Token` and the separate diagnostic's token node. No matching credential was present during inspection, so no live localization result is claimed here.

The token request is a POST to `/v1/m2m/token` with Basic Authentication and no request body. Its returned `token` becomes the Bearer token for the map query. Enter secrets privately in n8n, not in these example files. [MultiSet authentication](https://docs.multiset.ai/multiset/fundamentals/rest-api-docs/authentication).

WF1 builds this request from the normalized photograph:

```json
{
  "mapCode": "MAP_J964JX6MGEGO",
  "isRightHanded": true,
  "resolution": {"width": 960, "height": 1280},
  "cameraIntrinsics": {"fx": 924.4444, "fy": 924.4444, "px": 480, "py": 640},
  "queryImage": "data:image/jpeg;base64,<matching portrait JPEG bytes>"
}
```

Send it to `https://api.multiset.ai/v1/vps/map/query`. Landscape photos use their own dimensions and principal point. The JSON file describes a request, not an iPhone emulator or a saved localization result. [Map Query reference](https://docs.multiset.ai/multiset/fundamentals/rest-api-docs/map-query).

To test the map before creating tickets:

1. Import `cbm/Case-Study-Localization-Check.json` into n8n.
2. Bind its MultiSet Basic Auth credential.
3. Execute manually. This sends the eleven normalized case-study images to the specified map and uses your provider's query allowance.
4. Inspect `Localization Results`. It reports each file, its source hash, pose success, confidence, position, quaternion and returned map codes. It creates no tickets and sends no email.
5. Keep the resulting positions with their declared coordinate frame. A successful pose is a camera localization, not confirmation that the radiator was identified.

The diagnostic is separate from the 14 application workflows. It should remain manual. A close crop of the fitting can contain fewer scene features than a wider view; measure the actual results rather than assuming every image will localize.

## 6. Coordinate registration and automatic identification

The case-study query requests **right-handed Y-up** poses. IFC project coordinates are Z-up. The former `isRightHanded:false`/identity combination was unsuitable as an assumed case-study transform. MultiSet's documented LHS/RHS conversion mirrors **X**, not Z; the copied calibration utility was corrected accordingly. [Coordinate conventions](https://docs.multiset.ai/fundamentals/localization/coordinate-systems).

The source E57 and IFC have compatible-looking local extents, but that alone does not establish the processed map's origin, rotation or scale. Do not set identity merely because the map was created from the same scan.

`cbm/case-study/registration.json` initially contains `approved:false` and `matrix:null`. A reviewed matrix must transform the complete **MultiSet RHS Y-up metre frame directly into IFC project metres**. It includes any axis rotation and translation. Do not apply another `AXIS_MODE` transformation to it. The API checks the map code, source IFC hash, matrix shape, finiteness, orthogonality and determinant.

To calculate a candidate transform, collect corresponding physical points in the declared map frame and IFC frame, with several well-spread non-collinear fit points and separate hold-out checks. The CSV columns are:

```text
label,map_x,map_y,map_z,ifc_x,ifc_y,ifc_z
```

Do not use the nearest radiator coordinate as the IFC counterpart of a camera pose. Correspondences must represent the same physical point.

The optional calibration utility is available inside the Python image. Put measured CSVs in a local directory and mount it read-only for a one-off calculation:

```powershell
.\Cbm-Compose.ps1 run --rm -v 'C:/YOUR_REGISTRATION_FOLDER:/measurements:ro' ifc-init python /app/calibrate_registration.py --pairs /measurements/pairs.csv --check /measurements/check.csv
```

The fit is a candidate until its held-out residuals and alignment are reviewed. The command prints a matrix; for this case-study deployment, put that matrix and your evidence in `registration.json`, with the matching map/source identity. Do not follow the legacy utility's generic environment-variable output for this case. Use RHS input pairs without `--left-handed`; that flag is only for explicitly documented LHS input.

Until registration is verified, `/case-study/resolve` returns `found:false`, reason `REGISTRATION_REQUIRED`. After verification it returns nearby **candidates** for the existing vision-model call to identify the photographed asset automatically. The old `/elements/nearest` shortcut is disabled in this case-study deployment. WF1 validates the model-selected GUID against that candidate list, requires explicit non-ambiguity and confidence at least 0.8, and requests another photo if unresolved. This selection still needs live accuracy validation; it is not guaranteed by EXIF or camera position alone.

## 7. Prepare the actual Drive interaction

Use the new [intake and approval guide](<C:/Users/USER/Desktop/n8n_deploy/INTAKE_APPROVAL_GUIDE.md>) for the SQL migration, configuration/import steps and exact photo-retry commands. Workflow names begin `[CBM Intake Approval 2026.09.15]`; IDs begin `cbmIntake20260915`. The case-study database/IFC volumes are reused. Previous workflow versions remain separate and must not watch the same folder concurrently.

Prepare one photo with `Prepare-CaseStudyPhotos.ps1 -ReporterEmail 'YOUR_CONTROLLED_REPORTER_EMAIL' -Photo 'IMG_7911.JPG'`. The script preserves the original bytes and EXIF and adds a report UUID to its filename. Upload the prepared copy. If a retry is requested, choose another original and rerun the script with the same `-ReportId`. Upload as a new Drive file; do not replace or rename the old file.

The initial photo plus at most three replacements belong to one report. Failures create retry records, not FM triage tickets. After the fourth failed capture, a bug issue is recorded and IT is notified at the configured address, default `giuseppe.desiderio123@gmail.com`. The FM never selects or corrects the target asset. The separate eleven-photo diagnostic remains the right tool for comparing localization success across the whole photo set without creating application reports.

## 8. Complete one real-model maintenance lifecycle

A successful registered VPS/vision identification creates a `PENDING_AUTHORIZATION` maintenance request. The FM reviews the proposed intervention through an email confirmation form. GET only displays; explicit POST approval releases dispatch. Rejection creates no technician offer. The form contains no GlobalId editing. Only the identification system chooses the asset.

After approval, the existing technician offer/assignment process continues. Submit the optional after-photo and `TICKET-<id>.pdf` completion report, then obtain the separate WF2 FM acceptance. Approved completion writes the existing versioned maintenance log to the automatically identified real IFC element, while preserving the original `Base ufficio.ifc`. WF3 shows the history; rejected requests are excluded from open work.

If registration is still unverified or the photograph remains ambiguous, demonstrate the bounded retry/IT escalation path instead of inventing an asset match. A passing mock-provider workflow test is not evidence that the real map has been registered or the real photos identified accurately.

## 9. Knowledge and 360-degree images

The approved knowledge catalog remains empty until actual product applicability and documents are reviewed. The radiator's Revit family name suggests Fondital; the previously supplied Kermi PDFs must not be attached to it merely because both are radiators. Those PDFs remain inputs to WF1's independent OCR demonstration, not verified maintenance guidance for this office.

To populate production retrieval, use the real proxy GlobalId and real type GlobalId, review the physical product identity, and configure the corresponding product documents/properties in `cbm/catalog/catalog.local.json`. The API never infers physical product applicability from a filename alone.

The seven panoramas are 2:1 equirectangular images, 4096 × 2048 or 8192 × 4096, with no EXIF camera tags. Keep them out of the phone-photo Drive path. If testing them separately, MultiSet documents a form-data query with `imageType=equirect`; that mode does not use pinhole intrinsics. The supplied eleven-photo diagnostic uses ordinary pinhole queries only. [Panorama query mode](https://docs.multiset.ai/multiset/fundamentals/rest-api-docs/map-query).

## 10. What has been verified and what remains to measure

The audit verified all eleven original/normalized pairs, source IFC identity, real asset IDs, E57 image-record metadata and query payload structure. Offline tests exercised lossless IFC import/restart, IFC2X3 maintenance writing and replay, preservation of original geometry/product IDs, knowledge reads of the resulting version, all eleven query payloads, registration rejection, and spatial candidate generation for automatic identification.

Runtime/container verification is recorded separately in `cbm/case-study/validation/deployment-validation.json` and `intake-runtime.json`. The latter tests retries and business authorization using isolated provider/mail simulators. The MultiSet map has not been queried without your credential. Its success rate and geometric registration must be measured using the diagnostic and real correspondences. Source EXIF and `poseFound:true` alone do not prove the photo-to-asset association.

For normal operation use `Cbm-Compose.ps1 stop` and `Cbm-Compose.ps1 up -d`. Use `Start-Cbm.ps1` for backed-up image updates. Keep the original encryption key, the case-study PostgreSQL volume and the IFC lineage; do not use `down -v` as a routine restart.
