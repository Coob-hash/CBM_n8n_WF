# WF1 — Node-by-node configuration, nodes 1 → 7

**Goal of this tutorial.** Get the *Intake & Localization* half of `CBM WF1 — Ticket
Intake & Dispatch` running end-to-end on a single toy case:

> A reporter uploads a photo of **a door** to Google Drive. n8n localizes the photo
> against your MultiSet map, and node 7 answers with the **IFC GlobalId of that
> door** in `Base ufficio.ifc`.

Everything after node 7 (duplicate check, vision triage, ticket creation,
dispatch loop) is out of scope here and can stay unconfigured.

| # | Node | Type | What it must produce |
|---|------|------|----------------------|
| 1 | Drive Trigger - New Snapshot | Google Drive Trigger | `id`, `name`, `webViewLink` of the new photo |
| 2 | Download Snapshot | Google Drive | binary property `data` |
| 3 | Prepare Image & Metadata | Code | base64 + `width/height/fx/fy/px/py` + `reporterEmail` |
| 4 | MultiSet - Get Token | HTTP Request | `token` (JWT, 30 min) |
| 5 | MultiSet - Localize Snapshot | HTTP Request | `poseFound`, `position{x,y,z}`, `confidence` |
| 6 | Confidence Gate | IF | true → node 7, false → triage branch |
| 7 | Find IFC Element | HTTP Request | `global_id`, `name` of the matched door, `distance` |

> **Note.** The workflow JSON in this folder has been corrected to match the real
> MultiSet and IFC-service APIs — see §11 for the list. Re-import
> `wf1_ticket_intake_and_dispatch.json` before following the steps below; the
> previous copy is kept in `Old/`.

---

## 0. Prerequisites checklist

Tick all of these before touching n8n. Each one is a hard blocker.

- [ ] **MultiSet map uploaded and processed.** In the MultiSet console the map
      status must be *Ready/Processed*, not *Processing*. Copy its **`mapCode`**
      (looks like `MAP_RJFKKWQ1787J`).
- [ ] **MultiSet M2M credentials** — `clientId` + `clientSecret` from the console.
- [ ] **A door that is inside the mapped area**, and a photo of it taken from a
      spot the mapping video actually covered.
- [ ] **The case-study IFC** — `Case_Study/Base ufficio.ifc` (IFC2X3, Revit 2023,
      metres). 7 doors, 4 windows, 2 proxies (one is the Fondital radiator) —
      13 maintainable elements, all on *Livello 2*.
- [ ] **`T_map→ifc` computed** — see §1. Without it node 7 answers confidently
      and wrongly.
- [ ] **Google Drive folder** `01_incoming_snapshots` — copy its ID from the URL:
      `https://drive.google.com/drive/folders/`**`<THIS_PART>`**.
- [ ] **PostgreSQL** with `schema.sql` applied (only needed for the *false*
      branch of node 6; you can disable those two nodes while testing).
- [ ] **The IFC microservice running** — see §8.1.
- [ ] **You know where your n8n runs** (desktop / Docker / Cloud). This decides
      the URL in node 7 and whether you need a tunnel. See §8.2.

---

## 1. Before n8n: calibrate the map to the model

This is the step that silently breaks everything if you skip it, so do it first.
It is a **one-off**: solve it once, store a 4×4 matrix, and no node in the
workflow ever thinks about coordinate frames again.

### 1.0 — What the problem actually is

MultiSet returns a pose in **its own map frame** — origin wherever you started
the scan, axes set by how you held the phone. `Base ufficio.ifc` lives in **its
own project frame** — the Revit origin, Z-up, metres. The two are related by a
rigid transform (3 rotations + 3 translations) that nobody has measured yet.
`ifc_service.py` applies it via `MULTISET_TO_IFC_MATRIX` before searching for
the nearest element.

**Yes, calibration solves this completely.** It is a standard registration
problem, and the only real question is how accurate you need to be.

### 1.1 — Your accuracy budget: 0.60 m, and you should aim for 0.15 m

