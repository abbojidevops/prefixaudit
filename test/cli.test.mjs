import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseArgs, expandDir, shouldFail, hashOf, checkBaseline } from '../cli/prefix-audit.mjs';
import { audit } from '../src/engine.mjs';

const BROKEN = `You are a support agent.
Current date and time: 2026-09-22T14:03:11Z
request_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f

## Working memory
- last step: lookup

## Tools
- look_up(id: string) -> Record
`.padEnd(6000, 'Follow the policy handbook precisely and never speculate. ');

const CLEAN = `You are a support agent.

## Tools
- look_up(id: string) -> Record

## Policy
Verify identity. Never speculate.
`.padEnd(6000, 'Follow the policy handbook precisely and never speculate. ');

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    paths[name] = p;
  }
  return { dir, paths };
}

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const code = fn();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

/* ------------------------------ arg parsing ------------------------------ */

test('parseArgs: defaults', () => {
  const o = parseArgs(['a.md']);
  assert.equal(o.provider, 'anthropic');
  assert.equal(o.requestsPerDay, 1000);
  assert.equal(o.failOn, 'critical');
  assert.equal(o.ttl, '5m');
  assert.deepEqual(o.files, ['a.md']);
});

test('parseArgs: flags and overrides', () => {
  const o = parseArgs([
    'p.md', '--provider', 'openai', '--requests', '5000', '--gap', '12',
    '--ttl', '1h', '--base-price', '2.5', '--read-mult', '0.2',
    '--write-mult', '2', '--min-tokens', '2048', '--breakpoint',
    '--logs-cache', '--fail-on', 'high', '--max-waste', '500', '--json',
  ]);
  assert.equal(o.provider, 'openai');
  assert.equal(o.requestsPerDay, 5000);
  assert.equal(o.gapMinutes, 12);
  assert.equal(o.ttl, '1h');
  assert.deepEqual(o.priceOverrides, { baseInputPerM: 2.5, readMult: 0.2, writeMult: 2, minTokens: 2048 });
  assert.equal(o.hasBreakpoint, true);
  assert.equal(o.logsCacheTokens, true);
  assert.equal(o.failOn, 'high');
  assert.equal(o.maxWaste, 500);
  assert.equal(o.json, true);
});

test('parseArgs: rejects bad values', () => {
  assert.throws(() => parseArgs(['--fail-on', 'nope']));
  assert.throws(() => parseArgs(['--ttl', '9m']));
  assert.throws(() => parseArgs(['--requests', 'abc']));
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--provider']));
});

/* ------------------------------ exit codes ------------------------------- */

test('CLI: a broken prompt exits 1 and names the timestamp', () => {
  const { paths } = tmp({ broken: BROKEN });
  const { code, out } = capture(() => main([paths.broken, '--provider', 'anthropic']));
  assert.equal(code, 1);
  assert.match(out, /timestamp/i);
  assert.match(out, /FAIL/);
});

test('CLI: a clean prompt exits 0', () => {
  const { paths } = tmp({ clean: CLEAN });
  const { code, out } = capture(() => main([paths.clean, '--provider', 'anthropic', '--breakpoint', '--logs-cache']));
  assert.equal(code, 0, out);
  assert.match(out, /PASS/);
});

test('CLI: --fail-on critical ignores high-severity findings', () => {
  // Clean prompt but no instrumentation -> only a HIGH finding.
  const { paths } = tmp({ clean: CLEAN });
  const { code } = capture(() => main([paths.clean, '--provider', 'anthropic', '--breakpoint', '--fail-on', 'critical']));
  assert.equal(code, 0);
  const { code: strict } = capture(() => main([paths.clean, '--provider', 'anthropic', '--breakpoint', '--fail-on', 'high']));
  assert.equal(strict, 1);
});

