#!/usr/bin/env node
/**
 * prefix-audit — prompt cache auditor for CI.
 *
 * Fails the build when a prompt prefix stops being cacheable, before the
 * regression reaches production and shows up on the invoice three weeks later.
 *
 *   npx prefix-audit prompts/support.txt --provider anthropic --requests 5000
 *   npx prefix-audit --dir prompts/ --json
 *   npx prefix-audit --baseline .cache/prefix.sha --prompts src/prompts/*.md
 *
 * Exit codes: 0 = clean, 1 = findings at or above --fail-on, 2 = usage/IO error.
 *
 * Zero dependencies. Reads files, writes a report, exits.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { audit, auditPayload, estimateTokens, prefixStability, RULE_CATALOG, VERSION } from '../src/engine.mjs';

const HELP = `prefix-audit v${VERSION} — find the line in your prompt prefix that costs you thousands

USAGE
  prefix-audit <file...> [options]
  prefix-audit --dir <dir> [options]
  prefix-audit --list-rules
  prefix-audit --version

OPTIONS
  --provider <id>      anthropic | openai | gemini | deepseek | custom   (default: anthropic)
  --requests <n>       requests per day for the cost model               (default: 1000)
  --gap <minutes>      average minutes between requests on one prefix
  --ttl <5m|1h>        cache TTL tier                                    (default: 5m)
  --base-price <n>     override base input price, $/MTok
  --read-mult <n>      override cache-read multiplier                    (default: provider)
  --write-mult <n>     override cache-write multiplier                   (default: provider)
  --min-tokens <n>     override minimum cacheable prefix length
  --breakpoint         assert the prefix carries a cache_control marker
  --logs-cache         assert you log provider cache-token usage fields
  --fail-on <sev>      critical | high | medium                          (default: critical)
  --max-waste <n>      also fail if modelled monthly waste exceeds $n
  --baseline <file>    fail if the prefix hash changed vs. a stored baseline
  --update-baseline    write the baseline instead of comparing
  --stability          treat the inputs as N renders of one prefix and diff them
  --payload            treat input as an API request payload (.json is auto-detected)
  --json               machine-readable output
  --quiet              only the verdict line
  -v, --version        print the version and exit

EXAMPLES
  # Gate a PR: fail if the support prompt stops caching
  prefix-audit prompts/support.md --provider anthropic --requests 8000 --fail-on critical

  # Audit every prompt in a directory and emit JSON for a dashboard
  prefix-audit --dir prompts --json > audit.json

  # Prove a prefix is byte-stable across renders
  prefix-audit --stability samples/turn1.txt samples/turn2.txt samples/turn3.txt
`;

/* ----------------------------- arg parsing ----------------------------- */

function parseArgs(argv) {
  const opts = {
    files: [],
    dir: null,
    provider: 'anthropic',
    requestsPerDay: 1000,
    gapMinutes: undefined,
    ttl: '5m',
    priceOverrides: {},
    hasBreakpoint: false,
    logsCacheTokens: false,
    failOn: 'critical',
    maxWaste: Infinity,
    baseline: null,
    updateBaseline: false,
    stability: false,
    payload: false,
    json: false,
    quiet: false,
    listRules: false,
    help: false,
    version: false,
  };

  const need = (name, val) => {
    if (val === undefined) throw new Error(`--${name} needs a value`);
    return val;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '--list-rules': opts.listRules = true; break;
      case '--provider': opts.provider = need('provider', next()); break;
      case '--requests': opts.requestsPerDay = Number(need('requests', next())); break;
      case '--gap': opts.gapMinutes = Number(need('gap', next())); break;
      case '--ttl': opts.ttl = need('ttl', next()); break;
      case '--base-price': opts.priceOverrides.baseInputPerM = Number(need('base-price', next())); break;
      case '--read-mult': opts.priceOverrides.readMult = Number(need('read-mult', next())); break;
      case '--write-mult': opts.priceOverrides.writeMult = Number(need('write-mult', next())); break;
      case '--min-tokens': opts.priceOverrides.minTokens = Number(need('min-tokens', next())); break;
      case '--breakpoint': opts.hasBreakpoint = true; break;
      case '--logs-cache': opts.logsCacheTokens = true; break;
      case '--fail-on': opts.failOn = need('fail-on', next()); break;
      case '--max-waste': opts.maxWaste = Number(need('max-waste', next())); break;
      case '--baseline': opts.baseline = need('baseline', next()); break;
      case '--update-baseline': opts.updateBaseline = true; break;
      case '--stability': opts.stability = true; break;
      case '--payload': opts.payload = true; break;
      case '--dir': opts.dir = need('dir', next()); break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        opts.files.push(a);
    }
  }

  if (!Number.isFinite(opts.requestsPerDay)) throw new Error('--requests must be a number');
  if (opts.gapMinutes !== undefined && !Number.isFinite(opts.gapMinutes)) throw new Error('--gap must be a number');
  if (!['critical', 'high', 'medium'].includes(opts.failOn)) throw new Error('--fail-on must be critical|high|medium');
  if (!['5m', '1h'].includes(opts.ttl)) throw new Error('--ttl must be 5m or 1h');

  return opts;
}