Read it straight off the model. The seven doors in `Base ufficio.ifc`:

| Door | Position (IFC, m) |
|------|-------------------|
| Porta 80×210 `:14415` | −8.983, −3.704, −1.300 |
| Porta 80×210 `:14433` | −7.615, +0.772, −1.300 |
| Porta 80×210 `:14639` | −7.896, −5.612, −1.300 |
| Porta 80×210 `:14645` | −3.743, −1.840, −1.300 |
| Porta 80×210 `:14650` | −3.722, −3.040, −1.300 |
| Porta 70×210 `:14712` | −7.373, −6.789, −1.300 |
| Porta 70×210 `:14716` | −7.333, −8.048, −1.300 |

The three closest pairs are **1.20 m**, **1.26 m** and **1.29 m** apart. Nearest-
neighbour matching starts guessing once your total error passes half of that, so:

- **> 0.60 m** — the pipeline picks the wrong door regularly. Useless.
- **0.15–0.30 m** — works, with occasional confusion between the two adjacent pairs.
- **≤ 0.15 m** — the target. Achievable, see §1.2.

Total error is registration RMS **plus** VPS pose error **plus** the camera-vs-object
offset in §1.5. Budget accordingly; do not spend it all on registration.

### 1.2 — Route A: cloud-to-cloud registration (recommended)

You already have both halves of this, which is why it is the right route.

MultiSet publishes **every processed map as a point cloud**: `PointCloud/map.pcd`,
binary PCD, XYZ at 5 cm spacing, **right-handed, +Z up**, downloadable from the
Map Details page or the `/file` endpoint. (A textured GLB mesh is also offered —
note it is **+Y up**, unlike the PCD. Use the PCD.)

And you have `maddaloni 1.e57` / `maddaloni 2.e57` — the Leica survey the Revit
model was built from.

1. Download `map.pcd` from the MultiSet console.
2. Open both `map.pcd` and the `.e57` in **CloudCompare**.
3. *Align (point pairs picking)* — click 4 corresponding features, door jambs and
   wall corners work well. This gets you to a few decimetres.
4. *Fine registration (ICP)* — CloudCompare reports the final RMS and prints the
   4×4 transformation to the console; save it with *Save transformation*.
5. Convert it into the env-var form:

   ```bash
   python calibrate_registration.py --matrix cc_transform.txt
   ```

This is dense-cloud against dense-cloud, so it typically lands at a few
centimetres — an order of magnitude better than picking points by hand, and it
comes with an RMS you can quote in the thesis.

> **Check the scan-to-BIM step.** Route A gives you `T_map→scan`. You need
> `T_map→ifc`. If the Revit model was authored on that imported scan and never
> moved, `T_scan→ifc` is the identity and you are done — verify by re-importing
> the `.e57` into Revit and confirming the cloud lands on the modelled walls. If
> it does not, register cloud to model as well and chain them:
> `python calibrate_registration.py --matrix cc_transform.txt --compose scan_to_ifc.txt`

### 1.3 — Route B: point pairs (fallback)

No CloudCompare, or the map cloud is too sparse where you need it. Measure ≥ 3
(realistically 5–6) non-collinear points in both frames and fit the transform:

```bash
python calibrate_registration.py --pairs pairs.csv --check holdout.csv
```

```csv
label,map_x,map_y,map_z,ifc_x,ifc_y,ifc_z
door_14645_jamb,  2.104, -0.887, 1.512, -3.743, -1.840, -1.300
...
```

The catch is getting a *point* in the map frame — a VPS query returns where the
**camera** was, not where the feature is. Three ways, best first:

1. **MultiSet Content Space / the AR SDK.** Place a virtual anchor on the feature
   by AR hit-test and read its map coordinates. Centimetres.
2. **Phone flat against the feature.** Hold the phone screen-out against a door
   jamb and localize. The camera sits ~1 cm behind the glass — good to ~5–10 cm.
