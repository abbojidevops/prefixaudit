#!/usr/bin/env node
/**
 * Generate the distribution layer: llms.txt, robots.txt, sitemap.xml,
 * per-provider pages and per-rule pages.
 *
 * Every number on these pages is COMPUTED from src/engine.mjs at build time —
 * prices, multipliers, minimums and breakeven. Nothing is retyped. If the
 * engine's provider table changes, the pages change with it, which is the only
 * way to keep twenty SEO pages honest without auditing them by hand.
 *
 * The one exception is the per-model Anthropic floor table, which the engine
 * does not model (it carries one minimum per provider). It is pinned here with
 * its source, and test/seo.test.mjs asserts the page still matches.
 *
 * Zero dependencies. Run: node scripts/gen-seo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, RULE_CATALOG, VERSION, costModel } from '../src/engine.mjs';
// Origin comes from site-config.mjs — single source of truth, env-overridable.
import { SITE } from './site-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/**
 * Anthropic minimum cacheable prefix length, per model.
 * Source: Anthropic prompt-caching documentation, verified 2026-09-22.
 * The engine models one minimum per provider; this is the real breakdown and
 * it runs backwards from price — the cheapest model has the highest floor.
 */
const ANTHROPIC_FLOORS = [
  { min: 512, models: 'Fable 5, Mythos 5 (1,024 on Amazon Bedrock)' },
  { min: 1024, models: 'Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4' },
  { min: 2048, models: 'Opus 4.7, Haiku 3.5, Haiku 3' },
  { min: 4096, models: 'Haiku 4.5, Opus 4.6, Opus 4.5' },
];

/** Reads per cached write at which caching stops being a net loss. */
function breakevenReads(writeMult, readMult) {
  return (writeMult - 1) / (1 - readMult);
}

/* ------------------------------ corpus data ------------------------------ */

const study = JSON.parse(fs.readFileSync(path.join(root, 'research', 'findings.json'), 'utf8'));
const headline = study.summary.headline;
const freq = Object.fromEntries(study.summary.rulesByFrequency.map((r) => [r.id, r]));

const corpusStats = {
  analysed: headline.analysed,
  critical: headline.withCritical,
  criticalPct: headline.withCriticalPct,
  anyFinding: headline.withAnyFinding,
  anyFindingPct: headline.withAnyFindingPct,
  belowMin: headline.belowProviderMinimum,
  belowMinPct: headline.belowProviderMinimumPct,
  medianTokens: study.summary.prefixTokens.median,
  p25Tokens: study.summary.prefixTokens.p25,
  maxTokens: study.summary.prefixTokens.max,
};

/* --------------------------------- shell --------------------------------- */

