// Settings read once from the environment. Every file the server writes is derived from
// DATA_DIR, so pointing VELOCITY_DATA_DIR elsewhere moves all state together (the test
// suite relies on this to never touch a real install).

const path = require('path');

const env = process.env;

const APP_DIR = __dirname;
const DATA_DIR = path.resolve(env.VELOCITY_DATA_DIR || APP_DIR);

function intSetting(name, fallback, min = 0) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function boolSetting(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

// Express 'trust proxy'. The default trusts X-Forwarded-* only from this machine, which
// covers the documented same-host reverse proxy (Caddy) and leaves a directly exposed
// server immune to spoofed client addresses (the login throttle is keyed by IP).
function trustProxySetting(value) {
  if (value == null || String(value).trim() === '') return 'loopback';
  const flag = boolSetting(value);
  if (flag !== null) return flag;
  const v = String(value).trim();
  return /^\d+$/.test(v) ? Number(v) : v;
}

// 'auto' marks the session cookie Secure whenever the request arrived over HTTPS
// (directly, or through a trusted proxy that says so).
function secureCookieSetting(value) {
  const flag = boolSetting(value);
  return flag === null ? 'auto' : flag;
}

module.exports = {
  APP_DIR,
  DATA_DIR,
  CONTENT_DIR: path.join(DATA_DIR, 'content'),
  DB_FILE: env.OPERATIONS_DB ? path.resolve(env.OPERATIONS_DB) : path.join(DATA_DIR, 'operations.db'),
  SHARES_FILE: path.join(DATA_DIR, 'shares.json'),
  BANDWIDTH_FILE: path.join(DATA_DIR, 'bandwidth-stats.json'),
  NETWORK_STATS_FILE: path.join(DATA_DIR, 'network_stats.csv'),
  SESSION_SECRET_FILE: path.join(DATA_DIR, '.session-secret'),
  LOG_DIR: env.VELOCITY_LOG_DIR ? path.resolve(env.VELOCITY_LOG_DIR) : path.join(DATA_DIR, 'logs'),

  PORT: Number(env.PORT) || 3000,
  // Unset listens on every interface. 127.0.0.1 keeps plain HTTP off the network when a
  // reverse proxy on the same machine provides HTTPS.
  HOST: env.VELOCITY_HOST || undefined,

  SESSION_SECRET: env.VELOCITY_SESSION_SECRET || null,
  TRUST_PROXY: trustProxySetting(env.VELOCITY_TRUST_PROXY),
  SECURE_COOKIES: secureCookieSetting(env.VELOCITY_SECURE_COOKIES),
  // 'closed' (default): only the first account (the owner) can sign up; the owner adds
  // everyone else. 'open': anyone who can reach the server can create an account.
  SIGNUP_MODE: String(env.VELOCITY_SIGNUP || '').trim().toLowerCase() === 'open' ? 'open' : 'closed',

  LOG_LEVEL: env.VELOCITY_LOG_LEVEL || 'info',
  LOG_MAX_BYTES: intSetting('VELOCITY_LOG_MAX_SIZE_MB', 20, 1) * 1024 * 1024,
  LOG_MAX_FILES: intSetting('VELOCITY_LOG_MAX_FILES', 5, 1),
};
