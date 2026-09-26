#!/usr/bin/env node
/**
 * PrefixAudit — CI report formatter.
 *
 * Takes the CLI's `--json` output and produces three things:
 *   1. a human summary for the Actions log,
 *   2. GitHub-flavoured markdown for a pull-request comment,
 *   3. workflow annotations so a finding lands on the offending line in the
 *      PR "Files changed" tab.
 *
 * Pure and dependency-free on purpose: every branch is unit-testable without a
 * GitHub token, and the action itself never needs `npm install`.
 *
 * Usage:
 *   node action/report.mjs --in audit.json [--comment-out pr-comment.md]
 *                          [--annotate] [--fail-on critical] [--quiet]
 */

const SEV_ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪️' };
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function money(n) {
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(2);
}

function pct(n) {
  return (Math.round((Number(n) || 0) * 1000) / 10).toFixed(0) + '%';
}

/**
 * Annotations are only meaningful when the audited input IS the file, because
 * `evidence.line` counts lines of the rendered prefix. For a request payload
 * (`.json`) the prefix is reassembled from `system` blocks and `tools`, so a
 * prefix line number does not correspond to a line in the JSON file. Pointing
 * an annotation at the wrong line is worse than no annotation.
 */
function annotationsAreSafe(result) {
  return !result.payload || result.payload.kind === 'text';
}

/**
 * @param {object} json  output of `prefix-audit --json`
 * @param {object} [opts]
 * @param {string} [opts.failOn='critical']
 * @param {string} [opts.sha]        commit sha, for permalinks
 * @param {string} [opts.repo]       owner/name
 * @returns {{ text: string, markdown: string, annotations: object[], failed: boolean }}
 */
