// Serving files people uploaded, on the app's own origin. An uploaded .html or .svg opened
// here must never run as a page of this site, or it could act as whoever views it. So only
// types a browser displays without executing anything are served inline; everything else
// downloads. Every response but a PDF also carries a sandbox CSP (scripts off, unique
// origin) in case a browser renders it anyway; Chrome's PDF viewer refuses to load in a
// sandboxed document, and PDFs are shown by the browser's own isolated viewer.

const path = require('path');

const INLINE_TYPES = [
  /^image\/(?!svg)[\w.+-]+$/, // raster images; SVG can carry script
  /^audio\/[\w.+-]+$/,
  /^video\/[\w.+-]+$/,
  /^text\/plain$/,
  /^text\/csv$/,
  /^application\/json$/,
  /^application\/pdf$/,
];

const USER_CONTENT_CSP = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'self'",
  'sandbox',
].join('; ');

function isInlineType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return INLINE_TYPES.some((re) => re.test(type));
}

// Headers for absPath without sending it. opts.crossOrigin lets other sites embed the
// file (public share links), opts.forceDownload makes it an attachment regardless of type.
function applyUserContentHeaders(res, absPath, { crossOrigin = false, forceDownload = false } = {}) {
  res.type(path.extname(absPath) || 'application/octet-stream');
  const contentType = String(res.get('Content-Type') || '');
  if (forceDownload || !isInlineType(contentType)) res.attachment(path.basename(absPath));
  if (/^application\/pdf\b/i.test(contentType)) res.removeHeader('Content-Security-Policy');
  else res.set('Content-Security-Policy', USER_CONTENT_CSP);
  res.set('Cross-Origin-Resource-Policy', crossOrigin ? 'cross-origin' : 'same-origin');
}

// Sends a regular file the caller has already resolved (and confined) to absPath, with
// Range, ETag and conditional-GET support.
function sendUserFile(req, res, absPath, opts = {}) {
  applyUserContentHeaders(res, absPath, opts);
  res.sendFile(absPath, { dotfiles: 'allow', acceptRanges: true, lastModified: true, etag: true }, (err) => {
    if (!err) return;
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : (err.status || 500)).end();
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });
}

module.exports = {
  USER_CONTENT_CSP,
  isInlineType,
  applyUserContentHeaders,
  sendUserFile,
};
