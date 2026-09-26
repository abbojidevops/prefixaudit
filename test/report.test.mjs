/**
 * Client audit report generator — the done-for-you engagement deliverable.
 *
 * These tests run the REAL CLI to produce the JSON, then assert on the report.
 * The ones that matter most are the honesty invariants: a client report that
 * presents a model as a measurement, or claims a correctly-placed prompt has a
 * critical defect, costs the engagement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMarkdown, buildHtml, triage, money, pct, parseArgs, main } from '../scripts/audit-report.mjs';
import { RULE_CATALOG } from '../src/engine.mjs';

const root = path.resolve(import.meta.dirname, '..');
const CLI = path.join(root, 'cli', 'prefix-audit.mjs');
const GEN = path.join(root, 'scripts', 'audit-report.mjs');

function auditJson(args) {
  // The CLI exits 1 on findings, which makes execFileSync throw. That exit code
  // is the product's answer, not a harness error.
  try {
    return JSON.parse(
      execFileSync(process.execPath, [CLI, ...args, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (e) {
    if (e.stdout === undefined || e.status !== 1) throw e;
    return JSON.parse(e.stdout);
  }
}

const base = { client: 'Acme Corp', engineer: 'Test', scope: 'test scope', date: '2026-09-22' };

/* ------------------------------- structure ------------------------------- */

test('report has every section a client expects', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']), ...base });
  for (const section of [
    '# Prompt Cache Audit',
    '## Executive summary',
    '## Findings',
    '## Cost model',
    '## Recommended remediation, in order',
    '## Instrument before you optimise further',
    '## What this audit could not determine',
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

test('cover block carries the client metadata', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--logs-cache']), ...base });
  assert.ok(md.includes('Acme Corp'));
  assert.ok(md.includes('2026-09-22'));
  assert.ok(md.includes('test scope'));
  assert.match(md, /Static analysis, PrefixAudit v/);
});

/* ------------------------- the severity-grouping bug ---------------------- */

test('a finding demoted to info is NOT counted as critical', () => {
  // Regression: grouping by rule id alone merged an `info` timestamp (correctly
  // placed after the cache breakpoint) into the critical row, so the report
  // told the client a clean prompt had a critical defect.
  const json = auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']);

  const clean = json.results.find((r) => r.file.endsWith('clean-request.json'));
  const ts = clean.findings.find((f) => f.id === 'dynamic-timestamp');
  assert.equal(ts.severity, 'info', 'precondition: clean example should be demoted');

  const md = buildMarkdown({ json, ...base });
  const criticalRow = md
    .split('\n')
    .find((l) => l.startsWith('| Critical | A timestamp is inside the cached prefix |'));
  assert.ok(criticalRow, 'expected a critical timestamp row');
  // "| Critical | title | 2 |" -> cells are at indexes 1..3 once split.
  const cells = criticalRow.split('|').map((c) => c.trim()).filter(Boolean);
  assert.equal(cells[cells.length - 1], '2', `critical row should count 2, got: ${criticalRow}`);

  const infoRow = md
    .split('\n')
    .find((l) => l.startsWith('| Info | A timestamp is inside the cached prefix |'));
  assert.ok(infoRow, 'the advisory must appear as its own row, not be folded into critical');
});

test('the clean example is never listed as having a critical finding', () => {
  const json = auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']);
  const md = buildMarkdown({ json, ...base });
  // Find the critical timestamp detail block and check its file list.
  const idx = md.indexOf('#### Critical — A timestamp is inside the cached prefix');
  assert.ok(idx >= 0);
  const block = md.slice(idx, idx + 2000);
  assert.ok(!block.includes('clean-request.json'), `clean example leaked into the critical block:\n${block}`);
});

/* ------------------------------ honesty rules ---------------------------- */

test('every dollar figure is labelled a model, not a measurement', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']), ...base });
  assert.match(md, /model, not a measurement/i);
  assert.match(md, /not an invoice line/i);
  assert.match(md, /could not determine/i);
  // The caveats must bound the numbers explicitly.
  assert.match(md, /We saw prompts, not traffic/);
  assert.match(md, /±14%/);
});

test('the report tells the client to verify the findings', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--logs-cache']), ...base });
  assert.match(md, /Static analysis has false positives/);
  assert.match(md, /Please check them/);
});

test('the report names the instrumentation fields needed to measure for real', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--logs-cache']), ...base });
  assert.ok(md.includes('cache_read_input_tokens'));
  assert.ok(md.includes('cached_tokens'));
  assert.ok(md.includes('total_cached_tokens'));
});

/* -------------------------------- content -------------------------------- */

test('evidence quotes the actual offending line', () => {
  const md = buildMarkdown({ json: auditJson(['examples/broken-support-prompt.md', '--requests', '8000']), ...base });
  assert.ok(md.includes('Current date and time: 2026-09-22T14:03:11Z'));
  assert.match(md, /\*\*Remediation\.\*\*/);
});

