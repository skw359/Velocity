// Response headers for the app, and the check that refuses state-changing requests a
// browser sent on behalf of another site.

const helmet = require('helmet');
const logger = require('./logger');

// The client is a self-contained Vite build; the only outside origins are Google Fonts.
const APP_CSP = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  // 'unsafe-eval' is required by heic2any (HEIC previews): its emscripten build creates
  // functions with new Function inside a blob: worker, which inherits this policy. No
  // code here passes user data to eval; inline script stays forbidden.
  scriptSrc: ["'self'", "'unsafe-eval'"],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  mediaSrc: ["'self'", 'blob:'],
  // Search runs over a WebSocket to this host. Safari doesn't count ws:/wss: as 'self'.
  connectSrc: ["'self'", 'ws:', 'wss:'],
  workerSrc: ["'self'", 'blob:'],
  frameSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'self'"],
  formAction: ["'self'"],
  manifestSrc: ["'self'"],
};

// Over HTTPS the policy also upgrades stray http:// loads and HSTS is sent. Neither goes
// out over plain HTTP, the default on a LAN, where upgrading would break every request.
function securityHeaders() {
  const base = {
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  };
  const plain = helmet({
    ...base,
    contentSecurityPolicy: { useDefaults: false, directives: APP_CSP },
    strictTransportSecurity: false,
  });
  const secure = helmet({
    ...base,
    contentSecurityPolicy: { useDefaults: false, directives: { ...APP_CSP, upgradeInsecureRequests: [] } },
    strictTransportSecurity: { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false },
  });
  return (req, res, next) => (req.secure ? secure : plain)(req, res, next);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originHost(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

// The hosts this request was addressed to: Host, plus X-Forwarded-Host from a proxy. A
// page on another site can set neither, so matching either is enough.
function requestHosts(headers) {
  const hosts = [];
  if (headers.host) hosts.push(String(headers.host).toLowerCase());
  if (headers['x-forwarded-host']) {
    for (const h of String(headers['x-forwarded-host']).split(',')) hosts.push(h.trim().toLowerCase());
  }
  return hosts;
}

// True when a browser says the request comes from another site. Sec-Fetch-Site is
// authoritative where sent; otherwise Origin must name this host. Requests with neither
// (curl, scripts) carry no ambient browser credentials to abuse and pass. 'same-site' is
// refused too: SameSite cookies treat another port on this host as the same site.
function isCrossSite(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headers.origin;
  if (origin === undefined) return false;
  const host = originHost(origin);
  return !host || !requestHosts(headers).includes(host);
}

function refuseCrossSite(req, res, next) {
  if (SAFE_METHODS.has(req.method) || !isCrossSite(req.headers)) return next();
  logger.warn(`[Security] Refused cross-site ${req.method} ${req.originalUrl} (origin: ${req.headers.origin || 'none'}, site: ${req.headers['sec-fetch-site'] || 'n/a'}) [IP: ${req.ip}]`);
  res.status(403).json({ error: 'cross_site_request', message: 'This request came from another site and was refused.' });
}

// WebSocket handshakes always carry Origin in browsers; fetch metadata isn't sent on them
// by every browser, so Origin decides when present.
function isCrossSiteUpgrade(headers) {
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = headers.origin;
  if (origin === undefined) return false;
  const host = originHost(origin);
  return !host || !requestHosts(headers).includes(host);
}

module.exports = {
  APP_CSP,
  securityHeaders,
  isCrossSite,
  isCrossSiteUpgrade,
  refuseCrossSite,
};
