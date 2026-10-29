const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isolate, cleanup, startServer, Client, signup, uploadBuffer, userRoot } = require('./support/harness');

const dataDir = isolate();
const media = require('../media');
const sharp = require('sharp');

// Any command a shell ran from a filename would land here, never in the repository.
const sandbox = path.join(dataDir, 'cwd');
fs.mkdirSync(sandbox, { recursive: true });
const originalCwd = process.cwd();
process.chdir(sandbox);

const FAKE = path.join(__dirname, 'support', 'fake-tool.js');
const toolLog = path.join(dataDir, 'tool-calls.jsonl');
const cacheDir = path.join(dataDir, 'cache');
const srcDir = path.join(dataDir, 'src');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(srcDir, { recursive: true });

// Names an injection would have to survive on every platform (no / \ : * ? " < > |).
const HOSTILE_NAMES = [
  'a$(touch CANARY1).mov',
  'a`touch CANARY2`.mov',
  'a;touch CANARY3;b.mov',
  'a&&touch CANARY4&&b.mov',
  "it's a 'quote'.mov",
  '-version.mov',
  '%d %s.mov',
];

const QUICKTIME = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(32)]);
const CR3 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypcrx '), Buffer.alloc(32)]);

function calls() {
  if (!fs.existsSync(toolLog)) return [];
  return fs.readFileSync(toolLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function canaries() {
  return fs.readdirSync(sandbox).filter((n) => n.startsWith('CANARY'));
}

function useFakeTools(names = ['ffmpeg', 'magick', 'exiftool']) {
  media.setTools(Object.fromEntries(['ffmpeg', 'magick', 'exiftool'].map((t) => [t, names.includes(t) ? [process.execPath, FAKE, t] : null])));
}

before(async () => {
  const jpeg = path.join(dataDir, 'preview.jpg');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4060ff' } }).jpeg().toFile(jpeg);
  process.env.FAKE_TOOL_JPEG = jpeg;
  process.env.FAKE_TOOL_LOG = toolLog;
});

beforeEach(() => {
  fs.rmSync(toolLog, { force: true });
  delete process.env.FAKE_MAGICK_FAIL;
  delete process.env.FAKE_EXIF_OUTPUT;
  delete process.env.FAKE_TOOL_DELAY_MS;
  useFakeTools();
});

after(() => {
  process.chdir(originalCwd);
  cleanup(dataDir);
});

describe('tool invocation never goes through a shell', () => {
  test('each hostile .mov name reaches ffmpeg as one literal argument and runs nothing', async () => {
    for (const name of HOSTILE_NAMES) {
      const src = path.join(srcDir, name);
      fs.writeFileSync(src, QUICKTIME);
      assert.strictEqual(await media.transcodeMov(src, cacheDir), true, name);
      const output = path.join(cacheDir, media.videoPreviewName(name));
      assert.ok(fs.existsSync(output), `preview for ${name}`);
    }
    const ffmpegCalls = calls().filter((c) => c.tool === 'ffmpeg');
    assert.strictEqual(ffmpegCalls.length, HOSTILE_NAMES.length);
    for (const [i, call] of ffmpegCalls.entries()) {
      const src = path.join(srcDir, HOSTILE_NAMES[i]);
      // The path is a single argv element, right after '-i', with the demuxer pinned.
      assert.strictEqual(call.args[call.args.indexOf('-i') + 1], src);
      assert.strictEqual(call.args[call.args.indexOf('-i') - 1], 'mov');
      // Absolute paths can't be mistaken for options.
      assert.ok(path.isAbsolute(call.args[call.args.length - 1]));
    }
    assert.deepStrictEqual(canaries(), []);
  });

  test('hostile .cr3 names reach ImageMagick and ExifTool as literal arguments', async () => {
    for (const name of HOSTILE_NAMES.map((n) => n.replace(/\.mov$/, '.cr3'))) {
      const src = path.join(srcDir, name);
      fs.writeFileSync(src, CR3);

      fs.rmSync(toolLog, { force: true });
      delete process.env.FAKE_MAGICK_FAIL;
      assert.strictEqual(await media.convertCr3(src, cacheDir), true);
      const [magickCall] = calls();
      assert.strictEqual(magickCall.args[0], `cr3:${src}`, 'decoder pinned, path intact');
      assert.match(magickCall.args[magickCall.args.length - 1], /^jpeg:/);

      // ImageMagick failing falls back to the embedded preview through ExifTool.
      fs.rmSync(toolLog, { force: true });
      process.env.FAKE_MAGICK_FAIL = '1';
      fs.rmSync(path.join(cacheDir, media.rawPreviewName(name)), { force: true });
      assert.strictEqual(await media.convertCr3(src, cacheDir), true);
      const exifCall = calls().find((c) => c.tool === 'exiftool');
      assert.deepStrictEqual(exifCall.args, ['-b', '-PreviewImage', '--', src]);
      assert.ok(fs.existsSync(path.join(cacheDir, media.rawPreviewName(name))));
    }
    assert.deepStrictEqual(canaries(), []);
  });
});

describe('inputs are checked before a complex parser sees them', () => {
  test('a .mov that is really a playlist is not handed to ffmpeg', async () => {
    const src = path.join(srcDir, 'playlist.mov');
    fs.writeFileSync(src, '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n');
    assert.strictEqual(await media.transcodeMov(src, cacheDir), false);
    assert.deepStrictEqual(calls(), []);
  });

  test('a .cr3 that is really PostScript is not handed to ImageMagick or ExifTool', async () => {
    const src = path.join(srcDir, 'ghostscript.cr3');
    fs.writeFileSync(src, '%!PS-Adobe-3.0\n(pwned) print\n');
    assert.strictEqual(await media.convertCr3(src, cacheDir), false);
    assert.deepStrictEqual(calls(), []);
  });

  test("an embedded preview that isn't a JPEG is rejected and nothing is written", async () => {
    const src = path.join(srcDir, 'odd-preview.cr3');
    fs.writeFileSync(src, CR3);
    useFakeTools(['exiftool']);
    const fakeOut = path.join(dataDir, 'not-a-jpeg.bin');
    fs.writeFileSync(fakeOut, '%!PS-Adobe-3.0');
    process.env.FAKE_EXIF_OUTPUT = fakeOut;
    await assert.rejects(media.convertCr3(src, cacheDir), /not a JPEG/);
    assert.ok(!fs.existsSync(path.join(cacheDir, media.rawPreviewName('odd-preview.cr3'))));
  });
});

test('a preview only appears under its real name once the tool has finished', async () => {
  const src = path.join(srcDir, 'slow.mov');
  fs.writeFileSync(src, QUICKTIME);
  process.env.FAKE_TOOL_DELAY_MS = '600';
  const finalPath = path.join(cacheDir, 'slow.mp4');
  const running = media.transcodeMov(src, cacheDir);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!fs.existsSync(finalPath), 'half-written preview must not be visible');
  await running;
  assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'fake mp4 data');
  assert.deepStrictEqual(fs.readdirSync(cacheDir).filter((n) => n.startsWith('.tmp-')), []);
});