test('CLI: --max-waste gates on modelled dollars', () => {
  const { paths } = tmp({ broken: BROKEN });
  const { code } = capture(() => main([paths.broken, '--breakpoint', '--logs-cache', '--fail-on', 'medium', '--max-waste', '1']));
  assert.equal(code, 1);
});

test('CLI: --json emits parseable output with the cost block', () => {
  const { paths } = tmp({ broken: BROKEN });
  const { code, out } = capture(() => main([paths.broken, '--json']));
  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.tool, 'prefix-audit');
  assert.equal(parsed.results.length, 1);
  assert.ok(parsed.results[0].monthlyWaste > 0);
  assert.equal(parsed.failed, true);
});

test('CLI: no inputs is a usage error (exit 2), not a pass', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const code = main([]);
    assert.equal(code, 2);
  } finally {
    console.error = orig;
  }
});

test('CLI: --help exits 0 and documents the flags', () => {
  const { code, out } = capture(() => main(['--help']));
  assert.equal(code, 0);
  assert.match(out, /--fail-on/);
  assert.match(out, /--stability/);
});

test('CLI: --list-rules prints the catalogue', () => {
  const { code, out } = capture(() => main(['--list-rules']));
  assert.equal(code, 0);
  assert.match(out, /dynamic-timestamp/);
});

test('CLI: --version prints the engine version and exits 0', () => {
  const { code, out } = capture(() => main(['--version']));
  assert.equal(code, 0);
  assert.match(out, /^prefix-audit \d+\.\d+\.\d+$/);
});

test('CLI: -v is an alias for --version', () => {
  const { code, out } = capture(() => main(['-v']));
  assert.equal(code, 0);
  assert.match(out, /^prefix-audit \d+\.\d+\.\d+$/);
});

test('CLI: --help documents --version', () => {
  const { out } = capture(() => main(['--help']));
  assert.match(out, /--version/);
});

/* ------------------------------ --dir walking ---------------------------- */

test('expandDir: recurses and only picks plausible prompt/source files', () => {
  const { dir } = tmp({
    'a.md': 'x', 'b.txt': 'x', 'c.json': '{}', 'd.png': 'binary',
    'sub/e.md': 'x', 'sub/deep/f.prompt': 'x',
  });
  const found = expandDir(dir).map((p) => path.relative(dir, p).split(path.sep).join('/')).sort();
  assert.ok(found.includes('a.md'));
  assert.ok(found.includes('b.txt'));
  assert.ok(found.includes('c.json'));
  assert.ok(found.includes('sub/e.md'));
  assert.ok(found.includes('sub/deep/f.prompt'));
  assert.ok(!found.includes('d.png'), 'should skip binary assets');
});

test('CLI: --dir audits every prompt and sums the waste', () => {
  const { dir } = tmp({ 'one.md': BROKEN, 'two.md': BROKEN });
  const { code, out } = capture(() => main(['--dir', dir, '--json']));
  const parsed = JSON.parse(out);
  assert.equal(parsed.results.length, 2);
  assert.ok(parsed.totalMonthlyWaste > 0);
  assert.equal(code, 1);
});

/* ------------------------------ --stability ------------------------------ */

test('CLI: --stability exits 1 and localises the break', () => {
  const { paths } = tmp({
    t1: 'You are an agent. Current date: 2026-09-22. Follow policy.',
    t2: 'You are an agent. Current date: 2026-09-23. Follow policy.',
  });
  const { code, out } = capture(() => main(['--stability', paths.t1, paths.t2]));
  assert.equal(code, 1);
  assert.match(out, /UNSTABLE/);
  assert.match(out, /first divergence at byte/);
});

test('CLI: --stability exits 0 on identical renders', () => {
  const { paths } = tmp({ t1: 'You are an agent. Follow policy.', t2: 'You are an agent. Follow policy.' });
  const { code, out } = capture(() => main(['--stability', paths.t1, paths.t2]));
  assert.equal(code, 0);
  assert.match(out, /STABLE/);
});

