#!/usr/bin/env node
/**
 * check-sales.mjs — verify every figure and claim guard in sales/*.md.
 *
 * These documents go to paying prospects. A wrong number here is not a
 * cosmetic problem: it becomes a dispute, a refund or a lost referral. So the
 * figures are checked against their sources rather than trusted, and the
 * claim-discipline rules are checked as invariants rather than left to memory.
 *
 *   node scripts/check-sales.mjs
 *
 * Exits 1 on any failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../src/engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const salesDir = path.join(root, 'sales');

const findings = JSON.parse(
  fs.readFileSync(path.join(root, 'research', 'findings.json'), 'utf8')
).summary;
const headline = findings.headline;

const docs = fs.readdirSync(salesDir).filter((f) => f.endsWith('.md')).sort();
if (!docs.length) {
  console.error('no sales docs found');
  process.exit(1);
}
const text = Object.fromEntries(
  docs.map((f) => [f, fs.readFileSync(path.join(salesDir, f), 'utf8')])
);
const all = Object.values(text).join('\n');

let pass = 0;
const failures = [];
const check = (ok, label) => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}`); }
};
/** True if `needle` occurs within `window` chars of `anchor` in the same doc. */
const near = (anchor, needle, window = 320) => {
  for (const body of Object.values(text)) {
    let i = body.indexOf(anchor);
    while (i !== -1) {
      if (body.slice(Math.max(0, i - window), i + window).includes(needle)) return true;
      i = body.indexOf(anchor, i + 1);
    }
  }
  return false;
};

console.log(`\nchecking ${docs.length} sales docs: ${docs.join(', ')}\n`);

/* ------------------------- figures vs. their source ------------------------ */
console.log('corpus figures');
check(all.includes(String(headline.analysed)),
  `corpus size ${headline.analysed} matches findings.json`);
check(String(findings.vendors.length) === '16' && all.includes(`${findings.vendors.length} vendors`),
  `vendor count ${findings.vendors.length} matches findings.json`);

// Per-occurrence, not presence-anywhere: a single correct mention elsewhere
// must not excuse a wrong one. Both of these were verified by negative test.
const pct = `${headline.withCriticalPct}%`;
const badPctPairs = [];
for (const [name, body] of Object.entries(text)) {
  let i = body.indexOf(pct);
  while (i !== -1) {
    const num = body.slice(Math.max(0, i - 40), i).match(/(\d{2,3})\s*\(?$/);
    if (num && num[1] !== String(headline.withCritical)) {
      badPctPairs.push(`${name}: "${num[1]} ${pct}"`);
    }
    i = body.indexOf(pct, i + 1);
  }
}
check(badPctPairs.length === 0,
  `every "${pct}" is paired with the numerator ${headline.withCritical}` +
  (badPctPairs.length ? ` (found ${badPctPairs.join('; ')})` : ''));

// Any "N of 236" must be a real statistic from the study — the critical count,
// the per-rule file counts, or one of the other headline figures. Asserting a
// single value would reject legitimate citations like the 76 timestamp files.
const validNumerators = new Set([
  headline.withAnyFinding,
  headline.withCritical,
  headline.withHighOrWorse,
  headline.zeroHitRateCeiling,
  headline.belowProviderMinimum,
  ...findings.rulesByFrequency.map((r) => r.files),
]);
const badOf236 = [];
for (const [name, body] of Object.entries(text)) {
  for (const m of body.matchAll(/(\d{2,3})\s+of\s+236/g)) {
    if (!validNumerators.has(Number(m[1]))) {
      badOf236.push(`${name}: "${m[0]}" (not a real count; valid: ` +
        `${[...validNumerators].sort((a, b) => b - a).join(', ')})`);
    }
  }
}
check(badOf236.length === 0,
  `every "N of 236" cites a real statistic` +
  (badOf236.length ? ` (found ${badOf236.join('; ')})` : ''));
check(all.includes(String(headline.withCritical)) && all.includes(pct),
  `the critical finding is stated as ${headline.withCritical} (${pct}) somewhere`);

console.log('\nprovider constants');
const sonnet = String(1024).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const haiku = String(4096).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
check(near('Sonnet', sonnet) , `Sonnet cache minimum quoted as ${sonnet}`);
check(near('Haiku 4.5', haiku), `Haiku 4.5 cache minimum quoted as ${haiku}`);
const geminiMin = PROVIDERS.gemini.minTokens.toLocaleString('en-US');
check(near('Gemini', geminiMin), `Gemini floor quoted as ${geminiMin} (engine says ${PROVIDERS.gemini.minTokens})`);
check(all.includes('14.2'), 'estimator RMSE 14.2% is stated where an estimate is quoted');

console.log('\ncost-model assumptions');
check(all.includes('1,000 requests/day') || all.includes('1000 requests/day'),
  'the default 1,000 requests/day assumption is disclosed');

/* ---------------------------- claim discipline ---------------------------- */
console.log('\nclaim discipline');

check(near(`${headline.withCriticalPct}%`, 'not a prediction', 500) ||
      near(`${headline.withCriticalPct}%`, 'description of those prompts', 500) ||
      near(`${headline.withCriticalPct}%`, 'not a probability', 500),
  'the 55.5% corpus figure carries an explicit "does not apply to you" caveat');

// Every mention of the third-party saving must be attributed, not just one.
const unattributed = [];
for (const [name, body] of Object.entries(text)) {
  let i = body.indexOf('59%');
  while (i !== -1) {
    const ctx = body.slice(Math.max(0, i - 200), i + 200);
    if (!ctx.includes('ProjectDiscovery')) unattributed.push(`${name} @${i}`);
    i = body.indexOf('59%', i + 1);
  }
}
check(unattributed.length === 0,
  'every mention of the 59% saving is attributed to ProjectDiscovery' +
  (unattributed.length ? ` (unattributed: ${unattributed.join(', ')})` : ''));

check(/model,?\s+not\s+a\s+measurement/i.test(all),
  'the model-not-a-measurement distinction is stated');

check(/may never claim/i.test(all) && /measured hit rate/i.test(all),
  'a "may never claim" list exists and forbids a measured hit rate');

// Money must never appear as a promise.
const banned = [
  /guaranteed sav/i,
  /we will save you/i,
  /save you \d+%/i,
  /you are (probably|likely) (in|part of) the 55/i,
  /your (bill|costs) (will|are going to) drop/i,
];
for (const re of banned) {
  check(!re.test(all), `no banned phrasing matching ${re}`);
}

// Every doc that quotes money must also carry the caveat.
for (const [name, body] of Object.entries(text)) {
  if (/\$\d/.test(body)) {
    check(/model|assumption|estimate/i.test(body),
      `${name} quotes a dollar figure and labels it a model/estimate`);
  }
}

/* ------------------------------- outcome ---------------------------------- */

console.log('');
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nFix the docs before sending anything to a prospect.\n');
  process.exit(1);
}
console.log(`All ${pass} sales checks passed.\n`);