const CSS = `
:root{--ivory:#F6F1E8;--parch:#EFE7DA;--card:#FBF8F1;--ink:#211D1A;--ink2:#706860;--ink3:#9A9086;
--terra:#B86B4B;--terra2:#A05a3d;--lav:#7564A8;--gold:#C9A86A;--ok:#4E806B;--err:#B85C55;--line:#DCD2C5;
--serif:"Instrument Serif","Playfair Display","Cormorant Garamond","Iowan Old Style",Georgia,serif;
--sans:"Inter","Geist","Manrope",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
--mono:"IBM Plex Mono","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--ivory);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.7;
-webkit-font-smoothing:antialiased}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:80;opacity:.035;
background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
a{color:var(--terra);text-decoration:none}a:hover{text-decoration:underline}
::selection{background:rgba(184,107,75,.22)}
:focus-visible{outline:2px solid var(--terra);outline-offset:3px}
.wrap{max-width:760px;margin:0 auto;padding:0 22px 72px}
header{border-bottom:1px solid var(--line);background:rgba(246,241,232,.85);backdrop-filter:blur(10px);position:sticky;top:0;z-index:9}
.bar{max-width:760px;margin:0 auto;padding:0 22px;display:flex;align-items:center;
justify-content:space-between;height:60px;gap:14px}
.logo{font-weight:600;letter-spacing:-.01em;color:var(--ink);display:flex;gap:9px;align-items:center;font-size:15px}
.logo:hover{text-decoration:none}
.logo svg{width:20px;height:20px}
.bar nav a{font-size:13px;color:var(--ink2);margin-left:18px}
.bar nav a:hover{color:var(--ink)}
h1{font-family:var(--serif);font-weight:400;font-size:clamp(30px,5.4vw,46px);line-height:1.08;letter-spacing:-.015em;margin:48px 0 14px}
h2{font-family:var(--serif);font-weight:400;font-size:26px;letter-spacing:-.01em;margin:40px 0 12px}
h3{font-size:17px;margin:26px 0 8px}
p{margin:0 0 14px;color:var(--ink2)}
strong{color:var(--ink)}
ul,ol{color:var(--ink2);padding-left:22px;margin:0 0 16px}
li{margin-bottom:7px}
code{font-family:var(--mono);font-size:13.5px;background:var(--parch);border:1px solid var(--line);
padding:1px 5px;border-radius:4px;color:var(--terra2)}
pre{font-family:var(--mono);font-size:13px;background:var(--card);border:1px solid var(--line);
border-radius:10px;padding:13px;overflow:auto;color:var(--ink2);white-space:pre-wrap}
table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 18px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line)}
th{color:var(--ink3);font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-family:var(--mono);font-weight:500}
td{font-family:var(--mono);color:var(--ink2)}
.callout{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);
border-radius:10px;padding:14px 16px;margin:0 0 18px}
.callout p{margin:0}
.warn{border-left-color:var(--gold)}
.crit{border-left-color:var(--err)}
.cta{background:var(--ink);border:1px solid var(--ink);border-radius:14px;padding:22px;margin:30px 0;color:var(--ivory)}
.cta h3{margin-top:0;color:var(--ivory);font-family:var(--serif);font-weight:400;font-size:22px}
.cta p{color:#B4A99C}
.btn{display:inline-block;background:var(--terra);color:#FBF3EC;font-weight:500;padding:10px 18px;
border-radius:6px;font-size:14.5px;transition:background .2s,transform .2s}
.btn:hover{text-decoration:none;background:var(--terra2);transform:translateY(-1px)}
.sub{font-size:13px;color:var(--ink3);margin-top:10px}
footer{border-top:1px solid var(--line);margin-top:52px;padding-top:22px;font-size:13px;color:var(--ink3)}
.pill{display:inline-block;font-family:var(--mono);font-size:11px;padding:3px 9px;border-radius:4px;
border:1px solid var(--line);color:var(--ink2);margin-bottom:14px;letter-spacing:.1em;text-transform:uppercase}
.pill.critical{color:var(--err);border-color:rgba(181,92,85,.4);background:rgba(181,92,85,.06)}
.pill.high{color:#8A6D33;border-color:rgba(201,168,106,.55);background:rgba(201,168,106,.08)}
.pill.medium{color:var(--lav);border-color:rgba(117,100,168,.35);background:rgba(117,100,168,.06)}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}*,*::before,*::after{transition:none!important}}
`;