test('CLI: --stability --json is machine readable', () => {
  const { paths } = tmp({ t1: 'AAA date: 1 BBB', t2: 'AAA date: 2 BBB' });
  const { out } = capture(() => main(['--stability', '--json', paths.t1, paths.t2]));
  const p = JSON.parse(out);
  assert.equal(p.mode, 'stability');
  assert.equal(p.ok, false);
  assert.equal(p.samples, 2);
});

/* ------------------------------ baseline gate ---------------------------- */

test('baseline: first run with --update-baseline writes and passes', () => {
  const { dir, paths } = tmp({ p: CLEAN });
  const bl = path.join(dir, 'cache', 'prefix.sha');
  const { code } = capture(() => main([paths.p, '--breakpoint', '--logs-cache', '--fail-on', 'medium', '--baseline', bl, '--update-baseline']));
  assert.equal(code, 0);
  assert.ok(fs.existsSync(bl));
  assert.equal(fs.readFileSync(bl, 'utf8').trim().length, 16);
});

test('baseline: unchanged prefix passes, changed prefix fails', () => {
  const { dir, paths } = tmp({ p: CLEAN });
  const bl = path.join(dir, 'prefix.sha');
  capture(() => main([paths.p, '--breakpoint', '--logs-cache', '--fail-on', 'medium', '--baseline', bl, '--update-baseline']));

  const same = capture(() => main([paths.p, '--breakpoint', '--logs-cache', '--fail-on', 'medium', '--baseline', bl]));
  assert.equal(same.code, 0, same.out);

  fs.writeFileSync(paths.p, CLEAN + '\nOne extra line that changes every byte after it.\n');
  const changed = capture(() => main([paths.p, '--breakpoint', '--logs-cache', '--fail-on', 'medium', '--baseline', bl]));
  assert.equal(changed.code, 1);
  assert.match(changed.out, /baseline|cold/i);
});

test('baseline: missing baseline file fails loudly rather than passing', () => {
  const { dir, paths } = tmp({ p: CLEAN });
  const bl = path.join(dir, 'nope.sha');
  const r = checkBaseline([{ file: paths.p, text: CLEAN }], { baseline: bl, updateBaseline: false });
  assert.equal(r.ok, false);
  assert.equal(r.missing, true);
});

/* ------------------------------ helpers ---------------------------------- */

test('shouldFail: threshold semantics', () => {
  const mk = (sev, waste = 0) => ({ findings: [{ severity: sev }], monthlyWaste: waste });
  assert.equal(shouldFail(mk('critical'), { failOn: 'critical', maxWaste: Infinity }), true);
  assert.equal(shouldFail(mk('high'), { failOn: 'critical', maxWaste: Infinity }), false);
  assert.equal(shouldFail(mk('high'), { failOn: 'high', maxWaste: Infinity }), true);
  assert.equal(shouldFail(mk('medium'), { failOn: 'medium', maxWaste: Infinity }), true);
  assert.equal(shouldFail(mk('low'), { failOn: 'medium', maxWaste: Infinity }), false);
  assert.equal(shouldFail(mk('low', 999), { failOn: 'critical', maxWaste: 100 }), true);
});

test('hashOf: stable and order sensitive', () => {
  assert.equal(hashOf('abc'), hashOf('abc'));
  assert.notEqual(hashOf('abc'), hashOf('abd'));
  assert.equal(hashOf('abc').length, 16);
});

test('CLI: price overrides flow through to the modelled cost', () => {
  const { paths } = tmp({ broken: BROKEN });
  const cheap = capture(() => main([paths.broken, '--breakpoint', '--logs-cache', '--json', '--base-price', '0.1']));
  const pricey = capture(() => main([paths.broken, '--breakpoint', '--logs-cache', '--json', '--base-price', '30']));
  const c = JSON.parse(cheap.out).results[0].cost.total;
  const p = JSON.parse(pricey.out).results[0].cost.total;
  assert.ok(p > c * 50, `cheap=${c} pricey=${p}`);
});

