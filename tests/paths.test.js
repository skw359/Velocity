const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup, linkDir } = require('./support/harness');

const dataDir = isolate();
after(() => cleanup(dataDir));

const paths = require('../paths');

const root = path.join(dataDir, 'root');
const outside = path.join(dataDir, 'outside');
fs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'a');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

test('resolveInside keeps ordinary paths, and the root itself, inside the root', () => {
  assert.strictEqual(paths.resolveInside(root, '/'), root);
  assert.strictEqual(paths.resolveInside(root, ''), root);
  assert.strictEqual(paths.resolveInside(root, '/docs/a.txt'), path.join(root, 'docs', 'a.txt'));
  assert.strictEqual(paths.resolveInside(root, 'docs/deep/../a.txt'), path.join(root, 'docs', 'a.txt'));
  // Paths that don't exist yet (an upload target) resolve by where they would be created.
  assert.strictEqual(paths.resolveInside(root, '/docs/new/file.bin'), path.join(root, 'docs', 'new', 'file.bin'));
});

test('resolveInside refuses every traversal form', () => {
  const attempts = [
    '..', '../outside/secret.txt', '/../outside', 'docs/../../outside', '/docs/deep/../../../outside/secret.txt',
    `..${path.sep}outside`, '/..', 'docs/../..',
  ];
  for (const attempt of attempts) {
    assert.strictEqual(paths.resolveInside(root, attempt), null, attempt);
  }
});

test('resolveInside refuses malformed input instead of throwing', () => {
  for (const bad of ['a\0b', null, 42, ['a'], { toString: () => '..' }]) {
    assert.strictEqual(paths.resolveInside(root, bad), null, String(bad));
  }
  assert.strictEqual(paths.resolveInside('', 'a'), null);
  // Omitting the subpath means the root itself, as with getSafePath.
  assert.strictEqual(paths.resolveInside(root), root);
});

test('a sibling folder whose name starts with the root name is not inside it', () => {
  fs.mkdirSync(`${root}-other`, { recursive: true });
  assert.strictEqual(paths.isPathInside(root, `${root}-other`), false);
  assert.strictEqual(paths.resolveInside(root, `../${path.basename(root)}-other`), null);
});

test('a symlink or junction inside the root cannot lead out of it', () => {
  linkDir(outside, path.join(root, 'escape'));
  assert.strictEqual(paths.resolveInside(root, '/escape'), null);
  assert.strictEqual(paths.resolveInside(root, '/escape/secret.txt'), null);
  // ...not even for a path to be created under it.
  assert.strictEqual(paths.resolveInside(root, '/escape/new-folder/file.txt'), null);
});

test('a link that stays inside the root still works', () => {
  linkDir(path.join(root, 'docs'), path.join(root, 'docs-link'));
  assert.strictEqual(paths.resolveInside(root, '/docs-link/a.txt'), path.join(root, 'docs-link', 'a.txt'));
});

test('a root that is itself reached through a link is compared by its real location', () => {
  const linkedRoot = path.join(dataDir, 'linked-root');
  linkDir(root, linkedRoot);
  assert.strictEqual(paths.resolveInside(linkedRoot, '/docs/a.txt'), path.join(linkedRoot, 'docs', 'a.txt'));
  assert.strictEqual(paths.resolveInside(linkedRoot, '/escape/secret.txt'), null);
});

test('isValidItemName refuses names that address the folder itself or nest', () => {
  for (const ok of ['a.txt', 'My Folder', '...hidden', '.env', 'a b c']) assert.ok(paths.isValidItemName(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', '/', 'a\0b', null, undefined, 5]) assert.ok(!paths.isValidItemName(bad), String(bad));
  assert.strictEqual(paths.isValidItemName('a\\b'), process.platform !== 'win32');
});

test('sanitizePathSegment produces names usable on Windows', () => {
  assert.strictEqual(paths.sanitizePathSegment('a:b'), 'a-b');
  assert.strictEqual(paths.sanitizePathSegment('a<b>c"d|e?f*g'), 'a_b_c_d_e_f_g');
  assert.strictEqual(paths.sanitizePathSegment('trailing. . '), 'trailing');
  assert.strictEqual(paths.sanitizePathSegment('..'), 'upload');
  assert.strictEqual(paths.sanitizePathSegment('CON'), '_CON');
  assert.strictEqual(paths.sanitizePathSegment('nul.txt'), '_nul.txt');
  assert.strictEqual(paths.sanitizePathSegment('ctrl\x01char'), 'ctrl_char');
});

test('sanitizeUploadedRelativePath drops traversal segments and keeps the structure', () => {
  assert.strictEqual(paths.sanitizeUploadedRelativePath('../../etc/passwd'), path.join('etc', 'passwd'));
  assert.strictEqual(paths.sanitizeUploadedRelativePath('a\\..\\..\\b.txt'), path.join('a', 'b.txt'));
  assert.strictEqual(paths.sanitizeUploadedRelativePath('folder/./x:y.txt'), path.join('folder', 'x-y.txt'));
  assert.strictEqual(paths.sanitizeUploadedRelativePath('', 'fallback.bin'), 'fallback.bin');
});

test('shell metacharacters are not path syntax and survive sanitizing unchanged', () => {
  // Names are data: the media pipeline passes them as single arguments, never to a shell.
  for (const name of ['a;id.mov', 'a&&whoami.mov', 'a`echo hi`.mov', 'a$(echo hi).mov']) {
    assert.strictEqual(paths.sanitizePathSegment(name), name);
  }
});

test('on Windows, device names inside a path are refused', { skip: process.platform !== 'win32' }, () => {
  for (const dev of ['/CON', '/docs/nul.txt', '/COM1', '/aux']) assert.strictEqual(paths.resolveInside(root, dev), null, dev);
});

test('uniqueEntryNames and findFreeTransferName avoid collisions', () => {
  assert.deepStrictEqual(
    paths.uniqueEntryNames([{ name: 'a.txt' }, { name: 'A.txt' }, { name: 'dir', isDirectory: true }, { name: 'dir', isDirectory: true }]),
    ['a.txt', 'A-1.txt', 'dir', 'dir-1'],
  );
  fs.writeFileSync(path.join(root, 'docs', 'a-1.txt'), '');
  assert.strictEqual(paths.findFreeTransferName(path.join(root, 'docs'), 'a.txt', false), 'a-2.txt');
});