/* ------------------------------ file input ----------------------------- */

function expandDir(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...expandDir(full));
    else if (/\.(md|txt|prompt|system|j2|jinja|tmpl|template|json|yaml|yml|py|ts|js)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function readInputs(opts) {
  let files = [...opts.files];
  if (opts.dir) files.push(...expandDir(opts.dir));
  files = [...new Set(files)];
  if (!files.length) throw new Error('no input files. Pass paths or use --dir.');
  return files.map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));
}

/* ------------------------------- reporting ----------------------------- */

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const ICON = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO' };

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function wrap(text, width = 70, indent = '      ') {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur += ' ' + w;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.map((l) => indent + l).join('\n');
}

function printReport(file, res, opts) {
  const line = '─'.repeat(78);
  console.log(line);
  console.log(`  ${file}`);
  console.log(`  score ${res.score}/100  grade ${res.grade}   prefix ~${res.prefixTokens.toLocaleString()} tokens   hit rate ${(res.hitRate * 100).toFixed(0)}%`);
  console.log(line);

  if (!res.findings.length) {
    console.log('  No cache-break patterns detected in this prefix.');
  }

  for (const f of res.findings) {
    console.log(`\n  [${ICON[f.severity]}] ${f.title}`);
    console.log(wrap(f.why));
    for (const e of f.evidence.slice(0, 4)) {
      const where = e.line ? `line ${e.line}: ` : '';
      console.log(`      > ${where}${e.snippet}`);
    }
    if (typeof f.atPercent === 'number') {
      const pct = f.atPercent;
      const impact = pct <= 5 ? 'nearly the whole prefix' : `${100 - pct}% of the prefix`;
      console.log(`      at ${pct}% into the prefix — invalidates ${impact} after it`);
    }
    if (f.evidence.length > 4) console.log(`      ... and ${f.evidence.length - 4} more`);
    console.log(wrap(`FIX  ${f.fix}`, 70, '      '));
  }

  console.log('');
  console.log(`  modelled cost at ${res.cost.requestsPerMonth.toLocaleString()} req/month, ${res.provider.label}:`);
  console.log(`      as-is      ${money(res.cost.total)}/mo   (reads ${money(res.cost.readCost)}, misses ${money(res.cost.missCost)}, writes ${money(res.cost.writeCost)})`);
  console.log(`      if fixed   ${money(res.repairedCost.total)}/mo   at ${(res.fixedHitRate * 100).toFixed(0)}% hit rate`);
  console.log(`      waste      ${money(res.monthlyWaste)}/mo   ${money(res.annualWaste)}/yr`);

  if (res.payload && res.payload.kind === 'request') {
    const pl = res.payload;
    console.log(`\n  payload: request JSON${pl.model ? ' · ' + pl.model : ''}${pl.toolCount ? ' · ' + pl.toolCount + ' tools' : ''}`);
    if (res.breakpoint) {
      const bp = res.breakpoint;
      console.log(`  breakpoint: at ${bp.percent}% of prefix · ${bp.tokensBefore.toLocaleString()} tokens cached, ${bp.tokensAfter.toLocaleString()} after`);
      console.log(`      ${bp.volatileBefore.length} volatile pattern(s) before it, ${bp.volatileAfter.length} after`);
      console.log(wrap(bp.verdict, 70, '      '));
    } else {
      console.log('  breakpoint: NONE — no cache_control marker on any system or tool block');
    }
    for (const w of pl.warnings || []) console.log(`      note: ${w}`);
  }

  console.log(`\n  ${res.verdict}`);
  console.log(line);
  console.log('');
  void opts;
}

function shouldFail(res, opts) {
  const threshold = SEV_RANK[opts.failOn];
  if (res.findings.some((f) => SEV_RANK[f.severity] <= threshold)) return true;
  if (Number.isFinite(opts.maxWaste) && res.monthlyWaste > opts.maxWaste) return true;
  return false;
}

/* -------------------------------- baseline ----------------------------- */

function hashOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function checkBaseline(inputs, opts) {
  const combined = inputs.map((i) => `${path.basename(i.file)}:${hashOf(i.text)}`).join('\n');
  const current = hashOf(combined);

  if (opts.updateBaseline) {
    fs.mkdirSync(path.dirname(path.resolve(opts.baseline)), { recursive: true });
    fs.writeFileSync(opts.baseline, `${current}\n`);
    return { ok: true, updated: true, current };
  }
  if (!fs.existsSync(opts.baseline)) {
    return { ok: false, missing: true, current, message: `baseline ${opts.baseline} does not exist. Run with --update-baseline to create it.` };
  }
  const stored = fs.readFileSync(opts.baseline, 'utf8').trim();
  if (stored === current) return { ok: true, current };

  const changed = inputs.filter((i) => !combined.includes(`${path.basename(i.file)}:${hashOf(i.text)}`));
  return {
    ok: false,
    current,
    stored,
    changed: changed.map((c) => c.file),
    message: 'prompt prefix changed since the recorded baseline. Every cache entry is now cold.',
  };
}