test('CLI: audit used by CLI matches direct engine call', () => {
  const direct = audit({ systemPrompt: BROKEN, providerKey: 'anthropic', requestsPerDay: 1000, hasBreakpoint: false, logsCacheTokens: false });
  const { paths } = tmp({ broken: BROKEN });
  const { out } = capture(() => main([paths.broken, '--json']));
  const viaCli = JSON.parse(out).results[0];
  assert.equal(viaCli.score, direct.score);
  assert.equal(viaCli.hitRate, direct.hitRate);
  assert.deepEqual(viaCli.findings.map((f) => f.id), direct.findings.map((f) => f.id));
});

/* ---------------------------- request payloads ---------------------------- */

const LONG = 'You are a support agent. Verify identity. Never invent policy. '.repeat(120);

function reqPayload(blocks, tools = []) {
  return JSON.stringify({ model: 'claude-opus-4-7', system: blocks, tools, messages: [{ role: 'user', content: 'hi' }] }, null, 2);
}

test('CLI: a .json file is auto-detected as a request payload', () => {
  const { paths } = tmp({
    'req.json': reqPayload([{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }]),
  });
  const { code, out } = capture(() => main([paths['req.json'], '--logs-cache']));
  assert.match(out, /payload: request JSON/);
  assert.match(out, /claude-opus-4-7/);
  assert.match(out, /breakpoint: at/);
  assert.equal(code, 0, out);
});

test('CLI: a broken payload fails and names the misplaced volatile content', () => {
  const { paths } = tmp({
    'bad.json': reqPayload([{ type: 'text', text: 'Current date: 2026-09-22\n' + LONG, cache_control: { type: 'ephemeral' } }]),
  });
  const { code, out } = capture(() => main([paths['bad.json'], '--logs-cache']));
  assert.equal(code, 1);
  assert.match(out, /BEFORE the breakpoint/);
});

test('CLI: the same content after the breakpoint passes', () => {
  const { paths } = tmp({
    'good.json': reqPayload([
      { type: 'text', text: LONG, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ]),
  });
  const { code, out } = capture(() => main([paths['good.json'], '--logs-cache']));
  assert.equal(code, 0, out);
  assert.match(out, /correctly placed/);
  assert.match(out, /grade A/);
});

test('CLI: a payload with no cache_control fails on Anthropic', () => {
  const { paths } = tmp({ 'nobp.json': reqPayload([{ type: 'text', text: LONG }]) });
  const { code, out } = capture(() => main([paths['nobp.json'], '--logs-cache']));
  assert.equal(code, 1);
  assert.match(out, /breakpoint: NONE/);
});

test('CLI: --payload forces payload mode on a non-.json file', () => {
  const { paths } = tmp({
    'req.txt': reqPayload([{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }]),
  });
  const { code, out } = capture(() => main([paths['req.txt'], '--payload', '--logs-cache']));
  assert.equal(code, 0, out);
  assert.match(out, /payload: request JSON/);
});

test('CLI: tool count is reported from the payload', () => {
  const tools = [
    { name: 'a', description: 'd', input_schema: { type: 'object' } },
    { name: 'b', description: 'd', input_schema: { type: 'object' } },
  ];
  const { paths } = tmp({ 't.json': reqPayload([{ type: 'text', text: LONG, cache_control: { type: 'ephemeral' } }], tools) });
  const { out } = capture(() => main([paths['t.json'], '--logs-cache']));
  assert.match(out, /2 tools/);
});

test('CLI: --json exposes the breakpoint block', () => {
  const { paths } = tmp({
    'j.json': reqPayload([
      { type: 'text', text: LONG, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ]),
  });
  const { out } = capture(() => main([paths['j.json'], '--json']));
  const p = JSON.parse(out).results[0];
  assert.equal(p.payload.kind, 'request');
  assert.equal(p.breakpoint.clean, true);
  assert.ok(p.breakpoint.tokensBefore > 100);
});

test('CLI: a malformed .json file does not crash', () => {
  const { paths } = tmp({ 'bad.json': '{ "system": "unterminated ' });
  const { code, out } = capture(() => main([paths['bad.json']]));
  assert.ok(code === 0 || code === 1, `unexpected exit ${code}`);
  assert.ok(out.length > 0);
});

test('CLI: the bundled examples demonstrate the fix', () => {
  const broken = capture(() => main(['examples/broken-request.json', '--logs-cache']));
  const clean = capture(() => main(['examples/clean-request.json', '--logs-cache']));
  assert.equal(broken.code, 1, 'broken example should fail');
  assert.equal(clean.code, 0, `clean example should pass: ${clean.out}`);
});

/* =================== installed-binary / symlink behaviour ===================
 * Regression: the entry guard compared argv[1] to import.meta.url with
 * path.resolve(), which does not follow symlinks. npm installs bin entries as
 * a symlink, so the guard failed, main() never ran, and the process exited 0
 * having printed nothing. For a CI gate that is the worst failure mode there
 * is: a broken prompt silently passes.
 */

import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'cli', 'prefix-audit.mjs');

function runViaBin(args, cwd) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
  });
}

