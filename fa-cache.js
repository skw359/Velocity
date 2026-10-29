// Proxied and cached on disk rather than linked from the CDN, which the app's CSP (security.js) doesn't allow.
// Mounted at /vendor/fontawesome so the stylesheet's relative "../webfonts/*" URLs resolve back here.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const FA_VERSION = '6.7.2';
const FA_ORIGIN = `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VERSION}`;
const CACHE_DIR = path.join(__dirname, 'assets', 'vendor', 'fontawesome', FA_VERSION);

// Anything else is a 404: this must never become an open proxy.
const ALLOWED = /^(css\/[a-z0-9.-]+\.css|webfonts\/[a-z0-9-]+\.(woff2|ttf))$/i;

const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

// Collapses concurrent first-hit requests for the same file into one fetch.
const inflight = new Map();

async function fetchAndCache(rel) {
    const dest = path.join(CACHE_DIR, rel);
    const res = await fetch(`${FA_ORIGIN}/${rel}`);
    if (!res.ok) throw new Error(`cdnjs responded ${res.status} for ${rel}`);
    const body = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // Write-then-rename so a killed process can't leave a truncated file cached.
    const tmp = `${dest}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, dest);
    return body;
}

async function load(rel) {
    const dest = path.join(CACHE_DIR, rel);
    try {
        return await fsp.readFile(dest);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    if (!inflight.has(rel)) {
        inflight.set(rel, fetchAndCache(rel).finally(() => inflight.delete(rel)));
    }
    return inflight.get(rel);
}

function fontAwesome(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (!ALLOWED.test(rel) || rel.includes('..')) return res.sendStatus(404);

    load(rel).then((body) => {
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream');
        // The path is version-pinned, so the bytes at it never change.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') {
            res.setHeader('Content-Length', String(body.length));
            return res.end();
        }
        res.end(body);
    }).catch((err) => {
        // Offline with a cold cache: icons fall back to nothing rather than failing the page.
        if (typeof console !== 'undefined') console.warn(`[fontawesome] ${rel}: ${err.message}`);
        res.sendStatus(502);
    });
}

module.exports = { fontAwesome, FA_VERSION, CACHE_DIR };
