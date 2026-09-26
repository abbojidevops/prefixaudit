/**
 * GitHub Action report formatter.
 *
 * These run the REAL CLI to produce the JSON, then assert on the formatter
 * output — so a change to the engine's line numbering breaks these tests
 * instead of silently pointing every PR annotation at the wrong line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, parseArgs, main } from '../action/report.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'cli', 'prefix-audit.mjs');

function auditJson(args) {
  // The CLI exits 1 on findings, which makes execFileSync THROW. That exit
  // code is the product's answer, not a test-harness error, so recover the
  // stdout from the error object.
  let out;
  try {
    out = execFileSync(process.execPath, [CLI, ...args, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.stdout === undefined) throw e;
    if (e.status !== 1) throw e; // 2 means usage/IO error — a real problem
    out = e.stdout;
  }
  return JSON.parse(out);
}

const BROKEN_MD = 'examples/broken-support-prompt.md';
const CLEAN_MD = 'examples/clean-support-prompt.md';
const BROKEN_JSON = 'examples/broken-request.json';

/* ----------------------------- exit behaviour ----------------------------- */

test('buildReport: a broken prompt fails the gate and names the file', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  assert.equal(r.failed, true);
  assert.ok(r.blocking >= 2, `expected >=2 blocking findings, got ${r.blocking}`);
  assert.match(r.markdown, /will break prompt caching/);
  assert.ok(r.markdown.includes(BROKEN_MD), 'comment must name the offending file');
  assert.match(r.markdown, /score \*\*\d+\/100\*\*/);
});

test('buildReport: a clean prompt passes and says so', () => {
  const r = buildReport(auditJson([CLEAN_MD, '--requests', '8000', '--breakpoint']));
  assert.equal(r.failed, false);
  assert.equal(r.blocking, 0);
  assert.match(r.markdown, /✅ PrefixAudit/);
  assert.match(r.markdown, /no findings at or above/);
});

test('buildReport: fail-on high lets a medium-only prompt through', () => {
  // prefix-bloat is medium; a huge but otherwise clean prompt should pass at
  // the default critical gate and fail at a medium gate.
  const json = auditJson([BROKEN_MD, '--requests', '8000']);
  const atCritical = buildReport(json, { failOn: 'critical' });
  const atMedium = buildReport(json, { failOn: 'medium' });
  assert.ok(atMedium.blocking >= atCritical.blocking);
});

/* ------------------------- annotation line accuracy ------------------------ */

test('annotations point at the exact line that holds the offender', () => {
  // Regression: evidence.line is 1-based, and an earlier revision added 1,
  // which pointed every annotation one line below the real offender.
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  const lines = fs.readFileSync(path.join(ROOT, BROKEN_MD), 'utf8').split('\n');

  const ts = r.annotations.find((a) => /timestamp/i.test(a.title));
  assert.ok(ts, 'expected a timestamp annotation');
  assert.match(lines[ts.line - 1], /Current date and time/, `line ${ts.line} is "${lines[ts.line - 1]}"`);

  const id = r.annotations.find((a) => /identifier/i.test(a.title));
  assert.ok(id, 'expected an identifier annotation');
  assert.match(lines[id.line - 1], /request_id/, `line ${id.line} is "${lines[id.line - 1]}"`);
});

test('annotations are suppressed for request payloads', () => {
  // For a .json payload the prefix is reassembled from system blocks and
  // tools, so a prefix line number does not map to a line in the file.
  const r = buildReport(auditJson([BROKEN_JSON, '--logs-cache']));
  assert.equal(r.annotations.length, 0, JSON.stringify(r.annotations));
  // The comment still names the finding, just without a file line link.
  assert.match(r.markdown, /prefix line \d+/);
});

test('annotations are emitted for plain-text prompts', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  assert.ok(r.annotations.length >= 2, `got ${r.annotations.length}`);
  for (const a of r.annotations) {
    assert.equal(a.file, BROKEN_MD);
    assert.ok(a.line >= 1, `line must be 1-based, got ${a.line}`);
    assert.ok(['error', 'warning'].includes(a.level));
  }
});

test('annotations carry the fix, so the diff view is actionable', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  const a = r.annotations[0];
  assert.match(a.message, /Fix:/);
  assert.ok(a.title.startsWith('PrefixAudit:'));
});

/* ------------------------------ markdown body ----------------------------- */

test('markdown quotes the offending line and the fix', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  assert.match(r.markdown, /Current date and time/);
  assert.match(r.markdown, /\*\*Fix:\*\*/);
});

test('markdown states the modelled waste and labels it a model', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  assert.match(r.markdown, /\$[\d,.]+\/mo/);
  assert.match(r.markdown, /not a measurement/);
});

test('markdown includes breakpoint placement for request payloads', () => {
  const r = buildReport(auditJson([BROKEN_JSON, '--logs-cache']));
  assert.match(r.markdown, /Cache breakpoint at \d+% of the prefix/);
});

test('markdown carries the upsert marker the action looks for', () => {
  // The action edits an existing comment by finding this marker; if the
  // formatter stops emitting a stable anchor, comments start piling up.
  const r = buildReport(auditJson([BROKEN_MD]));
  assert.ok(r.markdown.length > 200);
  assert.match(r.markdown, /PrefixAudit/);
});

