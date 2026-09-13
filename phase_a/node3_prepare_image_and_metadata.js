// Prepare Image & Metadata
// Turns the Drive binary into exactly what the MultiSet VPS query needs: a
// normalized JPEG and the camera intrinsics that belong to those exact pixels.
//
// The pixel work runs in ifc_service (POST /captures/normalize) because it needs
// Pillow, a compiled library that cannot run inside an n8n Code node. That is the
// same reason /elements/nearest already lives there.
//
// The service reads FocalLengthIn35mmFilm from the photograph's own EXIF, bakes the
// EXIF orientation into the pixels, and downscales to MultiSet's 1280 px limit. This
// replaces the previous fixed-HFOV estimate, which assumed every photograph came from
// a ~26 mm-equivalent lens, ignored the orientation tag entirely, and sent the image
// at full resolution.

// ---- CONFIG --------------------------------------------------------------
let IFC_SERVICE_URL = 'http://localhost:8000';
try { if ($env.IFC_SERVICE_URL) IFC_SERVICE_URL = $env.IFC_SERVICE_URL; } catch (e) { /* env access blocked */ }
IFC_SERVICE_URL = IFC_SERVICE_URL.replace(/\/+$/, '');

const LONG_SIDE = 1280;   // MultiSet's documented limit on the longer side
const HFOV_DEG  = 69;     // legacy estimate, fallback path only - always untrusted
// --------------------------------------------------------------------------

const trg = $('Drive Trigger - New Snapshot').first().json;
const fileName = trg.name || 'report_unknown_object.jpg';
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');

// Retained only for the fallback path below: when the service cannot be reached we
// still need a plausible frame size to keep the item well-formed.
function imageSize(b) {
  // PNG
  if (b.length > 24 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments until the SOFn frame header
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    const isSOF = marker >= 0xC0 && marker <= 0xCF &&
                  marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// PoC filename convention: report_<reporterEmail>_<freeText>.jpg
const parts = fileName.replace(/\.[^.]+$/, '').split('_');
const reporterEmail = (parts[1] && parts[1].includes('@')) ? parts[1] : 'unknown@reporter';

let frame;
try {
  const res = await this.helpers.httpRequest({
    method: 'POST',
    url: IFC_SERVICE_URL + '/captures/normalize',
    body: { imageB64: buf.toString('base64'), longSide: LONG_SIDE },
    json: true,
    timeout: 60000,
  });
  const cam = res.camera;
  frame = {
    width: cam.width,
    height: cam.height,
    fx: cam.fx, fy: cam.fy, px: cam.px, py: cam.py,
    imageB64: res.imageB64,
    intrinsicsSource: cam.source,
    // false when K failed the plausibility gate. The Confidence Gate routes such a
    // capture to manual triage: a wrong K still yields a confident-looking pose.
    intrinsicsTrusted: cam.trusted === true,
    orientationApplied: res.image.orientation_applied,
    sourceWidth: res.image.source_width,
    sourceHeight: res.image.source_height,
    lens: cam.lens || null,
    gateRejections: res.gate_rejections || [],
    normalizeError: null,
  };
} catch (err) {
  // The service is unreachable, or it refused the photograph (HTTP 422: no usable
  // EXIF). Keep the item well-formed so the report still reaches a human, but mark
  // it untrusted so it is never grounded against the IFC model.
  const detail = (err && err.response && err.response.body && err.response.body.detail)
    || (err && err.message) || String(err);
  const size = imageSize(buf) || { width: 960, height: 720 };
  const fx = Number(((size.width / 2) / Math.tan((HFOV_DEG * Math.PI / 180) / 2)).toFixed(4));
  frame = {
    width: size.width,
    height: size.height,
    fx, fy: fx, px: size.width / 2, py: size.height / 2,
    imageB64: buf.toString('base64'),
    intrinsicsSource: 'HFOV_FALLBACK',
    intrinsicsTrusted: false,
    orientationApplied: null,
    sourceWidth: size.width,
    sourceHeight: size.height,
    lens: null,
    gateRejections: [],
    normalizeError: detail,
  };
}

return [{
  json: {
    fileName,
    reporterEmail,
    photoUrl: trg.webViewLink || '',
    ...frame,
    // -> Vision LLM later on. Carries the normalized frame, so the vision step sees
    // the same upright pixels MultiSet was asked about.
    dataUri: 'data:image/jpeg;base64,' + frame.imageB64,
  },
  binary: $input.first().binary,
}];