test('the queue runs each source once and survives a failing job', async () => {
  const ok = path.join(srcDir, 'queued.mov');
  const bad = path.join(srcDir, 'not-video.mov');
  fs.writeFileSync(ok, QUICKTIME);
  fs.writeFileSync(bad, 'nope');
  media.enqueue(bad, cacheDir);
  media.enqueue(ok, cacheDir);
  media.enqueue(ok, cacheDir);
  await media.idle();
  assert.strictEqual(calls().filter((c) => c.tool === 'ffmpeg').length, 1);
  assert.ok(fs.existsSync(path.join(cacheDir, 'queued.mp4')));
});

describe('upload to preview, end to end', () => {
  let server;
  let client;
  let user;

  before(async () => {
    server = await startServer();
    client = new Client(server.base);
    user = await signup(client, 'mediauser');
  });
  after(() => server.close());

  test('a hostile filename uploads, transcodes, and its preview is served by an encoded URL', async () => {
    const name = 'clip #1 $(touch CANARY9).mov';
    const up = await uploadBuffer(client, { name, data: QUICKTIME });
    assert.strictEqual(up.status, 200, up.text);
    await media.idle();
    assert.deepStrictEqual(canaries(), []);
    assert.ok(fs.existsSync(path.join(userRoot(dataDir, user.id), 'cache', 'clip #1 $(touch CANARY9).mp4')));

    const lookup = await client.get(`/api/preview/video?path=${encodeURIComponent('/' + name)}&drive=internal`);
    assert.strictEqual(lookup.status, 200, lookup.text);
    const { previewUrl } = lookup.json();
    assert.strictEqual(previewUrl, `/content/cache/${encodeURIComponent('clip #1 $(touch CANARY9).mp4')}`);
    const video = await client.get(previewUrl);
    assert.strictEqual(video.status, 200);
    assert.strictEqual(video.text, 'fake mp4 data');
  });
});

function realTool(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 10000, windowsHide: true }); return true; } catch { return false; }
}

test('real ffmpeg: a hostile filename transcodes and executes nothing', { skip: !realTool('ffmpeg', ['-version']) && 'ffmpeg not installed' }, async () => {
  media.setTools({ ffmpeg: ['ffmpeg'] });
  const src = path.join(srcDir, 'real $(touch CANARY_REAL) `touch CANARY_REAL2`;.mov');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
    '-f', 'mov', '-y', src], { stdio: 'ignore', timeout: 60000, windowsHide: true });
  assert.strictEqual(await media.transcodeMov(src, cacheDir), true);
  const out = path.join(cacheDir, media.videoPreviewName(path.basename(src)));
  const head = fs.readFileSync(out).subarray(4, 8).toString('latin1');
  assert.strictEqual(head, 'ftyp', 'a real mp4 was produced');
  assert.deepStrictEqual(canaries(), []);
});