function page({ title, description, canonical, body, jsonLd }) {
  const ld = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:image" content="${SITE}/og.png">
<meta name="robots" content="index,follow,max-snippet:-1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23211D1A'/%3E%3Cpath d='M8 10h16M8 16h10M8 22h13' stroke='%23B86B4B' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E">
<style>${CSS}</style>
${ld}
</head>
<body>
<header><div class="bar">
<a class="logo" href="/">
<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#211D1A"/><path d="M8 10h16M8 16h10M8 22h13" stroke="#B86B4B" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>
PrefixAudit</a>
<nav><a href="/">Auditor</a><a href="/rules/">Rules</a><a href="/providers/">Providers</a></nav>
</div></header>
<main class="wrap">
${body}
<footer>
<p>PrefixAudit v${VERSION}. Static analysis — no API keys, no network calls, your prompt never leaves the page.</p>
<p>Dollar figures on this site are a <strong>model</strong> from request volume and public list prices, never a measurement. Token counts are estimated (±14% against real BPE).</p>
</footer>
</main>
</body>
</html>
`;
}

const written = [];
function write(rel, content) {
  const full = path.join(dist, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  written.push(rel);
}

const money = (n) => '$' + n.toFixed(2);

/* ------------------------------ provider pages --------------------------- */

const PROVIDER_META = {
  anthropic: {
    name: 'Anthropic Claude',
    slug: 'anthropic',
    h1: 'Anthropic prompt caching: minimums, pricing and the mistakes that void it',
    blurb:
      'Anthropic caching is explicit — you place <code>cache_control</code> breakpoints yourself. ' +
      'That means it is also explicitly breakable, and nothing warns you when you break it.',
    extras: () => `
<h2>Minimum cacheable prefix, per model</h2>
<p>The floor is <strong>per model, and it runs backwards from price</strong> — the cheapest model has the
highest floor. Below it, <code>cache_control</code> is silently ignored: no error, no caching, and you
still pay the 1.25× write premium.</p>
<table><thead><tr><th>Minimum</th><th>Models</th></tr></thead><tbody>
${ANTHROPIC_FLOORS.map((f) => `<tr><td>${f.min.toLocaleString()}</td><td style="font-family:var(--sans)">${f.models}</td></tr>`).join('\n')}
</tbody></table>
<div class="callout warn"><p>In a study of ${corpusStats.analysed} production system prompts,
<strong>${corpusStats.belowMin} (${corpusStats.belowMinPct}%)</strong> were below the 1,024-token floor.
The 25th percentile was <strong>${corpusStats.p25Tokens} tokens</strong>.</p></div>
`,
  },
  openai: {
    name: 'OpenAI',
    slug: 'openai',
    h1: 'OpenAI prompt caching: what actually breaks it',
    blurb:
      'OpenAI caching is <strong>automatic</strong> above the minimum — there is no marker to forget. ' +
      'That removes one failure mode and hides the rest, because a cache miss looks identical to a cold start.',
    extras: () => `
<h2>No marker to set, no error to read</h2>
<p>Because caching is automatic, the only lever you control is <strong>prefix stability</strong>. A
rendered timestamp or a per-request ID inside the first block changes the bytes and the cache never
engages — and there is no <code>cache_control</code> mistake to find, because you never wrote one.</p>
<p>OpenAI does expose miss reasons through <code>prompt_cache_diagnostics</code>:
<code>model_changed</code>, <code>prompt_cache_key_changed</code>, <code>service_tier_changed</code>,
<code>tools_changed</code>, <code>input_changed</code> and others. Log them; they are the only signal you get.</p>
`,
  },
  gemini: {
    name: 'Google Gemini',
    slug: 'gemini',
    h1: 'Gemini prompt caching: implicit vs explicit, and the storage cost',
    blurb:
      'Gemini offers both implicit and explicit caching. Explicit caches are a real product with their own ' +
      'price, so an oversized or short-lived cache can cost more than it saves.',
    extras: () => `
<h2>Explicit caches are billed for storage</h2>
<p>An explicit cache is charged per hour of storage in addition to the discounted read rate. A cache that
is written once and read twice can lose money against just paying full price — model the reuse count
before you create one.</p>
`,
  },
  deepseek: {
    name: 'DeepSeek',
    slug: 'deepseek',
    h1: 'DeepSeek prompt caching: cheap base price, same prefix rules',
    blurb:
      'DeepSeek has the lowest base input price of the providers modelled here, which changes the absolute ' +
      'dollars but not the mechanism: an unstable prefix still re-bills in full.',
    extras: () => '',
  },
};

for (const [key, p] of Object.entries(PROVIDERS)) {
  if (key === 'custom') continue;
  const meta = PROVIDER_META[key];
  if (!meta) continue;
  const be5 = breakevenReads(p.writeMult, p.readMult);

  const body = `
<span class="pill">${meta.name}</span>
<h1>${meta.h1}</h1>
<p>${meta.blurb}</p>

<h2>The numbers</h2>
<table><thead><tr><th></th><th>Value</th></tr></thead><tbody>
<tr><td>Base input price</td><td>${money(p.baseInputPerM)} / MTok</td></tr>
<tr><td>Cache read</td><td>${p.readMult}× base → ${money(p.baseInputPerM * p.readMult)} / MTok</td></tr>
<tr><td>Cache write</td><td>${p.writeMult}× base → ${money(p.baseInputPerM * p.writeMult)} / MTok</td></tr>
<tr><td>Minimum cacheable prefix</td><td>${p.minTokens.toLocaleString()} tokens</td></tr>
<tr><td>Breakeven</td><td>${be5.toFixed(2)} reads per cached write</td></tr>
</tbody></table>

${
  p.writeMult > 1
    ? `<div class="callout crit"><p><strong>Breakeven is not one read.</strong> At ${p.writeMult}× write and
${p.readMult}× read, caching only pays for itself after <strong>${be5.toFixed(2)} reads</strong> of the same
prefix. Derived as <code>(writeMult − 1) ÷ (1 − readMult)</code>. Below that, caching costs you money.</p></div>`
    : `<div class="callout"><p><strong>Cache writes are free here</strong> (${p.writeMult}× base), so there is
no write premium to recoup — a cache hit is pure saving from the first read. The failure mode on this
provider is not breakeven, it is a prefix that never stabilises, so the cache never engages at all.</p></div>`
}
${meta.extras()}
<h2>What breaks the cache</h2>
<p>Caching is an <strong>exact-prefix match</strong>. The first changed byte invalidates everything after
it, and no provider raises an error. In ${corpusStats.analysed} production system prompts:</p>
<ul>
<li><strong>${freq['dynamic-timestamp'].files} (${freq['dynamic-timestamp'].pctOfCorpus}%)</strong> rendered a date or time inside the cached prefix</li>
<li><strong>${freq['below-minimum'].files} (${freq['below-minimum'].pctOfCorpus}%)</strong> were below the minimum cacheable length</li>
<li><strong>${freq['prefix-bloat'].files} (${freq['prefix-bloat'].pctOfCorpus}%)</strong> carried a prefix far larger than it needed to be</li>
<li><strong>${freq['mutable-memory-in-prefix'].files} (${freq['mutable-memory-in-prefix'].pctOfCorpus}%)</strong> kept mutable working memory inside the prefix</li>
</ul>

<h2>The fix</h2>
<p>Order the request so the cached span is byte-identical on every call:</p>
<pre>static system instructions     ← cached
tool definitions               ← cached, breakpoint here
--- cache breakpoint ---
volatile context, dates, IDs   ← after the breakpoint
user message                   ← never cached</pre>
<p>Content after the breakpoint costs only its own write. The same content before it invalidates
everything downstream. Same bytes, different order, completely different bill.</p>

<div class="cta">
<h3>Check your own prompt</h3>
<p>Paste a system prompt or a raw API request. Get a score, the offending lines, and a modelled monthly
cost. Runs in your browser — no API keys, no account, nothing leaves the page.</p>
<a class="btn" href="/">Run the audit →</a>
<p class="sub">Or gate it in CI: <code>npx prefix-audit prompts/ --provider ${key}</code></p>
</div>
`;

  write(
    `provider-${meta.slug}.html`,
    page({
      title: `${meta.h1} | PrefixAudit`,
      description: `${meta.name} prompt caching: minimum cacheable length, read and write pricing, breakeven reads, and the prefix mistakes that silently void the cache.`,
      canonical: `${SITE}/providers/${meta.slug}`,
      body,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: meta.h1,
        description: `${meta.name} prompt caching rules, minimums and pricing.`,
        about: { '@type': 'Thing', name: 'Prompt caching' },
      },
    }),
  );
}

/* -------------------------------- rule pages ----------------------------- */

for (const r of RULE_CATALOG) {
  const f = freq[r.id];
  const body = `
<span class="pill ${r.severity}">${r.severity}</span>
<h1>${r.title}</h1>
<p class="sub" style="margin-bottom:22px">PrefixAudit rule <code>${r.id}</code> · v${VERSION}</p>

<h2>Why it breaks your cache</h2>
<p>${r.why}</p>

<h2>How to fix it</h2>
<div class="callout"><p>${r.fix}</p></div>

<h2>How common is it?</h2>
${
  f
    ? `<p>Detected in <strong>${f.files} of ${corpusStats.analysed}</strong> production system prompts
(<strong>${f.pctOfCorpus}%</strong>) across 16 vendors.</p>`
    : `<p>This rule needs request or runtime context that an extracted prompt cannot supply, so it is
excluded from the corpus study. It still runs in the auditor when you supply that context.</p>`
}

<h2>Estimated impact</h2>
<p>Modelled as invalidating <strong>${Math.round((r.wastedPrefixShare || 0) * 100)}%</strong> of the cached
prefix${r.positionSensitive ? ', reweighted by how early in the prefix the offending byte appears — the same pattern at the top of the prefix is far more expensive than at the bottom' : ''}.</p>

<div class="cta">
<h3>Is your prompt affected?</h3>
<p>Paste it and find out. Static analysis, in-browser, nothing leaves the page.</p>
<a class="btn" href="/">Run the audit →</a>
</div>

<p class="sub"><a href="/rules/">← All ${RULE_CATALOG.length} rules</a></p>
`;

  write(
    `rule-${r.id}.html`,
    page({
      title: `${r.title} | PrefixAudit`,
      description: `${r.title}. Why it breaks prompt caching, how to fix it, and how common it is across ${corpusStats.analysed} production system prompts.`,
      canonical: `${SITE}/rules/${r.id}`,
      body,
    }),
  );
}

/* ------------------------------- index pages ----------------------------- */

write(
  'rules.html',
  page({
    title: `All ${RULE_CATALOG.length} prompt-cache rules | PrefixAudit`,
    description: `The ${RULE_CATALOG.length} static-analysis rules PrefixAudit uses to find prompt-cache breakers, with corpus frequency across ${corpusStats.analysed} production system prompts.`,
    canonical: `${SITE}/rules/`,
    body: `
<h1>The ${RULE_CATALOG.length} rules</h1>
<p>Each rule is deterministic static analysis over the prompt text and the request payload. No model calls,
no heuristics that change between runs.</p>
<table><thead><tr><th>Severity</th><th>Rule</th><th>In corpus</th></tr></thead><tbody>
${RULE_CATALOG.slice()
  .sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return rank[a.severity] - rank[b.severity];
  })
  .map((r) => {
    const f = freq[r.id];
    return `<tr><td style="font-family:var(--sans)"><span class="pill ${r.severity}" style="margin:0">${r.severity}</span></td>
<td style="font-family:var(--sans)"><a href="/rules/${r.id}">${r.title}</a></td>
<td>${f ? `${f.files} · ${f.pctOfCorpus}%` : '—'}</td></tr>`;
  })
  .join('\n')}
