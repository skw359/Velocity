// Stands in for ffmpeg, magick or exiftool: appends its argv to FAKE_TOOL_LOG and produces
// output the way the real tool would, interpreting nothing it was given.
//   node fake-tool.js <ffmpeg|magick|exiftool> ...args

const fs = require('fs');

const [, , tool, ...args] = process.argv;
if (process.env.FAKE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_TOOL_LOG, JSON.stringify({ tool, args }) + '\n');
const output = () => args[args.length - 1].replace(/^jpeg:/, '');

function finish() {
  if (tool === 'ffmpeg') {
    fs.writeFileSync(output(), 'fake mp4 data');
  } else if (tool === 'magick') {
    if (process.env.FAKE_MAGICK_FAIL) {
      process.stderr.write('magick: no decode delegate for this image format\n');
      process.exit(1);
    }
    fs.copyFileSync(process.env.FAKE_TOOL_JPEG, output());
  } else if (tool === 'exiftool') {
    process.stdout.write(fs.readFileSync(process.env.FAKE_EXIF_OUTPUT || process.env.FAKE_TOOL_JPEG));
  }
}

const delay = Number(process.env.FAKE_TOOL_DELAY_MS || 0);
if (delay && tool === 'ffmpeg') {
  // Like the real thing, the output file exists (incomplete) while the tool runs.
  fs.writeFileSync(output(), 'partial');
  setTimeout(finish, delay);
} else {
  finish();
}
