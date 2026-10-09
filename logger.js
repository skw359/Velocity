const winston = require('winston');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLOR =
  process.env.NO_COLOR || process.env.VELOCITY_NO_COLOR
    ? false
    : Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY;

const rgb = (r, g, b) => (s) => (COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : `${s}`);
const bgRgb = (r, g, b) => (s) => (COLOR ? `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m` : `${s}`);
const sgr = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : `${s}`);

// Accent palette mirrors client/src/styles/global.css.
const c = {
  accent:      rgb(118, 143, 245),   // #768ff5  Velocity periwinkle
  accentSoft:  rgb(165, 182, 255),   // #a5b6ff  lifted accent
  accentDeep:  rgb(82, 100, 170),    // #5264aa  --accent-hover
  ink:         rgb(232, 236, 245),   // near-white body text
  muted:       rgb(122, 132, 152),   // secondary text
  faint:       rgb(74, 82, 100),     // separators / chrome
  green:       rgb(74, 222, 128),
  amber:       rgb(255, 193, 7),     // #ffc107 from the app palette
  red:         rgb(255, 95, 104),    // #ff5f68 from the app palette
  cyan:        rgb(103, 209, 219),
  violet:      rgb(192, 132, 252),   // #c084fc from the app palette
  bold:        sgr(1, 22),
  dim:         sgr(2, 22),
  italic:      sgr(3, 23),
  onAccent:    bgRgb(118, 143, 245),
  onRed:       bgRgb(255, 95, 104),
  onAmber:     bgRgb(255, 193, 7),
  black:       rgb(11, 13, 21),      // #0b0d15 app background
};

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => strip(s).length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const padStart = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + s;

const LEVELS = {
  error:   { label: 'ERROR', glyph: '✖', paint: c.red },
  warn:    { label: 'WARN',  glyph: '▲', paint: c.amber },
  info:    { label: 'INFO',  glyph: '●', paint: c.accent },
  http:    { label: 'HTTP',  glyph: '⇄', paint: c.cyan },
  verbose: { label: 'VERB',  glyph: '◇', paint: c.muted },
  debug:   { label: 'DEBUG', glyph: '◆', paint: c.muted },
  silly:   { label: 'SILLY', glyph: '·', paint: c.faint },
};

const BAR = '│';
const TAG_WIDTH = 18;

const ENRICH =
  /('[^']*')|(\b\d+(?:\.\d+)?\s?(?:bytes|B|KB|MB|GB|TB)\b)|(\b\d+(?:\.\d+)?\s?(?:ms|s)\b)|(\[[A-Za-z][A-Za-z ]{0,20}: [^\]]+\])|(\b\d{1,3}(?:\.\d{1,3}){3}\b)|(->|→)/g;

function enrich(msg) {
  if (!COLOR) return msg;
  return msg.replace(ENRICH, (m, quoted, size, dur, meta, ip, arrow) => {
    if (quoted) return c.ink(quoted);
    if (size) return c.accentSoft(size);
    if (dur) return c.cyan(dur);
    if (meta) return c.faint(meta);
    if (ip) return c.faint(ip);
    if (arrow) return c.accentDeep('→');
    return m;
  });
}

const METHOD_PAINT = {
  GET: c.accent, POST: c.green, PUT: c.amber,
  PATCH: c.violet, DELETE: c.red, HEAD: c.muted, OPTIONS: c.muted,
};

function paintStatus(status) {
  const n = parseInt(status, 10);
  if (n >= 500) return c.red;
  if (n >= 400) return c.amber;
  if (n >= 300) return c.cyan;
  if (n >= 200) return c.green;
  return c.muted;
}

function httpRow({ method, url, status, ms }) {
  const paintM = METHOD_PAINT[method] || c.muted;
  const m = paintM(padEnd(method, 6));
  const s = paintStatus(status)(String(status));
  const t = ms ? c.faint(padStart(`${Number(ms).toFixed(0)}ms`, 7)) : '';
  return `${m} ${s} ${c.ink(url)} ${t}`;
}

const consoleFormat = winston.format.printf((info) => {
  const { level, message, timestamp, stack, http, ...meta } = info;
  const lv = LEVELS[level] || LEVELS.info;

  let tag = 'core';
  let body = String(message == null ? '' : message).trim();

  const tagMatch = body.match(/^\[([^\]]{1,40})\]\s*/);
  if (tagMatch) {
    tag = tagMatch[1];
    body = body.slice(tagMatch[0].length);
  }

  body = http ? httpRow(http) : enrich(body);

  const shown = http ? LEVELS.http : lv;
  const time = c.faint(timestamp.slice(11));
  const badge = shown.paint(`${shown.glyph} ${padEnd(shown.label, 5)}`);
  const chip = http
    ? c.faint(padEnd('request', TAG_WIDTH))
    : tag === 'core'
      ? c.faint(padEnd('core', TAG_WIDTH))
      : c.accentDeep(padEnd(tag, TAG_WIDTH));
  const sep = c.faint(BAR);

  let line = `${time} ${sep} ${badge} ${sep} ${chip} ${sep} ${body}`;

  if (stack) {
    const raw = String(stack).split('\n').slice(1).filter((f) => f.trim());
    const frames = raw.map((f, i) => {
      const branch = i === raw.length - 1 ? '╰─' : '├─';
      return `${' '.repeat(11)}${c.faint(branch)} ${c.dim(c.muted(f.trim().replace(/^at /, '')))}`;
    });
    if (frames.length) line += '\n' + frames.join('\n');
  }

  const rest = Object.keys(meta).filter((k) => !k.startsWith('_'));
  if (rest.length) {
    const json = JSON.stringify(
      Object.fromEntries(rest.map((k) => [k, meta[k]])),
      (k, v) => (k === 'req' || k === 'res' ? undefined : v)
    );
    if (json && json !== '{}') line += ` ${c.faint(json)}`;
  }

  return line;
});