export function buildReport(json, opts = {}) {
  const failOn = opts.failOn || 'critical';
  const threshold = SEV_RANK[failOn] !== undefined ? SEV_RANK[failOn] : 0;
  const results = json.results || [];

  const annotated = [];
  for (const r of results) {
    if (!annotationsAreSafe(r)) continue;
    for (const f of r.findings || []) {
      if (SEV_RANK[f.severity] > threshold) continue;
      for (const e of f.evidence || []) {
        // `evidence.line` is 1-based (engine's lineOf() counts split('\n')),
        // and 0 means "no specific line". GitHub annotations are 1-based too,
        // so pass the value through unchanged — adding 1 here points every
        // annotation one line below the real offender.
        if (typeof e.line !== 'number' || e.line < 1) continue;
        const msg = [f.title, e.snippet && `"${e.snippet.trim()}"`, f.fix && `Fix: ${f.fix}`]
          .filter(Boolean)
          .join(' — ');
        annotated.push({
          level: f.severity === 'critical' || f.severity === 'high' ? 'error' : 'warning',
          file: r.file,
          line: e.line,
          title: `PrefixAudit: ${f.title}`,
          message: msg,
        });
      }
    }
  }

  /* ------------------------------ log text ------------------------------ */
  const lines = [];
  let blocking = 0;
  let totalWaste = 0;

  for (const r of results) {
    const blockingHere = (r.findings || []).filter((f) => SEV_RANK[f.severity] <= threshold);
    blocking += blockingHere.length;
    totalWaste += r.monthlyWaste || 0;

    lines.push(
      `${r.file}  score ${r.score}/100 (${r.grade})  hit rate ${pct(r.hitRate)}  waste ${money(r.monthlyWaste)}/mo`,
    );
    if (r.breakpoint) {
      lines.push(`  breakpoint at ${r.breakpoint.percent}% · ${r.breakpoint.verdict}`);
    }
    for (const f of r.findings || []) {
      const gate = SEV_RANK[f.severity] <= threshold ? 'FAILS GATE' : 'advisory  ';
      const at = typeof f.atPercent === 'number' ? ` · at ${f.atPercent}% into the prefix` : '';
      lines.push(`  [${gate}] ${f.severity.toUpperCase().padEnd(8)} ${f.title}${at}`);
      for (const e of (f.evidence || []).slice(0, 3)) {
        lines.push(`             line ${e.line}: ${String(e.snippet || '').trim().slice(0, 110)}`);
      }
    }
  }

  const text = lines.join('\n');
  const failed = Boolean(json.failed) || blocking > 0;

  /* ------------------------------ markdown ------------------------------ */
  const md = [];
  const clean = results.filter((r) => !(r.findings || []).some((f) => SEV_RANK[f.severity] <= threshold));
  const dirty = results.filter((r) => (r.findings || []).some((f) => SEV_RANK[f.severity] <= threshold));

  if (!failed && results.length) {
    md.push(`## ✅ PrefixAudit — prompt caching looks healthy`);
    md.push('');
    md.push(
      `${results.length} prompt${results.length === 1 ? '' : 's'} audited, no findings at or above **${failOn}**.`,
    );
    const best = results.reduce((a, b) => ((a.hitRate || 0) >= (b.hitRate || 0) ? a : b), results[0]);
    md.push('');
    md.push(
      `Estimated cache hit rate **${pct(best.hitRate)}** · median prefix **${(best.prefixTokens || 0).toLocaleString()}** tokens.`,
    );
  } else {
    md.push(`## ⚠️ PrefixAudit — ${blocking} finding${blocking === 1 ? '' : 's'} will break prompt caching`);
    md.push('');
    md.push(
      `Prompt caching is an **exact-prefix** match: the first changed byte re-bills everything after it, ` +
        `and no provider raises an error when that happens. Gate set to **${failOn}**.`,
    );
  }
  md.push('');

  const link = (file, line) =>
    opts.repo && opts.sha ? `[${line}](https://github.com/${opts.repo}/blob/${opts.sha}/${file}#L${line})` : `\`${line}\``;

  for (const r of [...dirty, ...clean]) {
    const blockingHere = (r.findings || []).filter((f) => SEV_RANK[f.severity] <= threshold);
    if (!dirty.includes(r) && !blockingHere.length && failed) continue; // keep it short on failure
    md.push(
      `### ${blockingHere.length ? '❌' : '✅'} \`${r.file}\` — score **${r.score}/100** (${r.grade})`,
    );
    md.push('');
    md.push(
      `est. hit rate **${pct(r.hitRate)}**${r.fixedHitRate ? ` → **${pct(r.fixedHitRate)}** if fixed` : ''} · ` +
        `prefix ~**${(r.prefixTokens || 0).toLocaleString()}** tokens · ` +
        `modelled waste **${money(r.monthlyWaste)}/mo** (${money(r.annualWaste)}/yr)`,
    );
    md.push('');

    if (r.breakpoint && r.payload && r.payload.kind === 'request') {
      md.push(
        `> **Cache breakpoint at ${r.breakpoint.percent}% of the prefix** — ${r.breakpoint.volatileBefore.length} ` +
          `volatile pattern(s) before it, ${r.breakpoint.volatileAfter.length} after.`,
      );
      md.push('');
    }

    const shown = (r.findings || [])
      .slice()
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    if (shown.length) {
      md.push('| | Finding | Line |');
      md.push('|---|---|---|');
      for (const f of shown) {
        const e = (f.evidence || [])[0];
        // line 0 means "no specific line" (a whole-prefix condition such as a
        // missing breakpoint or missing instrumentation). Rendering it as `0`
        // invites the reader to go look at line zero of the file.
        const hasLine = e && typeof e.line === 'number' && e.line >= 1;
        const lineCell = !hasLine
          ? 'whole prefix'
          : annotationsAreSafe(r)
            ? link(r.file, e.line)
            : `prefix line ${e.line}`;
        md.push(`| ${SEV_ICON[f.severity] || ''} ${f.severity} | ${f.title} | ${lineCell} |`);
      }
      md.push('');

      for (const f of shown.filter((x) => SEV_RANK[x.severity] <= threshold)) {
        for (const e of (f.evidence || []).slice(0, 2)) {
          if (e && e.snippet) {
            md.push(`> \`${String(e.snippet).trim().slice(0, 160)}\``);
            if (typeof f.atPercent === 'number') {
              md.push(`> — at **${f.atPercent}%** into the prefix, so everything after it re-bills fresh.`);
            }
            md.push('');
          }
        }
        if (f.fix) {
          md.push(`**Fix:** ${f.fix}`);
          md.push('');
        }
      }
    }
  }

  if (results.length > 1) {
    md.push('---');
    md.push('');
    md.push(
      `**${results.length} prompts · ${blocking} blocking finding${blocking === 1 ? '' : 's'} · ` +
        `total modelled waste ${money(totalWaste)}/mo**`,
    );
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(
    `<sub>Dollar figures are a **model** from your request volume and public list prices, not a measurement. ` +
      `Token counts are estimated (±14% vs. real BPE). ` +
      `[PrefixAudit](https://github.com/prefixaudit/prefixaudit) — static analysis, no prompt text leaves CI.</sub>`,
  );

  return { text, markdown: md.join('\n'), annotations: annotated, failed, blocking, totalWaste };
}

/* ------------------------------- CLI entry ------------------------------- */

export function parseArgs(argv) {
  const opts = { in: null, commentOut: null, annotate: false, failOn: 'critical', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--in': opts.in = argv[++i]; break;
      case '--comment-out': opts.commentOut = argv[++i]; break;
      case '--annotate': opts.annotate = true; break;
      case '--fail-on': opts.failOn = argv[++i]; break;
      case '--quiet': opts.quiet = true; break;
      case '--help': opts.help = true; break;
      default:
        if (!opts.in) opts.in = argv[i];
    }
  }
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.in) {
    process.stdout.write(
      'usage: report.mjs --in <audit.json> [--comment-out pr.md] [--annotate] [--fail-on critical] [--quiet]\n',
    );
    return opts.help ? 0 : 2;
  }

  let raw;
  try {
    raw = require('node:fs').readFileSync(opts.in, 'utf8');
  } catch (e) {
    process.stderr.write(`report.mjs: cannot read ${opts.in}: ${e.message}\n`);
    return 2;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`report.mjs: ${opts.in} is not valid JSON: ${e.message}\n`);
    return 2;
  }

  const report = buildReport(json, { failOn: opts.failOn });

  if (!opts.quiet && report.text) process.stdout.write(report.text + '\n');

  if (opts.commentOut) {
    require('node:fs').writeFileSync(opts.commentOut, report.markdown);
    if (!opts.quiet) process.stdout.write(`\nwrote ${opts.commentOut} (${report.markdown.length} bytes)\n`);
  }

  if (opts.annotate) {
    for (const a of report.annotations) {
      const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A');
      process.stdout.write(
        `::${a.level} file=${esc(a.file)},line=${a.line},title=${esc(a.title)}::${esc(a.message)}\n`,
      );
    }
  }

  return report.failed ? 1 : 0;
}

// Node ESM has no require(); use createRequire so this file stays importable.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const invokedDirectly = process.argv[1] && /report\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
