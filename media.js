// Preview derivatives made by external tools: .mov -> .mp4 (ffmpeg) and .cr3 -> .jpg
// (ImageMagick, else the JPEG preview embedded in the raw file via ExifTool).
//
// Tools are always run with execFile and an argument array, never through a shell, so a
// filename is only ever one literal argument: $(...), backticks, ; and & mean nothing.
// Paths passed are absolute, so none can be read as an option, and each input is checked
// to really be the format its extension claims before a complex parser sees it. Output is
// written under a temporary name and renamed into place, so a half-written preview is
// never served.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const sharp = require('sharp');
const logger = require('./logger');
const { IS_WINDOWS } = require('./paths');

const FFMPEG_TIMEOUT_MS = 2 * 60 * 60 * 1000; // a long video at 'veryfast' still finishes well inside this
const IMAGE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

// Each tool is a command array: [executable, ...leading args], or null when absent.
const tools = { magick: null, ffmpeg: null, exiftool: null };

function hasTool(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

// ImageMagick v6 (still Ubuntu's apt default) is `convert`, not `magick`. `convert` is never
// probed on Windows, where System32\convert.exe is the FAT-to-NTFS tool.
function resolveExternalTools() {
  const magickCandidates = IS_WINDOWS ? ['magick'] : ['magick', 'convert'];
  const magick = magickCandidates.find(candidate => hasTool(candidate, ['-version'])) || null;
  tools.magick = magick ? [magick] : null;
  tools.ffmpeg = hasTool('ffmpeg', ['-version']) ? ['ffmpeg'] : null;
  tools.exiftool = hasTool('exiftool', ['-ver']) ? ['exiftool'] : null;

  const report = [
    ['ImageMagick', tools.magick, 'CR3 (raw photo) previews'],
    ['ffmpeg', tools.ffmpeg, '.mov transcoding'],
    ['exiftool', tools.exiftool, 'CR3 preview extraction'],
  ];
  for (const [name, cmd, purpose] of report) {
    if (cmd) logger.info(`[Tools] ${name} available as '${cmd[0]}'`);
    else logger.warn(`[Tools] ${name} not found on PATH: ${purpose} disabled`);
  }
}

// Overrides tool commands (the tests substitute a recording stand-in).
function setTools(overrides) {
  Object.assign(tools, overrides);
}

// Running conversions, so shutdown can stop them instead of leaving them orphaned.
const children = new Set();

function run(tool, args, opts = {}) {
  const [cmd, ...lead] = tool;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, [...lead, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      children.delete(child);
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    children.add(child);
  });
}

function firstLine(text) {
  return String(text || '').split('\n').find((l) => l.trim()) || '';
}

// ---- format checks -----------------------------------------------------------------------