3. **Stand on a surveyed floor point** and subtract your measured phone height.
   Decimetres, and only worth it if you have marked floor points already.

Spread the points across the whole office and across at least two heights —
points that are all collinear or all coplanar leave the fit under-determined and
the RMS will lie to you. Keep two pairs out of the fit and pass them as
`--check`; that hold-out RMS is the honest number to report.

### 1.4 — Route C: georeferencing — not viable here, and worth saying why

The design doc floats aligning both sides to WGS 84 instead. Two independent
reasons that is dead for this case study:

- **The IFC's georeferencing is a placeholder.** `IfcSite` carries
  41°47′59.997″ N, 12°36′00.001″ E — that is 41.8°/12.6° to the millimetre of
  arc, a round default, and it sits near Rome while the project is named after
  Maddaloni (Caserta). It is Revit template data, not survey data. The file is
  also IFC2X3, which has no `IfcMapConversion`.
- **Accuracy is an order of magnitude short.** MultiSet's own docs put
  georeferenced global space at *metre* level versus centimetre-level map space.
  Against doors 1.20 m apart, metre-level is noise.

Worth one paragraph in the thesis as a rejected alternative, with these two
reasons. Not worth implementing.

### 1.5 — The error source calibration does *not* fix

The VPS returns the pose of the **camera**, not of the door. The reporter stands
1.5–2.5 m back at eye height; every door in this model has its origin at floor
level (`z = −1.300` for all seven). So even with a perfect transform, the query
point is 2–3 m from the thing being photographed — and the doors are 1.20 m apart.

Three ways out, in increasing order of effort:

1. **Class hint.** Pass `ifc_class: 'IfcDoor'` (§8.3) so windows and the radiator
   cannot win. Cheap, and enough to make the demo reliable.
2. **Push the query point forward.** MultiSet returns `rotation` as a quaternion
   and the workflow currently discards it. Offset the position ~2 m along the
   camera's view axis before querying. A few lines in node 7's body expression.
3. **Ray-cast instead of nearest-point.** Cast the camera ray into the IFC
   geometry and take the first element it hits. Correct by construction, and
   robust to translation error, but it is a change to `ifc_service.py`
   (IfcOpenShell geometry iterator + a BVH), not to n8n.

Start with 1, and treat 3 as the honest engineering answer for the thesis.

## 2. Node 1 — `Drive Trigger - New Snapshot`

**Role.** Stands in for the mobile app: a file appearing in Drive = a citizen
report submitted.

| Field | Value |
|-------|-------|
| Credential | *Google Drive OAuth2 API* (see below) |
| Poll Times → Mode | **Every Minute** |
| Trigger On | **Specific Folder** |
| Folder | `01_incoming_snapshots` (pick From List, or paste the ID) |
| Event | **File Created** |

**Creating the Google credential.** In Google Cloud Console: create a project →
enable the **Google Drive API** → *OAuth consent screen* (External, add yourself
as a test user) → *Credentials → Create OAuth client ID → Web application* →
paste the **OAuth Redirect URL** that n8n shows on the credential page into
*Authorized redirect URIs* → copy Client ID/Secret back into n8n → **Sign in with
Google**.

**Filename convention.** The PoC parses the reporter from the file name:

```
report_<reporterEmail>_<freeText>.jpg
e.g.  report_giuseppe.desiderio123@gmail.com_broken_door_handle.jpg
```

**Testing it.** Click **Fetch Test Event** — n8n pulls the most recent file in the
folder without waiting for a poll. Use this for every dry run; you do not need to
activate the workflow yet.

**Gotchas**
- Polling means ~60 s latency and the trigger only sees files created *after*
  activation. Fine for a PoC, and already flagged as a production weakness in the
  design doc (§6.4: replace with a Webhook trigger).
- Upload a **JPEG or PNG**. iPhone HEIC breaks both node 3's size parser and the
  MultiSet decoder — set the camera to *Most Compatible*, or convert first.
- Keep the photo **under ~2 MB / 1600 px on the long side**. It travels to
  MultiSet as base64, which inflates it by ~33 %.

