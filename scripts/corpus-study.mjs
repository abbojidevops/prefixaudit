#!/usr/bin/env node
/**
 * Corpus study: run PrefixAudit over a large set of real, published system
 * prompts and aggregate what actually breaks prompt caching in the wild.
 *
 * Methodology notes (read these before quoting any number):
 *
 * 1. RULE SCOPE. Four of the fourteen rules need request-level or runtime
 *    context that extracted prompt text does not contain:
 *      - no-breakpoint   (cache_control lives in the API request, not the text)
 *      - no-cache-metric (logging is application code)
 *      - model-churn     (model names appear in prose; not evidence of routing)
 *      - ttl-cadence     (needs real inter-request timing)
 *    They are EXCLUDED here. Including them would inflate findings with
 *    artefacts of the dataset rather than properties of the prompts.
 *
 * 2. DETECTION vs DOLLARS. Rule hits are exact. The dollar figures are a
 *    model: they apply published provider multipliers to an assumed request
 *    volume that is NOT known for any of these products. Treat the dollars as
 *    an illustration of scale for a single hypothetical workload, never as a
 *    claim about any company's actual spend.
 *
 * 3. A prompt being flagged is not a claim that a product is broken. Large
 *    providers have context and engineering we cannot see. This measures
 *    structure, not competence.
 *
 * Usage: node scripts/corpus-study.mjs <prompts-dir> [--out research/findings.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, RULE_CATALOG } from '../src/engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Rules that require context an extracted prompt cannot supply. */
const OUT_OF_SCOPE = new Set(['no-breakpoint', 'no-cache-metric', 'model-churn', 'ttl-cadence']);

function parseArgs(argv) {
  const dir = argv[0];
  if (!dir) {
    console.error('usage: corpus-study.mjs <prompts-dir> [--out file.json] [--requests n]');
    process.exit(2);
  }
  const outIdx = argv.indexOf('--out');
  const reqIdx = argv.indexOf('--requests');
  return {
    dir,
    out: outIdx === -1 ? path.join(root, 'research', 'findings.json') : argv[outIdx + 1],
    requests: reqIdx === -1 ? 1000 : Number(argv[reqIdx + 1]),
  };
}

/**
 * Path segments that indicate a file is NOT a system prompt.
 *
 * A prompt archive contains far more than prompts: on-demand skill docs,
 * worked examples, API references, repo metadata, superseded versions. Auditing
 * those and calling the result "N system prompts" would be dishonest, and it
 * inflates every finding because example code is full of the patterns we flag.
 */
const NOT_A_PROMPT = [
  /[\\/]skills[\\/]/i,
  /[\\/]examples?[\\/]/i,
  /[\\/]references?[\\/]/i,
  /[\\/]\.github[\\/]/i,
  /[\\/]old[\\/]/i,
  /[\\/]raw[\\/]/i,
  /[\\/]assets?[\\/]/i,
  /[\\/]public[\\/]/i,
  /contributing\.md$/i,
  /license\.md$/i,
  /changelog\.md$/i,
];

function walk(dir, stats = { kept: 0, skipped: 0, skippedSample: [] }) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = walk(full, stats);
      out.push(...sub);
      continue;
    }
    if (!e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase() === 'readme.md') continue;
    const rel = path.relative(dir, full);
    if (NOT_A_PROMPT.some((re) => re.test(full) || re.test(rel))) {
      stats.skipped += 1;
      if (stats.skippedSample.length < 6) stats.skippedSample.push(rel);
      continue;
    }
    stats.kept += 1;
    out.push(full);
  }
  return out.sort();
}