/* ---------------------------------- main ------------------------------- */

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`prefix-audit: ${err.message}\n\nRun with --help for usage.`);
    return 2;
  }

  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  if (opts.version) {
    console.log(`prefix-audit ${VERSION}`);
    return 0;
  }

  if (opts.listRules) {
    for (const r of RULE_CATALOG) console.log(`${r.severity.toUpperCase().padEnd(9)} ${r.id.padEnd(26)} ${r.title}`);
    return 0;
  }

  let inputs;
  try {
    inputs = readInputs(opts);
  } catch (err) {
    console.error(`prefix-audit: ${err.message}`);
    return 2;
  }

  /* --stability: diff N renders of the same prefix */
  if (opts.stability) {
    const samples = inputs.map((i) => i.text);
    const st = prefixStability(samples);
    if (opts.json) {
      console.log(JSON.stringify({ mode: 'stability', ...st }, null, 2));
      return st.ok ? 0 : 1;
    }
    console.log('─'.repeat(78));
    console.log(`  prefix stability across ${st.samples} rendered samples`);
    console.log('─'.repeat(78));
    if (st.ok) {
      console.log('  STABLE. Prefix is byte-identical across every sample.');
      console.log('  Hit-rate ceiling: 100%');
      return 0;
    }
    console.log('  UNSTABLE. The prefix diverges between renders, so the cache cannot hit.');
    console.log(`      first divergence at byte ${st.breakAt} (sample #${st.breakSample})`);
    console.log(`      stable prefix: ${st.stableTokens} of ${st.totalTokens} tokens (${(st.stableShare * 100).toFixed(0)}%)`);
    console.log(`      hit-rate ceiling: ${(st.hitRateCeiling * 100).toFixed(0)}%`);
    console.log(`      around the break: ...${st.breakContext.replace(/\n/g, '\\n')}...`);
    console.log('\n  FIX  Move everything after that byte into the trailing user message,');
    console.log('       so the cached prefix stops at the last stable byte.');
    console.log('─'.repeat(78));
    return 1;
  }

  /* normal audit mode */
  const results = [];
  let fail = false;
  const payload = { tool: 'prefix-audit', version: VERSION, results: [] };

  for (const { file, text } of inputs) {
    // A .json file is treated as a real API request payload: that gives us the
    // actual cache_control placement rather than relying on --breakpoint.
    const asPayload = opts.payload || /\.json$/i.test(file);
    const auditOpts = {
      providerKey: opts.provider,
      priceOverrides: opts.priceOverrides,
      requestsPerDay: opts.requestsPerDay,
      gapMinutes: opts.gapMinutes,
      ttl: opts.ttl,
      hasBreakpoint: asPayload ? undefined : opts.hasBreakpoint,
      logsCacheTokens: opts.logsCacheTokens,
    };
    const res = asPayload ? auditPayload(text, auditOpts) : audit({ ...auditOpts, systemPrompt: text });

    if (opts.baseline) {
      const b = checkBaseline([{ file, text }], opts);
      res.baseline = b;
      if (!b.ok) fail = true;
    }

    if (shouldFail(res, opts)) fail = true;

    if (opts.json) {
      payload.results.push({ file, ...res });
    } else {
      printReport(file, res, opts);
      if (opts.baseline && res.baseline && !res.baseline.ok) {
        console.log(`  BASELINE  ${res.baseline.message}\n`);
      }
      if (!opts.quiet) {
        const bad = shouldFail(res, opts);
        console.log(`  => ${bad ? 'FAIL' : 'PASS'} (threshold: --fail-on ${opts.failOn})\n`);
      }
    }
    results.push({ file, res });
  }

  if (opts.json) {
    payload.failed = fail;
    payload.totalMonthlyWaste = results.reduce((s, r) => s + r.res.monthlyWaste, 0);
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const totalWaste = results.reduce((s, r) => s + r.res.monthlyWaste, 0);
    console.log(`  ${results.length} file(s) audited. Combined modelled waste: ${money(totalWaste)}/month.`);
    console.log(`  Overall: ${fail ? 'FAIL' : 'PASS'}\n`);
  }

  return fail ? 1 : 0;
}

/* Exported so the test suite exercises the real entry point. */
export { main, parseArgs, expandDir, shouldFail, hashOf, checkBaseline, money };

/**
 * Am I the script the user actually ran?
 *
 * This must resolve symlinks. npm installs `bin` entries as a symlink in
 * node_modules/.bin/, so argv[1] is the link while import.meta.url is the real
 * file. Comparing them with path.resolve() — which does not follow symlinks —
 * makes the check fail, main() never runs, and the process exits 0 having
 * printed nothing. For a CI gate that is the worst possible failure mode: a
 * broken prompt silently "passes".
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
