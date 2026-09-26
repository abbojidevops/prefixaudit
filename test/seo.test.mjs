/**
 * SEO / distribution layer.
 *
 * These pages are generated from src/engine.mjs. The tests exist so that a
 * change to the provider table, the rule catalogue or the corpus study breaks
 * the build instead of leaving twenty pages quietly stating old numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PROVIDERS, RULE_CATALOG } from '../src/engine.mjs';
import '../scripts/ensure-dist.mjs'; // builds dist/ if this session lost it
import { SITE, FREE_ORIGIN } from '../scripts/site-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const read = (rel) => fs.readFileSync(path.join(dist, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(dist, rel));

const study = JSON.parse(fs.readFileSync(path.join(root, 'research', 'findings.json'), 'utf8'));
const headline = study.summary.headline;
const freq = Object.fromEntries(study.summary.rulesByFrequency.map((r) => [r.id, r]));

const money = (n) => '$' + n.toFixed(2);
const breakevenReads = (w, r) => (w - 1) / (1 - r);
// Escape an origin for use inside a RegExp literal built at runtime.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* -------------------------------- presence ------------------------------- */

test('all distribution files are generated', () => {
  const required = [
    'llms.txt',
    'robots.txt',
    'sitemap.xml',
    'rules.html',
    'providers.html',
    ...['anthropic', 'openai', 'gemini', 'deepseek'].map((s) => `provider-${s}.html`),
    ...RULE_CATALOG.map((r) => `rule-${r.id}.html`),
  ];
  const missing = required.filter((f) => !exists(f));
  assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`);
});

/* --------------------------- provider page accuracy ---------------------- */

test('every provider page states the engine prices and minimum exactly', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (key === 'custom') continue;
    const html = read(`provider-${key}.html`);
    assert.ok(html.includes(money(p.baseInputPerM)), `${key}: base price`);
    assert.ok(html.includes(`${money(p.baseInputPerM * p.readMult)} / MTok`), `${key}: read price`);
    assert.ok(html.includes(`${p.readMult}×`), `${key}: read multiplier`);
    assert.ok(html.includes(`${p.writeMult}×`), `${key}: write multiplier`);
    assert.ok(html.includes(p.minTokens.toLocaleString()), `${key}: minimum`);
  }
});

test('breakeven on each page matches the formula computed from the engine', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (key === 'custom') continue;
    const html = read(`provider-${key}.html`);
    if (p.writeMult > 1) {
      const expected = breakevenReads(p.writeMult, p.readMult).toFixed(2);
      assert.ok(
        html.includes(`${expected} reads per cached write`),
        `${key}: expected breakeven ${expected}`,
      );
    } else {
      // Free writes: no premium to recoup. The page must NOT claim a nonzero
      // breakeven, which would be both wrong and nonsense to read.
      assert.ok(!/pays for itself after <strong>0\.00/.test(html), `${key}: nonsense breakeven`);
      assert.ok(html.includes('Cache writes are free here'), `${key}: should explain free writes`);
    }
  }
});

test('Anthropic page carries the full per-model floor table', () => {
  const html = read('provider-anthropic.html');
  for (const min of [512, 1024, 2048, 4096]) {
    assert.ok(html.includes(min.toLocaleString()), `missing ${min}-token floor`);
  }
  assert.ok(html.includes('Haiku 4.5'), 'must name the model with the highest floor');
  assert.ok(html.includes('backwards from price'), 'must explain the counterintuitive ordering');
});

test('no provider page contains a price the engine does not have', () => {
  // Guard against a stale hardcoded number surviving a price change.
  const known = new Set();
  for (const p of Object.values(PROVIDERS)) {
    known.add(money(p.baseInputPerM));
    known.add(money(p.baseInputPerM * p.readMult));
    known.add(money(p.baseInputPerM * p.writeMult));
  }
  for (const key of Object.keys(PROVIDERS)) {
    if (key === 'custom') continue;
    const html = read(`provider-${key}.html`);
    const prices = [...html.matchAll(/\$(\d+\.\d{2}) \/ MTok/g)].map((m) => `$${m[1]}`);
    for (const price of prices) {
      assert.ok(known.has(price), `${key}: unexplained price ${price}`);
    }
  }
});

/* ------------------------------ corpus figures --------------------------- */

test('provider pages quote the corpus study, not retyped numbers', () => {
  const html = read('provider-anthropic.html');
  assert.ok(html.includes(`${headline.belowProviderMinimum} (${headline.belowProviderMinimumPct}%)`));
  assert.ok(html.includes(headline.analysed.toString()));
  assert.ok(html.includes(study.summary.prefixTokens.p25.toLocaleString()));
});

test('rule pages state their own corpus frequency', () => {
  for (const r of RULE_CATALOG) {
    const html = read(`rule-${r.id}.html`);
    const f = freq[r.id];
    if (f) {
      assert.ok(
        html.includes(`${f.files} of ${headline.analysed}`),
        `${r.id}: expected ${f.files} of ${headline.analysed}`,
      );
      assert.ok(html.includes(`${f.pctOfCorpus}%`), `${r.id}: missing percentage`);
    } else {
      assert.ok(
        html.includes('excluded from the corpus study'),
        `${r.id}: out-of-scope rule must say so rather than imply zero`,
      );
    }
  }
});

test('rule pages carry the rule why and fix verbatim from the catalogue', () => {
  for (const r of RULE_CATALOG) {
    const html = read(`rule-${r.id}.html`);
    assert.ok(html.includes(r.why.slice(0, 60)), `${r.id}: why text drifted`);
    assert.ok(html.includes(r.fix.slice(0, 60)), `${r.id}: fix text drifted`);
    assert.ok(html.includes(r.severity), `${r.id}: severity missing`);
  }
});

/* --------------------------------- indexes ------------------------------- */

test('the rules index lists every rule with a link', () => {
  const html = read('rules.html');
  for (const r of RULE_CATALOG) {
    assert.ok(html.includes(`/rules/${r.id}`), `${r.id} not linked`);
    assert.ok(html.includes(r.title), `${r.id} title missing`);
  }
  assert.ok(html.includes(`The ${RULE_CATALOG.length} rules`));
});

test('the providers index lists every non-custom provider', () => {
  const html = read('providers.html');
  for (const key of Object.keys(PROVIDERS)) {
    if (key === 'custom') continue;
    assert.ok(html.includes(`/providers/${key}`), `${key} not linked`);
  }
  assert.ok(!html.includes('/providers/custom'), 'custom is not a real provider page');
});

/* ----------------------------- sitemap / llms ---------------------------- */

test('every sitemap URL resolves to a generated file', () => {
  const xml = read('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 20, `expected 20+ URLs, got ${locs.length}`);
  const redirects = parseRedirects();
  // Directory urls are served natively (rules.html -> /rules); only leaf urls
  // carry a rewrite, because their flat file alias differs from the clean url.
  const native = { '/': 'index.html', '/rules/': 'rules.html', '/providers/': 'providers.html' };
  for (const loc of locs) {
    const rel = loc.replace(SITE, '') || '/';
    if (native[rel]) {
      assert.ok(exists(native[rel]), `${rel} must be served natively from ${native[rel]}`);
      continue;
    }
    const hit = redirects.find((r) => r.from === rel);
    assert.ok(hit, `sitemap URL ${rel} has no rewrite in _redirects`);
    const target = hit.to.replace(/^\//, '');
    assert.ok(exists(target), `sitemap points at ${loc} but ${target} does not exist`);
  }
});

test('robots.txt points at the sitemap', () => {
  const txt = read('robots.txt');
  assert.match(txt, new RegExp(`Sitemap: ${escRe(SITE)}/sitemap\\.xml`));
  assert.match(txt, /User-agent: \*/);
});

test('llms.txt carries the engine numbers and the caveats', () => {
  const txt = read('llms.txt');
  assert.ok(txt.includes(`${PROVIDERS.anthropic.readMult}× base price`));
  assert.ok(txt.includes(`${PROVIDERS.anthropic.writeMult}× write premium`));
  assert.ok(txt.includes(breakevenReads(PROVIDERS.anthropic.writeMult, PROVIDERS.anthropic.readMult).toFixed(2)));
  // The study's headline keys are withCriticalPct / belowProviderMinimumPct.
  assert.ok(txt.includes(`${headline.withCriticalPct}%`), 'critical share missing from llms.txt');
  assert.ok(txt.includes(`${headline.withAnyFindingPct}%`), 'any-finding share missing from llms.txt');
  assert.ok(txt.includes(`${headline.belowProviderMinimumPct}%`), 'below-minimum share missing');
  // An LLM reading this must not be able to mistake a model for a measurement.
  assert.match(txt, /never a measurement/i);
  assert.match(txt, /±14%/);
});

/* ------------------------------- integrity ------------------------------- */

test('generated pages are self-contained (no external CSS/JS/fonts)', () => {
  const files = [
    'rules.html',
    'providers.html',
    'provider-anthropic.html',
    ...RULE_CATALOG.slice(0, 3).map((r) => `rule-${r.id}.html`),
  ];
  for (const f of files) {
    const html = read(f);
    assert.ok(!/<link[^>]+rel="stylesheet"[^>]+href="http/.test(html), `${f}: external stylesheet`);
    assert.ok(!/<script[^>]+src="http/.test(html), `${f}: external script`);
    assert.ok(html.includes('<style>'), `${f}: styles must be inlined`);
  }
});

test('generated pages carry a canonical and a description', () => {
  for (const f of ['rules.html', 'providers.html', 'provider-anthropic.html']) {
    const html = read(f);
    assert.match(html, new RegExp(`<link rel="canonical" href="${escRe(SITE)}/[^"]*">`), f);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, f);
  }
});

