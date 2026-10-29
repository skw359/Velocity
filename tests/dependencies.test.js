// Guards on the source itself: no undeclared or unused server dependencies (review A2),
// and no shell-interpreted child processes (review C2).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies || {}));

function sourceFiles() {
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, f));
  const routes = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routes)) if (f.endsWith('.js')) files.push(path.join(routes, f));
  return files;
}

function requiredPackages(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [];
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) names.push(m[1]);
  return names;
}

// The node: scheme only ever names core modules, including ones newer than the running
// Node (db.js falls back to node:sqlite, which Node 20 doesn't have).
const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec);
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

test('every package the server requires is declared, and every declared one is used', () => {
  const used = new Set();
  for (const file of sourceFiles()) {
    for (const spec of requiredPackages(file)) {
      if (spec.startsWith('.') || isBuiltin(spec)) continue;
      const name = packageName(spec);
      used.add(name);
      assert.ok(declared.has(name), `${path.relative(ROOT, file)} requires undeclared '${name}'`);
    }
  }
  for (const name of declared) assert.ok(used.has(name), `'${name}' is declared in package.json but never required`);
});

test('the dead dependencies the review found are gone', () => {
  for (const name of ['drivelist', 'jszip', 'pptx-preview', 'pptxjs', 'werift', 'unzipper']) {
    assert.ok(!declared.has(name), name);
  }
});

test('child processes are never started through a shell', () => {
  let users = 0;
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    assert.doesNotMatch(src, /shell\s*:\s*true/, `${rel} enables a shell`);
    if (!/require\(\s*['"](node:)?child_process['"]\s*\)/.test(src)) continue;
    users++;
    // Only the argument-array forms may be imported...
    for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
      for (const name of names) assert.ok(['execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(name), `${rel} imports ${name}`);
    }
    // ...and the module is never used whole (childProcess.exec(...)).
    assert.doesNotMatch(src, /(?:const|let|var)\s+[\w$]+\s*=\s*require\(\s*['"](node:)?child_process['"]\s*\)/, `${rel} imports child_process whole`);
  }
  assert.ok(users >= 2, 'media.js and drives.js run tools');
});

test('the broken single-user migration is gone', () => {
  for (const file of sourceFiles()) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /LEGACY_(USERNAME|PASSWORD_HASH)|migrateSingleUserInstall/, path.relative(ROOT, file));
  }
});