</tbody></table>
<p class="sub">Corpus: ${corpusStats.analysed} system prompts, 16 vendors, drawn from a CC0 public-domain
archive. ${study.summary.corpusFilter.excluded} non-prompt files were excluded before counting.</p>
`,
  }),
);

write(
  'providers.html',
  page({
    title: 'Prompt caching rules by provider | PrefixAudit',
    description: 'Minimum cacheable prefix length, read and write pricing, and breakeven reads for Anthropic, OpenAI, Gemini and DeepSeek.',
    canonical: `${SITE}/providers/`,
    body: `
<h1>Prompt caching by provider</h1>
<p>The mechanism is the same everywhere — an exact-prefix match, cached reads at a fraction of base price.
The minimums, the pricing and the failure modes are not.</p>
<table><thead><tr><th>Provider</th><th>Min tokens</th><th>Read</th><th>Write</th><th>Base $/MTok</th></tr></thead><tbody>
${Object.entries(PROVIDERS)
  .filter(([k]) => k !== 'custom')
  .map(
    ([k, p]) =>
      `<tr><td style="font-family:var(--sans)"><a href="/providers/${k}">${PROVIDER_META[k]?.name || k}</a></td>
<td>${p.minTokens.toLocaleString()}</td><td>${p.readMult}×</td><td>${p.writeMult}×</td><td>${money(p.baseInputPerM)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>
<div class="callout warn"><p>The minimum is often <strong>per model</strong>, not per provider. On Anthropic
it ranges from 512 to 4,096 tokens and runs backwards from price — see the
<a href="/providers/anthropic">Anthropic page</a> for the full table.</p></div>
`,
  }),
);

