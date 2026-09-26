#!/usr/bin/env node
/**
 * Pre-publish check. Run before every `npm publish`.
 *
 * Fails loudly rather than shipping something broken. The check that matters
 * most is #3: npm installs `bin` entries as symlinks, and an entry-point guard
 * that does not resolve them makes the CLI print nothing and exit 0. In CI that
 * means a broken prompt silently passes — the single worst failure mode this
 * product can have. It is checked against the real packed tarball, installed
 * into a temp directory, not against the working tree.
 *
 * Usage: node scripts/check-publish.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// `npm` is npm.cmd on Windows; spawning it needs a shell there.
const IS_WIN = process.platform === 'win32';

let failures = 0;
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    const detail = fn();
    process.stdout.write(`  ok    ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (e) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${e.message}\n`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

process.stdout.write(`\npre-publish check — ${pkg.name}@${pkg.version}\n\n`);

/* ------------------------------ 1. metadata ------------------------------ */

check('required metadata present', () => {
  for (const k of ['name', 'version', 'description', 'license', 'bin', 'files']) {
    assert(pkg[k], `package.json is missing "${k}"`);
  }
  assert(!pkg.private, '"private": true would block publishing');
  return `${pkg.license}, ${Object.keys(pkg.bin).join(', ')}`;
});

check('bin paths use the form npm keeps at publish', () => {
  // npm >= 11 rewrites the manifest when publishing and DROPS any bin entry
  // whose path has a leading "./" — shipping a CLI with no command. npm pack
  // never shows this; it only happens against the registry. The bare relative
  // form (what `npm pkg fix` writes) survives. See check output of 2026-09-26.
  for (const [name, rel] of Object.entries(pkg.bin)) {
    assert(!rel.startsWith('./'), `bin "${name}" path "${rel}" starts with ./ — npm 11 would strip the whole entry at publish`);
  }
  return Object.values(pkg.bin).join(', ');
});

check('engines.node matches the code', () => {
  assert(pkg.engines?.node, 'no engines.node declared');
  // The CLI uses node:test, ?? and optional chaining; >=18 is the real floor.
  assert(/(>=|\^)?\s*1[89]|>=\s*2\d/.test(pkg.engines.node), `engines.node "${pkg.engines.node}" looks too old`);
  return pkg.engines.node;
});

/* ---------------------------- 2. tarball shape --------------------------- */

const tarball = (() => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { shell: IS_WIN,
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out)[0];
})();
const packed = tarball.files.map((f) => f.path);

check('bin entry is packed', () => {
  for (const rel of Object.values(pkg.bin)) {
    const p = rel.replace(/^\.\//, '');
    assert(packed.includes(p), `${p} is not in the tarball`);
    assert(fs.existsSync(path.join(root, p)), `${p} does not exist on disk`);
  }
  return Object.values(pkg.bin).join(', ');
});

check('engine and action are packed (bin depends on them)', () => {
  for (const need of ['src/engine.mjs', 'action/report.mjs', 'action.yml']) {
    assert(packed.includes(need), `${need} missing — the published CLI/Action would break`);
  }
  return `${packed.length} files total`;
});

check('no tests, build output, research or business docs leak', () => {
  const forbidden = packed.filter(
    (f) =>
      f.startsWith('test/') ||
      f.startsWith('dist/') ||
      f.startsWith('research/') ||
      f.startsWith('launch/') ||
      f.startsWith('scripts/') ||
      f.startsWith('site/') ||
      f.startsWith('examples/') ||
      f.startsWith('sample-report/') ||
      /BUSINESS\.md|REPORT\.md|DEPLOY\.md|\.tgz$/.test(f),
  );
  // audit-report.mjs is deliberately shipped; it is the client deliverable.
  const real = forbidden.filter((f) => f !== 'scripts/audit-report.mjs');
  assert(real.length === 0, `would publish: ${real.join(', ')}`);
  return `${packed.length} files, none sensitive`;
});

check('tarball is small', () => {
  const kb = tarball.size / 1024;
  assert(kb < 200, `tarball is ${kb.toFixed(0)} KB — something unexpected is included`);
  return `${kb.toFixed(1)} KB packed`;
});

/* --------------------- 3. the installed binary actually runs --------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pub-'));
try {
  execFileSync('npm', ['pack', '--pack-destination', tmp], { shell: IS_WIN,
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  execFileSync('npm', ['init', '-y'], { shell: IS_WIN, cwd: tmp, stdio: 'ignore' });
  execFileSync('npm', ['install', path.join(tmp, tgz)], { shell: IS_WIN, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });

  const isWin = process.platform === 'win32';
  const binName = Object.keys(pkg.bin)[0];
  // npm links bins as symlinks on unix but as .cmd shims on Windows.
  const binLink = path.join(tmp, 'node_modules', '.bin', isWin ? `${binName}.cmd` : binName);
  const runBin = (args) => spawnSync(binLink, args, { cwd: tmp, encoding: 'utf8', shell: isWin });
  check('npm installed a runnable bin', () => {
    assert(fs.existsSync(binLink), `${binLink} was not created`);
    if (!isWin) assert(fs.lstatSync(binLink).isSymbolicLink(), 'expected a symlink (this is what npm does)');
    return path.basename(binLink);
  });

  const broken = path.join(tmp, 'broken.md');
  fs.writeFileSync(
    broken,
    'You are an agent.\nCurrent date: 2026-09-22\nrequest_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f\n' +
      'Policy instruction that is long enough to clear the cache minimum. '.repeat(120),
  );
  const clean = path.join(tmp, 'clean.md');
  fs.writeFileSync(
    clean,
    'You are an agent.\n' + 'Policy instruction that is long enough to clear the cache minimum. '.repeat(120),
  );

  check('installed CLI prints a report through the symlink', () => {
    const r = runBin([broken, '--requests', '5000']);
    assert(r.stdout.length > 100, `printed nothing (exit ${r.status}) — the entry guard is broken`);
    assert(/score \d+\/100/.test(r.stdout), 'no score in output');
    return `${r.stdout.length} bytes`;
  });

  check('broken prompt exits 1 from the installed package', () => {
    const r = runBin([broken, '--requests', '5000']);
    assert(r.status === 1, `expected 1, got ${r.status}`);
    return 'exit 1';
  });

  check('clean prompt exits 0 from the installed package', () => {
    const r = runBin([clean, '--breakpoint', '--logs-cache']);
    assert(r.stdout.length > 100, 'printed nothing');
    assert(r.status === 0, `expected 0, got ${r.status}: ${r.stdout.slice(0, 300)}`);
    return 'exit 0';
  });

  check('--list-rules works from the installed package', () => {
    const r = runBin(['--list-rules']);
    assert(r.status === 0, `exit ${r.status}`);
    const n = r.stdout.split('\n').filter((l) => /^(CRITICAL|HIGH|MEDIUM|LOW)/.test(l)).length;
    assert(n >= 10, `expected 10+ rules, got ${n}`);
    return `${n} rules`;
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ----------------------- 4. registry (best effort) ----------------------- */

check('version is not already published', () => {
  const r = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { shell: IS_WIN,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return 'not on the registry (or offline — verify manually)';
  throw new Error(`${pkg.name}@${pkg.version} already exists; bump the version`);
});

/* -------------------------------- verdict ------------------------------- */

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
if (failures) {
  process.stdout.write(`\nDO NOT PUBLISH — ${failures} check(s) failed.\n\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nSafe to publish:  npm publish --access public\n\n`);
}