// Anchored to the app directory, not the cwd, so logs land in one place however the process is launched.
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ],
});

logger.add(
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      consoleFormat
    ),
  })
);

// Tab-delimited so logger.stream can rebuild a coloured row instead of re-parsing free text.
logger.morganFormat = ':method\t:url\t:status\t:response-time';

logger.stream = {
  write: (message) => {
    const parts = message.trim().split('\t');
    if (parts.length === 4) {
      const [method, url, status, ms] = parts;
      logger.info(`[http] ${method} ${url} ${status}`, {
        http: { method, url, status, ms },
      });
    } else {
      logger.info(message.trim());
    }
  },
};

const ART = [
  '██╗   ██╗███████╗██╗      ██████╗  ██████╗██╗████████╗██╗   ██╗',
  '██║   ██║██╔════╝██║     ██╔═══██╗██╔════╝██║╚══██╔══╝╚██╗ ██╔╝',
  '██║   ██║█████╗  ██║     ██║   ██║██║     ██║   ██║    ╚████╔╝ ',
  '╚██╗ ██╔╝██╔══╝  ██║     ██║   ██║██║     ██║   ██║     ╚██╔╝  ',
  ' ╚████╔╝ ███████╗███████╗╚██████╔╝╚██████╗██║   ██║      ██║   ',
  '  ╚═══╝  ╚══════╝╚══════╝ ╚═════╝  ╚═════╝╚═╝   ╚═╝      ╚═╝   ',
];

const FROM = [173, 189, 255];
const TO = [79, 96, 168];

function gradient(text, row, rows) {
  if (!COLOR) return text;
  const cols = text.length;
  let out = '';
  let current = '';
  for (let i = 0; i < cols; i++) {
    const ch = text[i];
    if (ch === ' ') {
      out += ch;
      current = '';
      continue;
    }
    const t = Math.min(1, (i / Math.max(1, cols - 1)) * 0.78 + (row / Math.max(1, rows - 1)) * 0.22);
    const key = [0, 1, 2].map((k) => Math.round(FROM[k] + (TO[k] - FROM[k]) * t));
    const code = `\x1b[38;2;${key[0]};${key[1]};${key[2]}m`;
    if (code !== current) {
      out += code;
      current = code;
    }
    out += ch;
  }
  return out + (COLOR ? '\x1b[39m' : '');
}

const PANEL_W = 62;

logger.panel = function panel(title, rows) {
  const out = [];
  const head = ` ${c.accent(title)} `;
  out.push(
    c.faint('╭') +
      c.faint('─') +
      head +
      c.faint('─'.repeat(Math.max(0, PANEL_W - 3 - width(head)))) +
      c.faint('╮')
  );
  for (const [label, value] of rows) {
    const l = c.muted(padEnd(String(label), 11));
    const v = c.ink(String(value));
    const inner = ` ${l} ${v}`;
    out.push(c.faint('│') + padEnd(inner, PANEL_W - 2) + c.faint('│'));
  }
  out.push(c.faint('╰') + c.faint('─'.repeat(PANEL_W - 2)) + c.faint('╯'));
  process.stdout.write(out.join('\n') + '\n');
};

logger.banner = function banner(subtitle) {
  const out = ['', ...ART.map((l, i) => '  ' + gradient(l, i, ART.length))];
  if (subtitle) {
    out.push('  ' + c.faint('─'.repeat(62)));
    out.push('  ' + c.muted(subtitle));
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
};

logger.rule = function rule(title) {
  const head = title ? ` ${c.accentDeep(title)} ` : '';
  process.stdout.write(
    '\n' + c.faint('──') + head + c.faint('─'.repeat(Math.max(0, PANEL_W - 2 - width(head)))) + '\n'
  );
};

logger.step = function step(text, state = 'run') {
  const marks = {
    run:  c.accentDeep('◦'),
    ok:   c.green('✔'),
    fail: c.red('✖'),
    skip: c.faint('–'),
  };
  process.stdout.write(`  ${marks[state] || marks.run} ${c.muted(text)}\n`);
};

logger.boot = function boot({ port, drives, workers, extra }) {
  logger.banner('The first-class file storage solution.');
  const rows = [
    ['Local', `http://localhost:${port}`],
    ['Network', `http://${firstLanAddress()}:${port}`],
    ['Drives', drives && drives.length ? drives.join(', ') : 'internal'],
    ['Workers', `${workers} size worker${workers === 1 ? '' : 's'}`],
    ['Runtime', `node ${process.version} · pid ${process.pid}`],
    ['Platform', `${os.type()} ${os.release()} · ${os.cpus().length} cpu`],
  ];
  if (extra) rows.push(...extra);
  logger.panel('velocity', rows);
  process.stdout.write('\n');
};

function firstLanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

logger.colors = c;
logger.hasColor = COLOR;

module.exports = logger;