/* ------------------------------ llms / robots ---------------------------- */

write(
  'llms.txt',
  `# PrefixAudit

> Free prompt-cache auditor. Paste a system prompt or a raw API request and find the line that is
> silently re-billing your cached prefix at full price, with a modelled monthly dollar cost.
> Static analysis only: no API keys, no network calls, the prompt never leaves the page.

Prompt caching bills cached input at ${PROVIDERS.anthropic.readMult}× base price on Anthropic and OpenAI.
It is an exact-prefix match, and no provider raises an error when you break it.

## Key facts

- Minimum cacheable prefix is per model on Anthropic: 512 / 1,024 / 2,048 / 4,096 tokens.
  The cheapest model has the highest floor (Haiku 4.5 = 4,096).
- Below the minimum, cache_control is silently ignored and you still pay a ${PROVIDERS.anthropic.writeMult}× write premium.
- Breakeven on the 5-minute TTL tier is ${breakevenReads(PROVIDERS.anthropic.writeMult, PROVIDERS.anthropic.readMult).toFixed(2)} reads per cached write.
- Corpus study of ${corpusStats.analysed} production system prompts, 16 vendors:
  ${corpusStats.anyFindingPct}% contain a cache-breaking pattern, ${corpusStats.criticalPct}% a critical one,
  ${corpusStats.belowMinPct}% are below the cache minimum.
- Median prefix size ${corpusStats.medianTokens.toLocaleString()} estimated tokens; p25 is ${corpusStats.p25Tokens.toLocaleString()}.

## Usage

    npx prefix-audit prompts/ --provider anthropic --requests 8000 --fail-on critical

Exit 0 when clean, 1 on findings at or above the threshold, 2 on usage or IO error.
A GitHub Action wraps the same CLI for CI gating with PR comments and baseline drift detection.

## Pages

- / — the auditor (single self-contained HTML file)
- /rules/ — all ${RULE_CATALOG.length} detection rules
- /providers/ — caching minimums and pricing by provider

## Caveats

Dollar figures are a model from request volume and public list prices, never a measurement.
Token counts are estimated at ±14% against real BPE. A flagged prompt is evidence of a cache break,
not proof of a measured low hit rate — the corpus contains prompts, not requests, so breakpoint
placement is not visible.
`,
);