test('remediation plan is ordered by impact then effort, not just severity', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']), ...base });
  const start = md.indexOf('## Recommended remediation, in order');
  const table = md.slice(start, md.indexOf('##', start + 10));
  const impacts = [...table.matchAll(/\| (High|Medium|Low) \|$/gm)].map((m) => m[1]);
  assert.ok(impacts.length >= 3, `expected a populated plan, got ${impacts.length} rows`);
  const rank = { High: 0, Medium: 1, Low: 2 };
  for (let i = 1; i < impacts.length; i += 1) {
    assert.ok(rank[impacts[i]] >= rank[impacts[i - 1]], `plan not ordered by impact: ${impacts.join(',')}`);
  }
});

test('triage gives every catalogue rule an effort and an impact', () => {
  for (const r of RULE_CATALOG) {
    const t = triage({ id: r.id, severity: r.severity });
    assert.ok(['Low', 'Medium', 'High'].includes(t.effort), `${r.id}: bad effort ${t.effort}`);
    assert.ok(['Low', 'Medium', 'High'].includes(t.impact), `${r.id}: bad impact ${t.impact}`);
    assert.ok(t.note.length > 20, `${r.id}: note too vague`);
  }
});

test('empty input produces a usable report rather than crashing', () => {
  const md = buildMarkdown({ json: { results: [] }, ...base });
  assert.ok(md.includes('No prompts were audited'));
  assert.ok(!md.includes('NaN'));
  assert.ok(!md.includes('undefined'));
});

test('the report never contains NaN, undefined or a raw null', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']), ...base });
  assert.ok(!/\bNaN\b/.test(md), 'NaN leaked into the report');
  assert.ok(!/\bundefined\b/.test(md), 'undefined leaked into the report');
  assert.ok(!/\bnull\b/.test(md), 'null leaked into the report');
});

/* --------------------------------- HTML ---------------------------------- */

test('HTML is fully converted markdown with no leftovers', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--requests', '8000', '--logs-cache']), ...base });
  const html = buildHtml(md, base);
  assert.ok(!/^\|.*\|$/m.test(html), 'unconverted table row');
  assert.ok(!/^####/m.test(html), 'unconverted heading');
  assert.ok(!/^\*\*/m.test(html), 'unconverted bold');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<h2>'));
});

test('HTML is self-contained (no external CSS, JS or fonts)', () => {
  const md = buildMarkdown({ json: auditJson(['--dir', 'examples', '--logs-cache']), ...base });
  const html = buildHtml(md, base);
  assert.ok(!/src="http/.test(html));
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  assert.ok(html.includes('<style>'));
});

test('HTML escapes angle brackets in evidence', () => {
  const md = '## t\n\n> `<script>alert(1)</script>`\n';
  const html = buildHtml(md, base);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'evidence was not escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ------------------------------ formatters ------------------------------- */

test('money and pct format predictably', () => {
  assert.equal(money(0), '$0');
  assert.equal(money(74.76), '$75', 'must round like the CLI');
  assert.equal(money(1033.4), '$1,033');
  assert.equal(money(NaN), '$0');
  assert.equal(pct(0.0812), '8%');
  assert.equal(pct(0.92), '92%');
  assert.equal(pct(undefined), '0%');
});

/* ---------------------------------- CLI ---------------------------------- */

test('parseArgs reads every flag', () => {
  const o = parseArgs(['--in', 'a.json', '--out', 'r.md', '--html', 'r.html', '--client', 'X', '--engineer', 'Y', '--scope', 'Z', '--date', '2026-01-01']);
  assert.deepEqual(
    { in: o.in, out: o.out, html: o.html, client: o.client, engineer: o.engineer, scope: o.scope, date: o.date },
    { in: 'a.json', out: 'r.md', html: 'r.html', client: 'X', engineer: 'Y', scope: 'Z', date: '2026-01-01' },
  );
});

test('the generator runs end to end from the CLI and writes both formats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rep-'));
  const jsonPath = path.join(dir, 'a.json');
  let raw;
  try {
    raw = execFileSync(process.execPath, [CLI, '--dir', 'examples', '--requests', '8000', '--logs-cache', '--json'], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    raw = e.stdout;
  }
  fs.writeFileSync(jsonPath, raw);

  const mdOut = path.join(dir, 'r.md');
  const htmlOut = path.join(dir, 'r.html');
  const r = spawnSync(process.execPath, [GEN, '--in', jsonPath, '--out', mdOut, '--html', htmlOut, '--client', 'Beta Ltd'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(mdOut));
  assert.ok(fs.existsSync(htmlOut));
  assert.ok(fs.readFileSync(mdOut, 'utf8').includes('Beta Ltd'));
});

test('the generator exits 2 on a missing or invalid input', () => {
  assert.equal(main(['--in', '/nonexistent/x.json']), 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rep-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ nope');
  assert.equal(main(['--in', bad]), 2);
});
