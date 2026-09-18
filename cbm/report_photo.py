"""Optional AFTER evidence from the submission PDF, never a Drive folder search."""
import base64
import hashlib
import io
import warnings

from PIL import Image, ImageOps

ATTACHMENT = 'cbm-after-photo.jpg'
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 24_000_000
MAX_CANDIDATES = 12


def result(status, photo=None, count=0, error=None):
    return dict(photo_status=status, photo=photo, photo_count=count, photo_error=error)


def normalize(raw, source, page=None):
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError('Report photo exceeds 10 MiB')
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(raw)) as original:
            if original.width * original.height > MAX_PIXELS:
                raise ValueError('Report photo exceeds 24 megapixels')
            photo = ImageOps.exif_transpose(original)
            photo.thumbnail((1600, 1600))
            if photo.mode in ('RGBA', 'LA') or 'transparency' in photo.info:
                rgba = photo.convert('RGBA')
                rgb = Image.new('RGB', rgba.size, 'white')
                rgb.paste(rgba, mask=rgba.getchannel('A'))
                photo = rgb
            else:
                photo = photo.convert('RGB')
            out = io.BytesIO()
            photo.save(out, format='JPEG', quality=86)
            return dict(base64=base64.b64encode(out.getvalue()).decode('ascii'),
                        mime_type='image/jpeg', source=source, page=page,
                        width=photo.width, height=photo.height)


def extract_report_photo(reader):
    """Prefer the named template attachment; support earlier single-image PDFs.

    Multiple page images are ambiguous. Small decorative images are excluded.
    Evidence extraction issues remain explicit instead of becoming 'no photo'.
    """
    try:
        if ATTACHMENT in reader.attachments:
            attached = reader.attachments[ATTACHMENT]
            if len(attached) != 1:
                return result('AMBIGUOUS', count=len(attached), error='Multiple AFTER attachments')
            return result('OK', normalize(attached[0], 'PDF_ATTACHMENT'), count=1)

        candidates, seen = [], set()
        inspected = 0
        for page_no, page in enumerate(reader.pages, 1):
            for entry in page.images:
                inspected += 1
                if inspected > MAX_CANDIDATES:
                    return result('AMBIGUOUS', count=len(candidates), error='Too many PDF images to identify the AFTER photo')
                image = entry.image
                if image is None:
                    raise ValueError('A PDF image could not be decoded')
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError('Report photo exceeds 24 megapixels')
                if min(image.size) < 128:
                    continue
                digest = hashlib.sha256(entry.data).digest()
                if digest not in seen:
                    seen.add(digest)
                    candidates.append((entry.data, page_no))
        if not candidates:
            return result('NONE')
        if len(candidates) != 1:
            return result('AMBIGUOUS', count=len(candidates), error='Multiple images: use the report template to identify the AFTER photo')
        raw, page_no = candidates[0]
        return result('OK', normalize(raw, 'PDF_IMAGE', page_no), count=1)
    except Exception as exc:
        return result('ERROR', error=str(exc)[:300])