test('regenerating is deterministic (no timestamps baked in)', () => {
  // A build that changes bytes every run makes deploys noisy and cache-hostile.
  const before = read('llms.txt');

  execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-seo.mjs')], { cwd: root });
  assert.equal(read('llms.txt'), before, 'llms.txt is not reproducible');
});

/* ------------------------------- _redirects ------------------------------
 * The sitemap advertises extension-less URLs. A static host will not resolve
 * /rules/dynamic-timestamp to rules/dynamic-timestamp.html, so without these
 * rewrites every canonical URL 404s in production while working locally.
 */

function parseRedirects() {
  return read('_redirects')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [from, to, status] = l.split(/\s+/);
      return { from, to, status };
    });
}

test('_redirects exists and is generated', () => {
  assert.ok(exists('_redirects'));
  assert.match(read('_redirects'), /Generated by scripts\/gen-seo\.mjs/);
});

test('every extension-less sitemap URL has a rewrite', () => {
  const xml = read('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const redirects = parseRedirects();
  // Leaf urls need a rewrite; directory urls are served natively and must NOT
  // be rewritten (a rewrite to rules.html 308-loops back to /rules).
  const missing = locs
    .map((l) => l.replace(SITE, ''))
    .filter((u) => u && !u.endsWith('/'))
    .filter((u) => !redirects.some((r) => r.from === u));
  assert.deepEqual(missing, [], `no rewrite for: ${missing.join(', ')}`);
});

test('every rewrite target is a real file in dist', () => {
  for (const r of parseRedirects()) {
    if (r.from === '/*') continue; // catch-all
    const target = r.to.replace(/^\//, '');
    assert.ok(exists(target), `rewrite ${r.from} -> ${r.to} but ${target} does not exist`);
  }
});

test('page rewrites are 200 (keep the clean URL), not 301', () => {
  for (const r of parseRedirects()) {
    if (r.from === '/*') continue; // the catch-all is deliberately a 404
    assert.equal(r.status, '200', `${r.from} should be a 200 rewrite, got ${r.status}`);
  }
});

test('no rewrite points at another rewrite (no chains)', () => {
  const redirects = parseRedirects();
  const sources = new Set(redirects.map((r) => r.from));
  for (const r of redirects) {
    if (r.from === '/*') continue;
    assert.ok(!sources.has(r.to), `${r.from} -> ${r.to} which is itself rewritten`);
  }
});

test('no splat over-match and no double-suffixed targets', () => {
  // The historical bug: `/rules/* /rules/:splat.html 200` rewrote
  // /rules/index.html into /rules/index.html.html. Now files are flat and
  // unique, and directory URLs get explicit rewrites, so the guards are:
  // only the catch-all may use `*`, and no target may be malformed.
  const redirects = parseRedirects();
  for (const r of redirects) {
    assert.ok(!r.from.includes('*') || r.from === '/*', `splat ${r.from} would over-match`);
    assert.ok(!/\.html\.html$/.test(r.to), `malformed target ${r.to}`);
    assert.ok(r.status === '200' || (r.from === '/*' && r.status === '404'),
      `unexpected status for ${r.from}: ${r.status}`);
    // A rewrite on a directory url 308-loops (rewrite to X.html, host 308s it
    // back to X). Verified live on Cloudflare 2026-09-23.
    assert.ok(!r.from.endsWith('/') || r.from === '/', `directory ${r.from} must not be rewritten`);
  }
});


test('there is a catch-all so unknown paths hit the auditor, not a bare 404', () => {
  const redirects = parseRedirects();
  const catchAll = redirects.find((r) => r.from === '/*');
  assert.ok(catchAll, 'no catch-all rule');
  assert.equal(catchAll.status, '404');
  assert.equal(catchAll.to, '/index.html');
});

test('_redirects is reproducible', () => {
  const before = read('_redirects');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-seo.mjs')], { cwd: root });
  assert.equal(read('_redirects'), before);
});

// ---------------------------------------------------------------------------
// Origin consistency
//
// Every absolute URL in the distribution must come from the same origin, or
// search engines see a site that disagrees with itself: canonicals pointing
// one way, the sitemap another. These tests read what was actually built.
// ---------------------------------------------------------------------------

function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}

/** Every generated file under dist/, relative paths. */
function allDistFiles(dir = dist) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allDistFiles(abs));
    else out.push(path.relative(dist, abs).split(path.sep).join('/'));
  }
  return out;
}

