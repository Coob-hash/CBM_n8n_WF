// One submission PDF contains the report text and its optional AFTER photo.
const x = $('Extract Ticket ID').first().json;
let text = '', pages = 0, parseError = null;
let photoStatus = 'UNKNOWN', photoError = null, photo = null, binary = {};
try {
  const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (buf.length > 20 * 1024 * 1024) throw new Error('Report exceeds 20 MiB');
  const base = String($env.IFC_SERVICE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('Configure IFC_SERVICE_URL');
  const parsed = await this.helpers.httpRequest({
    method: 'POST', url: base + '/reports/extract', json: true,
    body: {pdfB64: buf.toString('base64')}, timeout: 60000,
  });
  if (typeof parsed.text !== 'string' || !Number.isInteger(parsed.numpages)) {
    throw new Error('Invalid report extraction response');
  }
  text = parsed.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  pages = parsed.numpages;
  photoStatus = ['OK','NONE','AMBIGUOUS','ERROR'].includes(parsed.photo_status) ? parsed.photo_status : 'ERROR';
  photoError = parsed.photo_error || (parsed.photo_status ? null : 'Python service does not support report photo extraction');
  if (photoStatus === 'OK') {
    try {
      photo = parsed.photo;
      if (!photo || photo.mime_type !== 'image/jpeg' || typeof photo.base64 !== 'string' || !photo.base64) throw new Error('Invalid extracted photo');
      const bytes = Buffer.from(photo.base64, 'base64');
      if (bytes.length > 10 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid extracted JPEG');
      binary.data = await this.helpers.prepareBinaryData(bytes, 'TICKET-' + x.ticket_id + '-after.jpg', 'image/jpeg');
    } catch (e) {
      photoStatus = 'ERROR'; photoError = String(e.message || e); photo = null;
    }
  }
} catch (e) {
  parseError = String(e?.response?.body?.detail || e?.message || e).slice(0, 1000);
}
const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
const quality = parseError ? 'PARSE_ERROR' : (words < 5 ? 'EMPTY' : 'OK');
return [{json:{...x, report_text:text, report_words:words, report_pages:pages,
  report_quality:quality, report_parse_error:parseError,
  photo_available:photoStatus === 'OK', photo_status:photoStatus, photo_error:photoError,
  photo_source:photo?.source || null, photo_page:photo?.page || null,
  after_file_id:null, after_link:photoStatus === 'OK' ? (x.report_link || '') : ''}, binary}];