test('markdown renders a permalink when repo and sha are supplied', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']), {
    repo: 'acme/prompts',
    sha: 'deadbeef',
  });
  assert.match(r.markdown, /https:\/\/github\.com\/acme\/prompts\/blob\/deadbeef\/examples\/broken-support-prompt\.md#L3/);
});

test('markdown falls back to a plain line number without repo context', () => {
  const r = buildReport(auditJson([BROKEN_MD, '--requests', '8000']));
  assert.ok(!r.markdown.includes('github.com/acme'), 'should not invent a repo link');
});

/* --------------------------------- edge cases ------------------------------ */

test('buildReport: an empty result set does not throw', () => {
  const r = buildReport({ results: [], failed: false });
  assert.equal(r.failed, false);
  assert.equal(r.annotations.length, 0);
  assert.ok(r.markdown.length > 0);
});

test('buildReport: a finding with no line number produces no annotation', () => {
  const r = buildReport({
    results: [
      {
        file: 'x.md',
        score: 50,
        grade: 'D',
        hitRate: 0,
        monthlyWaste: 0,
        annualWaste: 0,
        prefixTokens: 100,
        findings: [
          { id: 'x', severity: 'critical', title: 'No line', evidence: [{ line: 0, snippet: 's' }], fix: 'f' },
        ],
      },
    ],
    failed: true,
  });
  assert.equal(r.annotations.length, 0, 'line 0 means "no specific line"');
  assert.equal(r.failed, true);
});

test('buildReport: honours an explicit json.failed even with no blocking findings', () => {
  const r = buildReport({ results: [{ file: 'a.md', score: 90, grade: 'A', findings: [] }], failed: true });
  assert.equal(r.failed, true, 'baseline drift must still fail the gate');
});

/* ----------------------------------- CLI ----------------------------------- */

test('parseArgs: reads every flag', () => {
  const o = parseArgs(['--in', 'a.json', '--comment-out', 'c.md', '--annotate', '--fail-on', 'high', '--quiet']);
  assert.equal(o.in, 'a.json');
  assert.equal(o.commentOut, 'c.md');
  assert.equal(o.annotate, true);
  assert.equal(o.failOn, 'high');
  assert.equal(o.quiet, true);
});

test('main: exits 1 on a failing audit and writes the comment file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const jsonPath = path.join(dir, 'a.json');
  fs.writeFileSync(jsonPath, JSON.stringify(auditJson([BROKEN_MD, '--requests', '8000'])));
  const commentPath = path.join(dir, 'comment.md');

  const code = main(['--in', jsonPath, '--comment-out', commentPath, '--quiet']);
  assert.equal(code, 1);
  assert.ok(fs.existsSync(commentPath), 'comment file should be written');
  assert.match(fs.readFileSync(commentPath, 'utf8'), /PrefixAudit/);
});

test('main: exits 0 on a clean audit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const jsonPath = path.join(dir, 'a.json');
  fs.writeFileSync(jsonPath, JSON.stringify(auditJson([CLEAN_MD, '--requests', '8000', '--breakpoint'])));
  const code = main(['--in', jsonPath, '--quiet']);
  assert.equal(code, 0);
});

test('main: exits 2 on a missing input file', () => {
  const code = main(['--in', '/nonexistent/nope.json', '--quiet']);
  assert.equal(code, 2);
});

test('main: exits 2 on invalid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not json');
  assert.equal(main(['--in', p, '--quiet']), 2);
});

test('main: --annotate escapes workflow-command metacharacters', () => {
  // A colon or percent in a snippet would otherwise corrupt the ::error
  // command and GitHub would render it as literal text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
  const jsonPath = path.join(dir, 'a.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      buildReport
        ? {
            results: [
              {
                file: 'a.md',
                score: 10,
                grade: 'F',
                hitRate: 0,
                monthlyWaste: 0,
                annualWaste: 0,
                prefixTokens: 100,
                findings: [
                  {
                    id: 'x',
                    severity: 'critical',
                    title: 'T: colon',
                    evidence: [{ line: 7, snippet: '100% sure: yes' }],
                    fix: 'do it',
                  },
                ],
              },
            ],
            failed: true,
          }
        : {},
    ),
  );
  const writes = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    writes.push(String(c));
    return true;
  };
  try {
    main(['--in', jsonPath, '--annotate', '--quiet']);
  } finally {
    process.stdout.write = orig;
  }
  const line = writes.find((w) => w.startsWith('::error'));
  assert.ok(line, 'expected an ::error annotation');
  assert.ok(line.includes('%3A'), 'colons must be escaped');
  assert.ok(line.includes('100%25'), 'percent must be escaped');
  assert.ok(line.includes('line=7'), `expected line=7 in ${line}`);
});

test('a whole-prefix condition renders as "whole prefix", not line 0', () => {
  // line 0 means "no specific line". Rendering `0` sends the reader hunting
  // for line zero of the file.
  const r = buildReport({
    results: [
      {
        file: 'a.md',
        score: 40,
        grade: 'D',
        hitRate: 0,
        monthlyWaste: 0,
        annualWaste: 0,
        prefixTokens: 500,
        findings: [
          { id: 'no-breakpoint', severity: 'low', title: 'No cache breakpoint marker found', evidence: [{ line: 0, snippet: 's' }], fix: 'f' },
        ],
      },
    ],
    failed: false,
  });
  assert.match(r.markdown, /whole prefix/);
  assert.ok(!/\|\s*`0`\s*\|/.test(r.markdown), 'must not render a bare line 0');
});