test('every absolute URL in dist uses exactly one origin', () => {
  const seen = new Map();
  for (const f of allDistFiles()) {
    const body = read(f);
    for (const m of body.matchAll(/https:\/\/[a-z0-9.\-]+/gi)) {
      const o = originOf(m[0]);
      if (!o) continue;
      seen.set(o, (seen.get(o) || 0) + 1);
    }
  }
  // schema.org is the JSON-LD vocabulary every page must cite; it is not
  // our origin, so it is allowed. github.com and www.npmjs.com appear only
  // as project-presence links (repo + package) in nav/footer — outbound
  // hrefs, not self-referential URLs, so they cannot make the site disagree
  // with itself. Nothing else may appear.
  const ALLOWED_EXTERNAL = ['https://schema.org', 'https://github.com', 'https://www.npmjs.com'];
  const ours = new URL(SITE).origin;
  const unexpected = [...seen.keys()].filter((o) => o !== ours && !ALLOWED_EXTERNAL.includes(o));
  assert.deepEqual(unexpected, [],
    `dist cites unexpected origins: ${unexpected.join(', ')} ` +
    `(all: ${[...seen.entries()].map(([k, v]) => `${k}(${v})`).join(', ')})`);
  assert.ok(seen.has(ours), `no URL in dist uses the configured origin ${ours}`);
  assert.ok(seen.get(ours) > 40, `suspiciously few site URLs (${seen.get(ours)})`);
});