function main() {
  const { dir, out, requests } = parseArgs(process.argv.slice(2));
  const stats = { kept: 0, skipped: 0, skippedSample: [] };
  const files = walk(dir, stats);
  if (!files.length) {
    console.error(`no prompt files found under ${dir}`);
    process.exit(2);
  }

  const rows = [];
  const ruleHits = new Map();
  const ruleExamples = new Map();
  const vendorTotals = new Map();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim().length < 40) continue;

    const res = audit({
      systemPrompt: text,
      providerKey: 'anthropic',
      requestsPerDay: requests,
      hasBreakpoint: true,     // assume best case: they DO set cache_control
      logsCacheTokens: true,   // assume best case: they DO log it
    });

    // Keep only in-scope rules.
    const findings = res.findings.filter((f) => !OUT_OF_SCOPE.has(f.id));
    if (!findings.length && res.findings.every((f) => OUT_OF_SCOPE.has(f.id))) {
      // Nothing in scope to say. Still count the file as analysed.
    }

    const rel = path.relative(dir, file);
    const vendor = rel.split(path.sep)[0] || 'unknown';

    const row = {
      file: rel,
      vendor,
      tokens: res.prefixTokens,
      totalTokensInCorpus: res.prefixTokens,
      findings: findings.map((f) => ({ id: f.id, severity: f.severity, count: f.evidence.length })),
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      hitRate: res.hitRate,
    };
    rows.push(row);

    const v = vendorTotals.get(vendor) || { vendor, files: 0, critical: 0, high: 0, anyFinding: 0, tokens: 0 };
    v.files += 1;
    v.critical += row.critical;
    v.high += row.high;
    v.tokens += row.tokens;
    if (findings.length) v.anyFinding += 1;
    vendorTotals.set(vendor, v);

    for (const f of findings) {
      ruleHits.set(f.id, (ruleHits.get(f.id) || 0) + 1);
      if (!ruleExamples.has(f.id)) {
        ruleExamples.set(f.id, { file: rel, line: f.evidence[0]?.line, snippet: f.evidence[0]?.snippet });
      }
    }
  }

  const n = rows.length;
  const withAny = rows.filter((r) => r.findings.length > 0);
  const withCritical = rows.filter((r) => r.critical > 0);
  const withHighOrWorse = rows.filter((r) => r.critical > 0 || r.high > 0);
  const withHigh = rows.filter((r) => r.high > 0);
  const zeroHit = rows.filter((r) => r.hitRate === 0);
  const belowMin = rows.filter((r) => r.findings.some((f) => f.id === 'below-minimum'));

  const tokens = rows.map((r) => r.tokens).sort((a, b) => a - b);
  const pct = (p) => tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * p))];
  const median = pct(0.5);
  const mean = Math.round(tokens.reduce((a, b) => a + b, 0) / n);

  const summary = {
    generatedAt: new Date().toISOString(),
    sourceDir: path.resolve(dir),
    corpusFiles: n,
    corpusFilter: {
      kept: stats.kept,
      excluded: stats.skipped,
      excludedReason:
        'Skill docs, worked examples, API references, repo metadata and superseded versions are not system prompts. Auditing them would inflate every finding, because example code is full of the patterns we detect.',
      excludedExamples: stats.skippedSample,
    },
    vendors: [...new Set(rows.map((r) => r.vendor))].sort(),
    requestsPerDayAssumed: requests,
    ruleScope: {
      included: RULE_CATALOG.filter((r) => !OUT_OF_SCOPE.has(r.id)).map((r) => r.id),
      excluded: [...OUT_OF_SCOPE],
      excludedReason:
        'These rules need request-level or runtime context that extracted prompt text does not contain. Including them would report dataset artefacts, not prompt properties.',
    },
    headline: {
      analysed: n,
      withAnyFinding: withAny.length,
      withAnyFindingPct: +((withAny.length / n) * 100).toFixed(1),
      withCritical: withCritical.length,
      withCriticalPct: +((withCritical.length / n) * 100).toFixed(1),
      withHighOrWorse: withHighOrWorse.length,
      withHighOrWorsePct: +((withHighOrWorse.length / n) * 100).toFixed(1),
      zeroHitRateCeiling: zeroHit.length,
      zeroHitRatePct: +((zeroHit.length / n) * 100).toFixed(1),
      belowProviderMinimum: belowMin.length,
      belowProviderMinimumPct: +((belowMin.length / n) * 100).toFixed(1),
    },
    prefixTokens: { min: tokens[0], p25: pct(0.25), median, p75: pct(0.75), p90: pct(0.9), max: tokens[n - 1], mean },
    rulesByFrequency: [...ruleHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({
        id,
        severity: RULE_CATALOG.find((r) => r.id === id)?.severity,
        title: RULE_CATALOG.find((r) => r.id === id)?.title,
        files: count,
        pctOfCorpus: +((count / n) * 100).toFixed(1),
        example: ruleExamples.get(id),
      })),
    byVendor: [...vendorTotals.values()]
      .filter((v) => v.files >= 2)
      .sort((a, b) => b.files - a.files)
      .map((v) => ({
        ...v,
        pctWithFinding: +((v.anyFinding / v.files) * 100).toFixed(1),
        medianTokens: undefined,
      })),
    worstOffenders: [...rows]
      .sort((a, b) => b.critical - a.critical || b.high - a.high || b.tokens - a.tokens)
      .slice(0, 20)
      .map((r) => ({ file: r.file, vendor: r.vendor, tokens: r.tokens, critical: r.critical, high: r.high, hitRate: r.hitRate })),
  };

  // Per-vendor median tokens (needs the rows, not the aggregate).
  for (const v of summary.byVendor) {
    const vt = rows.filter((r) => r.vendor === v.vendor).map((r) => r.tokens).sort((a, b) => a - b);
    v.medianTokens = vt[Math.floor(vt.length / 2)];
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));

  /* console report */
  const h = summary.headline;
  console.log('═'.repeat(72));
  console.log('  PrefixAudit corpus study');
  console.log('═'.repeat(72));
  console.log(`  ${n} system prompts · ${summary.vendors.length} vendors`);
  console.log(`  (excluded ${stats.skipped} non-prompt files: skills, examples, references, repo metadata)`);
  console.log('');
  console.log(`  prompts with at least one in-scope finding : ${h.withAnyFinding}/${n}  (${h.withAnyFindingPct}%)`);
  console.log(`  prompts with a CRITICAL finding            : ${h.withCritical}/${n}  (${h.withCriticalPct}%)`);
  console.log(`  prompts with 0% cache-hit ceiling          : ${h.zeroHitRateCeiling}/${n}  (${h.zeroHitRatePct}%)`);
  console.log(`  prompts below the provider cache minimum   : ${h.belowProviderMinimum}/${n}  (${h.belowProviderMinimumPct}%)`);
  console.log('');
  console.log(`  prefix size (est. tokens)  median ${median.toLocaleString()}  mean ${mean.toLocaleString()}  p90 ${pct(0.9).toLocaleString()}  max ${tokens[n - 1].toLocaleString()}`);
  console.log('');
  console.log('  rules by frequency');
  console.log('  ' + '─'.repeat(68));
  for (const r of summary.rulesByFrequency) {
    console.log(`  ${String(r.files).padStart(4)}  ${r.pctOfCorpus.toString().padStart(5)}%  [${r.severity.toUpperCase().padEnd(8)}] ${r.id}`);
  }
  console.log('');
  console.log('  by vendor (>=2 prompts)');
  console.log('  ' + '─'.repeat(68));
  for (const v of summary.byVendor.slice(0, 12)) {
    console.log(`  ${String(v.files).padStart(4)}  ${v.vendor.padEnd(14)} critical:${String(v.critical).padStart(3)}  with-finding:${v.pctWithFinding}%`);
  }
  console.log('═'.repeat(72));
  console.log(`  wrote ${path.relative(root, out)}`);
}

main();