// Windows cannot create symlinks without Developer Mode / admin (EPERM).
// The real bin behaviour is still covered by scripts/check-publish.mjs, which
// installs the tarball and runs npm's own shim. Skip gracefully elsewhere.
function symlinkOrSkip(t, dir) {
  const link = path.join(dir, 'prefix-audit');
  try {
    fs.symlinkSync(CLI_PATH, link);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOTSUP') {
      t.skip('symlink creation needs Developer Mode / admin on this platform');
      return null;
    }
    throw e;
  }
  return link;
}

test('the CLI runs when invoked through a symlink (npm bin layout)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bin-'));
  const link = symlinkOrSkip(t, dir);
  if (!link) return;

  const prompt = path.join(dir, 'p.md');
  fs.writeFileSync(
    prompt,
    'You are an agent.\nCurrent date: 2026-09-22\n' + 'Policy instruction line. '.repeat(200),
  );

  const r = spawnSync(process.execPath, [link, prompt, '--requests', '5000'], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.ok(r.stdout.length > 100, `symlinked invocation printed nothing (exit ${r.status})`);
  assert.match(r.stdout, /score \d+\/100/);
  assert.equal(r.status, 1, 'a broken prompt must fail the gate');
});

test('a symlinked clean prompt exits 0 rather than silently passing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bin-'));
  const link = symlinkOrSkip(t, dir);
  if (!link) return;

  // Use the repo's known-clean example rather than a synthetic one: a
  // generated prompt is easy to land just under the 1,024-token cache floor,
  // which makes below-minimum fire and the test fail for the wrong reason.
  const prompt = path.resolve(import.meta.dirname, '..', 'examples', 'clean-support-prompt.md');

  const r = spawnSync(process.execPath, [link, prompt, '--breakpoint', '--logs-cache'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.ok(r.stdout.length > 100, 'must still print a report');
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('--help works through a symlink and exits 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bin-'));
  const link = symlinkOrSkip(t, dir);
  if (!link) return;
  const r = spawnSync(process.execPath, [link, '--help'], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stdout, /USAGE/);
  assert.equal(r.status, 0);
});

test('a prompt that must fail does fail (guards against a silent no-op exit 0)', () => {
  // The invariant that actually matters: never exit 0 without printing a
  // verdict. A gate that says nothing and passes is worse than no gate.
  const r = runViaBin(['examples/broken-support-prompt.md', '--requests', '8000']);
  assert.ok(r.stdout.includes('score'), 'no verdict printed');
  assert.equal(r.status, 1);
});