write(
  'robots.txt',
  `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml

# PrefixAudit runs entirely client-side. There are no API endpoints to crawl.
`,
);

/* ------------------------- legal (not in sitemap) ------------------------ */

write(
  'privacy.html',
  page({
    title: 'Privacy — PrefixAudit',
    description: 'PrefixAudit collects nothing. The audit runs entirely in your browser.',
    canonical: `${SITE}/privacy.html`,
    body: `
<h1>Privacy</h1>
<p>PrefixAudit is a single static HTML file containing a zero-dependency analysis engine.
When you paste a prompt or open a file, the analysis runs entirely in your browser tab.
<strong>No prompt, request payload or file is transmitted, stored or logged</strong> — there is no
server-side component to receive it. This is structural, not a policy promise.</p>
<h2>What this site stores</h2>
<p>Nothing. The site sets no cookies, uses no localStorage, no sessionStorage, no IndexedDB,
no analytics, no trackers and no third-party fonts or scripts. The only network requests your
browser makes are for the static files of this site itself.</p>
<h2>What you share voluntarily</h2>
<p>If you email us, we receive what you send. If you install the CLI or GitHub Action, your
prompts are processed on your own machine or your own CI runner — never on our infrastructure.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:abbojinikhil2157@gmail.com">abbojinikhil2157@gmail.com</a>.</p>
`,
  }),
);