async function readHead(file, length = 16) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// ISO-BMFF / QuickTime: a box type at offset 4. CR3 is ISO-BMFF with the 'crx ' brand.
const QUICKTIME_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);
function isQuickTime(head) {
  return head.length >= 8 && QUICKTIME_BOXES.has(head.toString('latin1', 4, 8));
}
function isCanonCr3(head) {
  return head.length >= 12 && head.toString('latin1', 4, 12) === 'ftypcrx ';
}
function isJpeg(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// ---- preview names (shared with the routes that look them up) ------------------------

function videoPreviewName(sourceName) {
  return `${path.parse(sourceName).name}.mp4`;
}

function rawPreviewName(sourceName) {
  return `${path.basename(sourceName)}.jpg`;
}

function needsPreview(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.mov' || ext === '.cr3';
}

// Runs produce(tmpPath) and renames the result to finalPath only if it succeeded.
async function writeAtomically(finalPath, produce) {
  const tmp = path.join(path.dirname(finalPath), `.tmp-${crypto.randomBytes(6).toString('hex')}${path.extname(finalPath)}`);
  try {
    await produce(tmp);
    await fs.promises.rename(tmp, finalPath);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

// ---- converters ---------------------------------------------------------------------------

async function transcodeMov(sourcePath, cacheDir) {
  if (!tools.ffmpeg) return false;
  if (!isQuickTime(await readHead(sourcePath))) {
    logger.warn(`[FFmpeg] Skipped ${sourcePath}: not a QuickTime file`);
    return false;
  }
  const outputPath = path.join(cacheDir, videoPreviewName(sourcePath));
  const threads = Math.max(1, Math.floor(os.cpus().length * 0.9));
  logger.info(`[FFmpeg] Starting conversion for ${sourcePath}`);
  await writeAtomically(outputPath, (tmp) => run(tools.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-threads', String(threads),
    // The demuxer is fixed, so a playlist or concat script renamed to .mov can't make
    // ffmpeg open other files or URLs.
    '-f', 'mov', '-i', sourcePath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    '-f', 'mp4', '-y', tmp,
  ], { timeout: FFMPEG_TIMEOUT_MS }));
  logger.info(`[FFmpeg] Converted ${path.basename(outputPath)}`);
  return true;
}

async function convertCr3(sourcePath, cacheDir) {
  if (!tools.magick && !tools.exiftool) return false;
  if (!isCanonCr3(await readHead(sourcePath))) {
    logger.warn(`[CR3 Converter] Skipped ${sourcePath}: not a Canon CR3 file`);
    return false;
  }
  const outputPath = path.join(cacheDir, rawPreviewName(sourcePath));
  logger.info(`[CR3 Converter] Starting conversion for: ${sourcePath}`);

  if (tools.magick) {
    try {
      // The cr3: and jpeg: prefixes pin the coders, so content sniffing can never route
      // the file to another decoder (PostScript, MVG, ...).
      await writeAtomically(outputPath, (tmp) => run(tools.magick, [
        `cr3:${sourcePath}`, '-auto-orient', '-quality', '90', `jpeg:${tmp}`,
      ], { timeout: IMAGE_TIMEOUT_MS }));
      logger.info(`[CR3 Converter] SUCCESS (ImageMagick): ${outputPath}`);
      return true;
    } catch (e) {
      logger.warn(`[CR3 Converter] ImageMagick failed (${firstLine(e.stderr) || e.message}); trying the embedded preview.`);
    }
  }

  if (!tools.exiftool) return false;
  // The preview comes back on stdout: no output file name for exiftool to interpret.
  const { stdout } = await run(tools.exiftool, ['-b', '-PreviewImage', '--', sourcePath], {
    encoding: 'buffer', maxBuffer: MAX_PREVIEW_BYTES, timeout: IMAGE_TIMEOUT_MS,
  });
  if (!isJpeg(stdout)) throw new Error('the embedded preview is not a JPEG');
  // sharp decodes only what it was given, and orients by the preview's own EXIF.
  await writeAtomically(outputPath, (tmp) => sharp(stdout).rotate().jpeg({ quality: 90 }).toFile(tmp));
  logger.info(`[CR3 Converter] SUCCESS (embedded preview): ${outputPath}`);
  return true;
}

// ---- queue --------------------------------------------------------------------------------

// One conversion at a time: each can use every core.
const queue = [];
let pumping = false;

function enqueue(sourcePath, cacheDir) {
  if (!cacheDir || !needsPreview(sourcePath)) return;
  if (queue.some((job) => job.sourcePath === sourcePath)) return;
  queue.push({ sourcePath, cacheDir });
  logger.info(`[Transcoding Queue] Added ${sourcePath} to queue (queue length: ${queue.length})`);
  pump();
}

async function processJob({ sourcePath, cacheDir }) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.mov') return transcodeMov(sourcePath, cacheDir);
  if (ext === '.cr3') return convertCr3(sourcePath, cacheDir);
  return false;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      logger.info(`[Transcoding Queue] Processing ${job.sourcePath} (${queue.length} remaining in queue)`);
      try {
        await processJob(job);
      } catch (e) {
        logger.error(`[Transcoding Queue] Failed for ${job.sourcePath}: ${firstLine(e.stderr) || e.message}`);
      }
    }
  } finally {
    pumping = false;
  }
}

// Resolves once the queue is empty (tests).
async function idle() {
  while (pumping || queue.length) await new Promise((r) => setTimeout(r, 20));
}

// Drops queued jobs and stops running tools; their temporary output is removed as each
// conversion fails, and the uploaded originals are untouched.
function shutdown() {
  queue.length = 0;
  for (const child of children) child.kill();
}

module.exports = {
  resolveExternalTools,
  setTools,
  enqueue,
  idle,
  shutdown,
  needsPreview,
  videoPreviewName,
  rawPreviewName,
  transcodeMov,
  convertCr3,
};