**Output used downstream:** `id` (node 2), `name` and `webViewLink` (node 3).

---

## 3. Node 2 — `Download Snapshot`

**Role.** Fetches the actual bytes; the trigger only gives metadata.

| Field | Value |
|-------|-------|
| Credential | same Google Drive OAuth2 credential |
| Resource | **File** |
| Operation | **Download** |
| File → By ID | `{{ $json.id }}` |
| Options → Put Output File in Field | `data` (default — node 3 depends on this name) |

**Testing it.** Execute the step; the output panel should show a **Binary** tab
with `data`, a `mimeType` of `image/jpeg`, and a thumbnail of your door.

**Optional but recommended — downscale here.** If your phone produces 4000 px
photos, insert an **Edit Image** node between node 2 and node 3:
*Operation: Resize · Width 1280 · Height 0 · Option: Only if larger*. Smaller
images localize just as well, upload faster, and keep you clear of n8n's payload
limits.

---

## 4. Node 3 — `Prepare Image & Metadata`

**Role.** The adapter between "a JPEG sitting in n8n" and "what the MultiSet VPS
query expects": raw base64, the true pixel size, and camera intrinsics.

| Field | Value |
|-------|-------|
| Language | JavaScript |
| Mode | **Run Once for All Items** |

The node ships with the code already in place. The only part you touch is the
CONFIG block at the top:

```js
const FX = null;        // put your phone's real intrinsics here
const FY = null;
const PX = null;
const PY = null;
const HFOV_DEG = 69;    // fallback: typical smartphone main-camera H-FOV
```

Leave everything `null` and the node estimates:

```
fx = fy = (width / 2) / tan(HFOV / 2)      px = width / 2      py = height / 2
```