write(
  'terms.html',
  page({
    title: 'Terms — PrefixAudit',
    description: 'Terms of use for the PrefixAudit auditor, CLI and GitHub Action.',
    canonical: `${SITE}/terms.html`,
    body: `
<h1>Terms of use</h1>
<p>PrefixAudit (the web auditor, CLI and GitHub Action) is provided free of charge,
as-is and as-available, under the MIT license. You use it at your own risk.</p>
<h2>Models, not measurements</h2>
<p>Dollar figures produced by the tool are a <strong>cost model</strong> computed from your stated
request volume and public provider list prices. They are estimates for decision support, not a
measurement of your actual bill and not financial advice. Token counts are heuristic estimates
(±15% against real BPE tokenizers). Always verify against your own invoice and provider
documentation before acting.</p>
<h2>Accuracy</h2>
<p>Provider cache minimums, multipliers and rules are transcribed from public documentation and
can change. The tool states its sources; where they conflict with your provider's current
documentation, the provider wins.</p>
<h2>Liability</h2>
<p>To the maximum extent permitted by law, we are not liable for any loss arising from use of the
tool, including decisions made on the basis of its output.</p>
`,
  }),
);

/**
 * The single list of canonical paths. The sitemap and the hosting rewrites are
 * both derived from this, so a new page cannot end up in one and not the other.
 * `file` is the real path on disk; `url` is the extension-less canonical URL we
 * advertise.
 */
const PAGES = [
  { url: '/', file: 'index.html', priority: '1.0' },
  { url: '/rules/', file: 'rules.html', priority: '0.8' },
  { url: '/providers/', file: 'providers.html', priority: '0.8' },
  ...Object.values(PROVIDER_META).map((m) => ({
    url: `/providers/${m.slug}`,
    file: `provider-${m.slug}.html`,
    priority: '0.7',
  })),
  ...RULE_CATALOG.map((r) => ({
    url: `/rules/${r.id}`,
    file: `rule-${r.id}.html`,
    priority: '0.6',
  })),
];

const urls = PAGES.map((p) => ({ loc: `${SITE}${p.url}`, priority: p.priority }));

write(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>monthly</changefreq>
    <priority>${u.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`,
);

/* -------------------------------- redirects ------------------------------ */

/**
 * Static hosts do not resolve /rules/dynamic-timestamp to
 * rules/dynamic-timestamp.html. The canonical URLs in the sitemap are
 * extension-less, so without rewrites every one of them 404s in production
 * while working locally.
 *
 * Generated per page rather than with a splat: a splat like
 * `/rules/* /rules/:splat.html 200` also rewrites /rules/index.html into
 * /rules/index.html.html and breaks it. Explicit entries cannot over-match.
 *
 * Cloudflare Pages and Netlify share this syntax.
 */
const redirects = [
  '# Generated by scripts/gen-seo.mjs — do not edit by hand.',
  '# Maps the extension-less canonical URLs in sitemap.xml onto real files.',
  '#',
  '# Status 200 = rewrite (the URL stays clean in the browser), not 301.',
  '# Files are stored FLAT with globally-unique names so any upload method',
  '# (drag loose files, folders, zip, git) cannot lose the structure.',
  '#',
  '# Only LEAF urls get rewrites: their flat file (/rule-x.html) is served by',
  '# the host at a DIFFERENT alias (/rule-x), so the clean url needs a rewrite.',
  '# Directory urls (/rules/, /providers/, /) are served natively — the host',
  '# maps rules.html -> /rules itself. Rewriting them too causes a 308 loop',
  '# (rewrite to X.html, host 308s X.html back to X). Verified live 2026-09-23.',
  '',
  ...PAGES.filter((p) => !p.url.endsWith('/')).map((p) => `${p.url}  /${p.file}  200`),
  '',
  '# Anything unmatched should land on the auditor rather than a bare 404.',
  '/*  /index.html  404',
  '',
].join('\n');

write('_redirects', redirects);

/* --------------------------------- report -------------------------------- */

console.log(`generated ${written.length} files in dist/`);
for (const f of written.sort()) console.log(`  ${f}`);