test('index.html canonical, og:url and JSON-LD agree with the configured origin', () => {
  const html = read('index.html');
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const jsonldUrl = JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]
  ).url;

  assert.equal(canonical, `${SITE}/`, 'canonical must be the site root on the configured origin');
  assert.equal(jsonldUrl, `${SITE}/`, 'JSON-LD url must match the canonical');
  assert.ok(!html.includes('__SITE__'), 'an unfilled __SITE__ marker reached dist');
});

test('robots.txt points the sitemap at the configured origin', () => {
  const sitemapLine = read('robots.txt')
    .split('\n').find((l) => l.startsWith('Sitemap:'));
  assert.equal(sitemapLine.trim(), `Sitemap: ${SITE}/sitemap.xml`);
});

test('the default origin is the free subdomain, so a build works at zero cost', () => {
  // Guards the ₹0 promise: the default must not require buying a domain.
  const url = new URL(FREE_ORIGIN);
  assert.equal(url.hostname.endsWith('.pages.dev'), true,
    `FREE_ORIGIN must be a free *.pages.dev subdomain, got ${FREE_ORIGIN}`);
});

// ---------------------------------------------------------------------------
// The env override — verified by actually building with it in a child process.
// A constant that cannot be overridden is a constant that will be forked.
// ---------------------------------------------------------------------------

function runNode(args, env) {
  return execFileSync(process.execPath, args, {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const CONFIG_PROBE = ['--input-type=module', '--eval',
  "import {SITE} from './scripts/site-config.mjs'; process.stdout.write(SITE);"];

test('PREFIXAUDIT_SITE overrides the origin for sitemap, robots and index', () => {
  const custom = 'https://example.com';
  const before = read('sitemap.xml');

  const got = runNode(CONFIG_PROBE, { PREFIXAUDIT_SITE: custom });
  assert.equal(got, custom, 'site-config must honour PREFIXAUDIT_SITE');

  try {
    runNode(['scripts/build.mjs'], { PREFIXAUDIT_SITE: custom });
    const sitemap = read('sitemap.xml');
    const html = read('index.html');
    const robots = read('robots.txt');

    assert.ok(sitemap.includes(`<loc>${custom}/</loc>`), 'sitemap must use the override');
    assert.ok(!sitemap.includes('pages.dev'), 'no free-subdomain URL may survive an override');
    assert.ok(html.includes(`<link rel="canonical" href="${custom}/">`), 'canonical must use the override');
    assert.ok(robots.includes(`Sitemap: ${custom}/sitemap.xml`), 'robots must use the override');
  } finally {
    // Restore the default build so later tests see the real artefact.
    runNode(['scripts/build.mjs'], {});
    assert.equal(read('sitemap.xml'), before, 'default build must be byte-identical after restore');
  }
});

test('site-config rejects a malformed origin instead of emitting a broken canonical', () => {
  for (const bad of ['prefixaudit.dev', 'ftp://x.dev', 'https://user:pw@x.dev']) {
    assert.throws(
      () => runNode(CONFIG_PROBE, { PREFIXAUDIT_SITE: bad }),
      /not a valid absolute URL|must start with https|must not contain credentials/,
      `expected "${bad}" to be rejected`
    );
  }
});

test('a trailing slash in PREFIXAUDIT_SITE does not double up in URLs', () => {
  const got = runNode(CONFIG_PROBE, { PREFIXAUDIT_SITE: 'https://example.com/' });
  assert.equal(got, 'https://example.com', 'origin must be normalised');
});