For a 960 px-wide image at 69° that gives `fx ≈ 698` — the right order of
magnitude (MultiSet's own docs example uses `fx = 670.46` for a 960 px frame).
Good enough for a toy example; **wrong intrinsics are the #1 cause of a low
`confidence`**, so upgrade them as soon as the demo works.

**Getting real intrinsics — pick one**
- The MultiSet mapping app logs the intrinsics of the device that scanned the
  space. If the same phone takes the report photo, reuse them.
- From EXIF: `exiftool -FocalLengthIn35mmFormat -ImageWidth photo.jpg`, then
  `fx = fy = width × f35 / 36`.
- From ARKit / ARCore, if you build the real mobile app (design doc §6.4).

**What the node outputs**

```json
{
  "fileName": "report_...@gmail.com_broken_door_handle.jpg",
  "reporterEmail": "giuseppe.desiderio123@gmail.com",
  "photoUrl": "https://drive.google.com/file/d/.../view",
  "width": 1280, "height": 960,
  "fx": 931.2, "fy": 931.2, "px": 640, "py": 480,
  "imageB64": "/9j/4AAQSk...",
  "dataUri": "data:image/jpeg;base64,/9j/4AAQSk..."
}
```

`imageB64` goes to MultiSet; `dataUri` is kept for the vision-LLM triage node
further down the workflow.

**Gotchas**
- `imageB64` has **no** `data:` prefix. MultiSet wants the bare base64 string; the
  earlier version of this workflow sent `dataUri` and the query always failed.
- `px ≈ width/2` and `py ≈ height/2`. If you hand-enter intrinsics and end up with
  `px > width`, you have swapped landscape and portrait.
- **EXIF rotation.** A phone may store a landscape JPEG plus a "rotate 90°" flag.
  The parser reads the *stored* size, which is what a decoder sees, so the two
  stay consistent — but take the report photo in the **same orientation as the
  mapping video** to avoid the question entirely.

---

## 5. Node 4 — `MultiSet - Get Token`

**Role.** Exchanges your client credentials for a 30-minute JWT.

MultiSet's auth endpoint takes **HTTP Basic auth in the header and no body** —
`Authorization: Basic base64(clientId:clientSecret)`. n8n's generic *Basic Auth*
credential produces exactly that header, so the secret never lands in the
workflow JSON.

| Field | Value |
|-------|-------|
| Method | **POST** |
| URL | `https://api.multiset.ai/v1/m2m/token` |
| Authentication | **Generic Credential Type** → **Basic Auth** |
| Credential | *new* → **User** = your `clientId`, **Password** = your `clientSecret` |
| Send Body | **off** |
| Send Headers | on → `Content-Type: application/json` |
| Options → Timeout | `30000` |

Name the credential something like `MultiSet M2M (clientId / clientSecret)`.

**Expected output**

```json
{ "token": "eyJhbGciOi...", "expiresOn": "2026-09-06T12:34:56Z", "error": null }
```

**Gotchas**
- `401` → the clientId/secret pair is wrong, or pasted into the wrong credential
  fields (User = `clientId`, *not* your account email).
- `403` → your account's CORS/domain allowlist. Add your n8n host in the MultiSet
  console.
- `400` → some deployments want a body; switch *Send Body* on, JSON, `{}`.
- The token expires in 30 min. The workflow fetches a fresh one on every run, so
  this only bites if you leave a manual test half-executed and come back later.

---

## 6. Node 5 — `MultiSet - Localize Snapshot`

**Role.** The actual VPS query: image + intrinsics + `mapCode` → 6-DoF pose.

| Field | Value |
|-------|-------|
| Method | **POST** |
| URL | `https://api.multiset.ai/v1/vps/map/query` |
| Send Headers | on |
| → Authorization | `=Bearer {{ $json.token }}` |
| → Content-Type | `application/json` |
| Send Body | on → **Using JSON** |
| Options → Timeout | `60000` |

**Body** (already in the node — you only replace the `mapCode`):

```js
{{ JSON.stringify({
  mapCode: 'REPLACE_WITH_MULTISET_MAP_CODE',
  isRightHanded: false,
  width:  $('Prepare Image & Metadata').first().json.width,
  height: $('Prepare Image & Metadata').first().json.height,
  fx: $('Prepare Image & Metadata').first().json.fx,
  fy: $('Prepare Image & Metadata').first().json.fy,
  px: $('Prepare Image & Metadata').first().json.px,
  py: $('Prepare Image & Metadata').first().json.py,
  queryImage: $('Prepare Image & Metadata').first().json.imageB64
}) }}
```

The intrinsics are **flat top-level keys** — there is no `cameraIntrinsics` object
and no `resolution` object. The node references node 3 by name because its own
input (`$json`) is node 4's token response.

**Expected output**

```json
{
  "poseFound": true,
  "position": { "x": -5.8951, "y": 1.2250, "z": 2.2112 },
  "rotation": { "x": -0.0078, "y": 0.8212, "z": 0.0320, "w": 0.5696 },
  "confidence": 0.46875,
  "mapCodes": ["MAP_RJFKKWQ1787J"],
  "responseTime": 2572
}
```

**Useful optional body fields**
- `queryMode: 'vps-2'` — Deep Search: ~1–2 s slower, noticeably higher recall.
  Worth turning on if your door keeps failing to localize.
- `hintPosition` + `hintRadius` — if you roughly know where the reporter stood.
- `mapSetCode` instead of `mapCode` — query several maps at once (exactly one of
  the two).

**Gotchas — read these if `poseFound: false`**
1. **Nested intrinsics.** The old body sent `cameraIntrinsics: {...}` and
   `resolution: {...}`; the API does not read them, so the query had nothing
   usable and failed. Fixed in the shipped JSON.
2. **`data:` prefix in `queryImage`.** Also fixed — send `imageB64`.
3. **Photo outside the mapped area**, or shot from an angle/height the scan never
   saw. For a door, stand **1.5–2.5 m back** so the frame includes wall, floor and
   frame — a close-up of a flat door leaf has almost no features to match.
4. **Lighting changed** dramatically since the scan (day vs. night, blinds).
5. **Wrong `mapCode`**, or the map is still processing.
6. **`confidence` low but not zero (0.15–0.30).** Normal for single-frame queries;
   the docs' own example is `0.46875`. See node 6.

---

## 7. Node 6 — `Confidence Gate`

**Role.** Human-in-the-loop fallback: anything the VPS is not confident about goes
to a person instead of poisoning the ticket with a wrong location.

| Field | Value |
|-------|-------|
| Convert types where required | **on** |
| Combinator | **AND** |
| Condition 1 | `{{ $json.poseFound }}` · **Boolean → is true** |
| Condition 2 | `{{ $json.confidence }}` · **Number → is greater than or equal to** · `0.3` |

**Wiring** — `true` → `Find IFC Element`, `false` → `Create Triage Ticket`.

**Calibrating the threshold.** 0.30 is the design-doc default, not a law. Run 5–10
photos of your door from different distances, write down the confidences, and put
the threshold below the worst one that still produced a *correct* position. If
your best shot scores 0.22, lower the gate to 0.15 for the demo and state in the
write-up that the threshold is empirical.

### 7.bis The false branch (configure it, then disable it)

The gate needs somewhere to send failures or the run errors out.

- **`Create Triage Ticket`** (Postgres): credential = your Postgres connection,
  Operation *Execute Query*. The query is already written and needs no edit; it
  inserts a `NEEDS_TRIAGE` row and returns its `id`.
- **`Notify FM - Manual Triage Needed`** (Gmail): Gmail OAuth2 credential, and
  replace `REPLACE_FM_EMAIL@example.com` with a real inbox.

While you are only testing the happy path, right-click both → **Deactivate** so a
missing Postgres/Gmail credential cannot fail your run.

---

## 8. Node 7 — `Find IFC Element`

**Role.** Turns a 3D point into a BIM identity: the `GlobalId` of the nearest
maintainable element. This is the join between the physical world and the model,
and the last node in this tutorial's scope.

### 8.1 Start the microservice first

The service serves whatever `models/active_model.txt` points at, and it *writes
new versions* of that file when tickets close — so give it a copy, never the
original, and name the copy `..._v1.ifc` so the version counter has somewhere to
go. Drop the space in the filename; it ends up in URLs and emails later.

```bash
pip install fastapi uvicorn "ifcopenshell>=0.8" numpy pydantic

mkdir -p models
cp "/c/Users/USER/Desktop/Progetti Dottorato/ISTEA_2026/Case_Study/Base ufficio.ifc"    models/base_ufficio_v1.ifc
echo base_ufficio_v1.ifc > models/active_model.txt

# PowerShell:
#   $env:AXIS_MODE = "identity"
#   $env:MULTISET_TO_IFC_MATRIX = '[[...],[...],[...],[0,0,0,1]]'   # from §1
export AXIS_MODE=identity
export MULTISET_TO_IFC_MATRIX='[[...],[...],[...],[0,0,0,1]]'

uvicorn ifc_service:app --host 0.0.0.0 --port 8000
```

Sanity-check it before wiring n8n:

```bash
curl http://localhost:8000/health
# {"status":"ok","active_model":"base_ufficio_v1.ifc","maintainable_elements":13,...}

curl http://localhost:8000/elements
# 7 IfcDoor + 4 IfcWindow + 2 IfcBuildingElementProxy, with positions

curl -X POST http://localhost:8000/elements/nearest      -H "Content-Type: application/json"      -d '{"x":-3.70,"y":-1.85,"z":-1.30,"max_distance":3.0}'
# {"found":true,"global_id":"0iXsb6cUbFTwXlliOwbsbD",
#  "name":"Porta - 1 Anta:80x210 cm:14645","ifc_class":"IfcDoor",...}
```

`maintainable_elements: 13` is the number to look for. `0` means the model copy
or the pointer file is wrong; a startup error usually means
`MULTISET_TO_IFC_MATRIX` is not valid JSON — it must be a quoted 16-number
nested list.

> **IFC2X3 note.** `MAINTAINABLE_CLASSES` in `ifc_service.py` lists `IfcFurniture`,
> which only exists in IFC4 — the IFC2X3 equivalent is `IfcFurnishingElement`.
> This model has neither, so nothing is lost today, but add
> `IfcFurnishingElement` and `IfcFlowTerminal` to that list before you extend the
> case study to lamps, radiators and sanitary fixtures.

Now reproduce the same query end-to-end: localize your door photo, take the
`position` from node 5, and confirm the curl returns the door you actually
photographed. **If it does not, stop** — n8n cannot fix a frame mismatch. Go back
to §1.

### 8.2 Which URL does n8n need?

| Your n8n | URL to put in the node |
|----------|------------------------|
| Desktop app / `npx n8n` on the same machine | `http://localhost:8000/elements/nearest` |
| Docker, service on the host | `http://host.docker.internal:8000/elements/nearest` (on Linux add `--add-host=host.docker.internal:host-gateway`) |
| Docker Compose, service in a sibling container | `http://ifc-service:8000/elements/nearest` |
| **n8n Cloud** | tunnel it: `ngrok http 8000` → `https://<sub>.ngrok-free.app/elements/nearest` |

### 8.3 Node settings

| Field | Value |
|-------|-------|
| Method | **POST** (not GET — see gotchas) |
| URL | per the table above |
| Send Headers | on → `Content-Type: application/json` |
| Send Body | on → **Using JSON** |
| Options → Timeout | `30000` |

**Body:**

```js
{{ JSON.stringify({
  x: $json.position.x,
  y: $json.position.y,
  z: $json.position.z,
  max_distance: 3.0
}) }}
```

`$json` here is the MultiSet response, passed straight through the IF node.

**Optional `ifc_class` hint.** Adding `ifc_class: 'IfcDoor'` restricts the search
to doors and makes the toy demo bulletproof. Leave it out for the real flow: at
node 7 the pipeline does not yet know what was photographed — the vision triage
that decides "door / lamp / radiator" only runs at node 10. The service falls back
to a class-agnostic search anyway if the hint matches nothing.

**Expected output**

```json
{
  "found": true,
  "global_id": "0iXsb6cUbFTwXlliOwbsbD",
  "name": "Porta - 1 Anta:80x210 cm:14645",
  "ifc_class": "IfcDoor",
  "distance": 0.31,
  "position": { "x": -3.743, "y": -1.840, "z": -1.300 },
  "model": "base_ufficio_v1.ifc"
}
```

That `global_id` is the deliverable of this tutorial: from a photo of a door to
its identity in the IFC model.

**Gotchas**
1. **It is a POST with a JSON body.** The previous version of this node was a
   `GET` with `x/y/z/radius` query parameters; `ifc_service.py` exposes no such
   route and no `radius` parameter, so it returned `405 Method Not Allowed`.
   Fixed in the shipped JSON.
2. **`found: false` still returns HTTP 200.** The node succeeds and passes
   `global_id: null` downstream, where `Check Duplicate` would run
   `WHERE ifc_global_id = ''`. Before you build node 8, insert an IF
   *"Element found?"* on `{{ $json.found }}` and route the false side to the
   triage branch. (Out of scope here, but do not forget it.)
3. **`max_distance` is a truth filter, not a knob to loosen.** If you need 8 m to
   get a hit, your registration is wrong — fix §1, do not widen the radius.
4. **`localhost` inside Docker is the container**, not your machine. Symptom:
   `ECONNREFUSED`. Use `host.docker.internal`.

---

## 9. Dry run: the toy example, hop by hop

1. Save the file as
   `report_giuseppe.desiderio123@gmail.com_broken_door_handle.jpg`.
2. Drop it into Drive `01_incoming_snapshots`.
3. In n8n open WF1, click node 1 → **Fetch Test Event**, then **Test workflow**.
4. Walk the output panels:

| After node | Check |
|------------|-------|
| 1 | `name` matches the convention, `id` present |
| 2 | Binary tab shows the door thumbnail, `mimeType: image/jpeg` |
| 3 | `reporterEmail` parsed; `width`/`height` match the real file; `imageB64` starts with `/9j/` |
| 4 | `token` is a long `eyJ...` string |
| 5 | `poseFound: true`, `confidence ≥ 0.3`, `position` plausible |
| 6 | The green path leaves the **true** output |
| 7 | `found: true`, and `name` is the door you photographed |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Trigger never fires | Polling + file predates activation | **Fetch Test Event**, or re-upload the file |
| Node 3: `getBinaryDataBuffer ... undefined` | Binary property is not called `data` | Node 2 → Options → *Put Output File in Field* = `data` |
| Node 3: width/height wrong | HEIC or unusual JPEG | Convert to standard JPEG/PNG |
| Node 4: 401 | clientId/secret swapped or wrong | Re-enter the Basic Auth credential |
| Node 4: 403 | CORS/domain allowlist | Whitelist your n8n host in the MultiSet console |
| Node 5: 401 | Token expression not resolving | Header must be `=Bearer {{ $json.token }}` |
| Node 5: `poseFound: false` | See §6 gotchas 1–5 | Start with intrinsics and photo position |
| Node 5: 413 / timeout | Image too large | Add the Edit Image resize node (§3) |
| Node 6 always false | `confidence` genuinely low | Recalibrate the threshold (§7) |
| Node 7: `ECONNREFUSED` | Wrong host for your n8n runtime | §8.2 |
| Node 7: 405 | Node still configured as GET | Re-import the corrected JSON |
| Node 7: `found: false` | Frame mismatch | §1 — verify with the curl in §8.1 first |
| Node 7 returns the *adjacent* door | Total error above ~0.6 m | Tighten registration (§1.2) — the closest pair is 1.20 m apart |
| Node 7 returns a window or the radiator | Registration off, or the camera-pose offset | Add `ifc_class: 'IfcDoor'` (§8.3), then fix §1 |

---

## 11. What changed in the JSON

Four real bugs prevented nodes 4, 5 and 7 from ever succeeding. All are fixed in
`wf1_ticket_intake_and_dispatch.json`; the previous file is at
`Old/wf1_ticket_intake_and_dispatch.pre-tutorial.json`.

| Node | Was | Now |
|------|-----|-----|
| 4 — Get Token | POST with a JSON body carrying `clientId`/`clientSecret` in cleartext | HTTP **Basic auth header**, no body, secrets in an n8n credential |
| 5 — Localize | `cameraIntrinsics: {...}` + `resolution: {...}` nested objects; `queryImage` = `data:` URI; hard-coded 960×720 | **Flat** `width/height/fx/fy/px/py`; raw base64; size and intrinsics derived from the actual image |
| 3 — Prepare | base64 only | + real pixel size (JPEG/PNG header parse) + intrinsics + a CONFIG block for real values |
| 7 — Find IFC Element | `GET /elements/nearest?x&y&z&radius` | `POST /elements/nearest` with `{x, y, z, max_distance}` — matches `ifc_service.py` |

**New file — `calibrate_registration.py`.** Computes `T_map→ifc` and reports how
much to trust it: Kabsch/Umeyama on point pairs (`--pairs`), or conversion of a
CloudCompare ICP result (`--matrix`), with `--compose` for chaining scan→BIM,
`--check` for hold-out residuals, and a reflection guard for the left/right-handed
mix-up. It prints the ready-to-paste `MULTISET_TO_IFC_MATRIX`.

**`create_sample_ifc.py` is out of the flow.** The case study has a real model,
`Base ufficio.ifc`. The script stays in the folder only as a way to generate a
throwaway model when testing the service in isolation, and it now takes
`--door/--window/--light/--out` for that.

---

## 12. Next step

Node 8 (`Check Duplicate`) onward. Before wiring it, add the **"Element found?"**
IF described in §8, gotcha 2 — otherwise a failed match writes an empty
`ifc_global_id` into the duplicate query.
