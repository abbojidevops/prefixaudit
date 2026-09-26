#!/usr/bin/env node
/**
 * Client audit report generator — the done-for-you engagement deliverable.
 *
 * Turns `prefix-audit --json` output into a report you can send to an
 * engineering lead and invoice against. Markdown by default, plus a
 * self-contained HTML rendering for emailing.
 *
 * Two things this deliberately gets right, because they are what separate a
 * $5,000 engagement from a free tool screenshot:
 *
 *  1. Every dollar figure is labelled a MODEL, in the body and again in the
 *     caveats. A CTO who catches you presenting an estimate as a measurement
 *     will not pay you twice.
 *  2. There is an explicit "what we could not determine" section. Stating the
 *     limits of a static analysis is what makes the rest of it credible.
 *
 * Usage:
 *   node cli/prefix-audit.mjs --dir prompts --json > audit.json
 *   node scripts/audit-report.mjs --in audit.json --client "Acme Corp" \
 *        --engineer "Jane Doe" --out report.md [--html report.html]
 */

import fs from 'node:fs';
import { audit as runAudit } from '../src/engine.mjs';

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

/**
 * Whole dollars, matching cli/prefix-audit.mjs exactly. One product should not
 * print "$0" in the CLI and "$0.00" in the client report.
 */
export function money(n) {
  if (!Number.isFinite(n)) return '$0';
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function pct(n) {
  return (Math.round((Number(n) || 0) * 1000) / 10).toFixed(0) + '%';
}

/**
 * Effort/impact triage. A report that lists fourteen findings in severity
 * order is not a plan; a plan says what to do on Monday.
 */
export function triage(finding) {
  const id = finding.id;
  if (id === 'dynamic-timestamp' || id === 'volatile-id') {
    return { effort: 'Low', impact: 'High', note: 'Move the value below the cache breakpoint, or into the user turn.' };
  }
  if (id === 'ordering') {
    return { effort: 'Low', impact: 'High', note: 'Reorder blocks so volatile content sits after the breakpoint.' };
  }
  if (id === 'no-breakpoint') {
    return { effort: 'Low', impact: 'High', note: 'Attach cache_control to the system block or the last tool definition.' };
  }
  if (id === 'below-minimum') {
    return { effort: 'Medium', impact: 'High', note: 'Grow the shared prefix above the floor, or stop paying a write premium for nothing.' };
  }
  if (id === 'mutable-memory-in-prefix' || id === 'personalisation-in-prefix') {
    return { effort: 'Medium', impact: 'High', note: 'Relocate per-request or per-user state to a trailing message.' };
  }
  if (id === 'prefix-bloat') {
    return { effort: 'Medium', impact: 'Medium', note: 'Move reference material behind a tool or retrieval step.' };
  }
  if (id === 'no-cache-metric') {
    return { effort: 'Low', impact: 'Medium', note: 'Log the provider cache-token usage fields; without them you cannot measure any of this.' };
  }
  return { effort: 'Medium', impact: 'Medium', note: 'Review and remediate.' };
}

export function buildMarkdown({ json, client, engineer, scope, date }) {
  const results = (json.results || []).slice();
  const totalWaste = results.reduce((s, r) => s + (r.monthlyWaste || 0), 0);
  const totalAnnual = results.reduce((s, r) => s + (r.annualWaste || 0), 0);
  const worst = results.reduce((a, b) => (a === null || b.score < a.score ? b : a), null);
  const avgScore = results.length
    ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
    : 0;

  // One flat list of findings across all audited prompts, for the triage plan.
  const all = [];
  for (const r of results) {
    for (const f of r.findings || []) all.push({ file: r.file, ...f });
  }
  // Group by id AND severity. The same rule can be critical in one prefix and
  // merely advisory in another — a timestamp before the cache breakpoint breaks
  // the cache, the same timestamp after it costs only its own write, and the
  // engine demotes it to `info`. Collapsing those into one row would tell a
  // client that a correctly-placed prompt has a critical defect.
  const byKey = new Map();
  for (const f of all) {
    const key = `${f.id}:${f.severity}`;
    if (!byKey.has(key)) byKey.set(key, { ...f, files: [] });
    byKey.get(key).files.push(f.file);
  }
  const unique = [...byKey.values()].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.files.length - a.files.length,
  );
  const criticals = unique.filter((f) => f.severity === 'critical');

  const L = [];
  const push = (...a) => L.push(...a);

  /* ------------------------------- cover -------------------------------- */
  push(`# Prompt Cache Audit`, ``);
  push(`| | |`, `|---|---|`);
  push(`| **Prepared for** | ${client || '—'} |`);
  push(`| **Prepared by** | ${engineer || '—'} |`);
  push(`| **Date** | ${date || new Date().toISOString().slice(0, 10)} |`);
  push(`| **Scope** | ${scope || `${results.length} prompt prefix(es)`} |`);
  push(`| **Method** | Static analysis, PrefixAudit v${json.version || '—'} |`);
  push('');

  /* --------------------------- executive summary ------------------------- */
  push(`## Executive summary`, ``);
  if (!results.length) {
    push(`No prompts were audited. Supply a path and re-run.`, ``);
    return L.join('\n');
  }

  const repairedHit = worst ? worst.fixedHitRate : 0;
  push(
    `We audited **${results.length}** prompt prefix${results.length === 1 ? '' : 'es'}. ` +
      `The mean cache-health score is **${avgScore}/100**; the weakest scores **${worst.score}/100 (${worst.grade})**.`,
    ``,
  );

  if (criticals.length) {
    push(
      `**${criticals.length} critical issue${criticals.length === 1 ? '' : 's'}** ` +
        `will prevent prompt caching from working as intended:`,
      ``,
    );
    for (const f of criticals.slice(0, 5)) {
      push(`- **${f.title}** — affects ${f.files.length} prefix${f.files.length === 1 ? '' : 'es'}`);
    }
    push('');
  } else {
    push(`No critical cache-breaking patterns were found.`, ``);
  }

  push(
    `Across the audited scope the modelled waste is **${money(totalWaste)} per month** ` +
      `(**${money(totalAnnual)} per year**), against an estimated achievable hit rate of ` +
      `**${pct(repairedHit)}** after remediation.`,
    ``,
  );
  push(
    `> **These dollar figures are a model, not a measurement.** They are derived from the request ` +
      `volume supplied (${(results[0].cost?.requestsPerMonth || 0).toLocaleString()} requests/month on the first prefix) ` +
      `and published provider list prices. They indicate the size of the opportunity; they are not an invoice line.`,
    ``,
  );

  /* -------------------------------- findings ----------------------------- */
  push(`## Findings`, ``);
  push(`| Severity | Finding | Prefixes affected |`, `|---|---|---|`);
  for (const f of unique) {
    push(`| ${SEV_LABEL[f.severity]} | ${f.title} | ${f.files.length} |`);
  }
  push('');

  push(`### Detail`, ``);
  for (const f of unique) {
    push(`#### ${SEV_LABEL[f.severity]} — ${f.title}`, ``);
    push(`**Why it costs money.** ${f.why}`, ``);
    const sample = results.find((r) => r.file === f.files[0]);
    const src = (sample?.findings || []).find((x) => x.id === f.id);
    if (src?.evidence?.length) {
      push(`**Evidence** (from \`${f.files[0]}\`):`, ``);
      for (const e of src.evidence.slice(0, 3)) {
        const where = typeof e.line === 'number' && e.line >= 1 ? `line ${e.line}` : 'whole prefix';
        push(`> \`${String(e.snippet || '').trim().slice(0, 180)}\`  `);
        push(`> — ${where}${typeof src.atPercent === 'number' ? `, at ${src.atPercent}% into the prefix` : ''}`);
        push('');
      }
    }
    push(`**Remediation.** ${f.fix}`, ``);
    if (f.files.length > 1) {
      push(`Also present in: ${f.files.slice(1, 6).map((x) => '`' + x + '`').join(', ')}${f.files.length > 6 ? ` (+${f.files.length - 6} more)` : ''}`, ``);
    }
  }

  /* ------------------------------ the money ------------------------------ */
  push(`## Cost model`, ``);
  push(`| Prefix | Score | Est. hit rate | If fixed | Modelled waste |`, `|---|---|---|---|---|`);
  for (const r of results) {
    push(
      `| \`${r.file}\` | ${r.score}/100 (${r.grade}) | ${pct(r.hitRate)} | ${pct(r.fixedHitRate)} | ${money(r.monthlyWaste)}/mo |`,
    );
  }
  push(`| **Total** | | | | **${money(totalWaste)}/mo** |`);
  push('');
  push(
    `Reads are billed at the provider's cache-read multiplier and misses re-bill the prefix at full ` +
      `base price. Writes are charged once per TTL window. Token counts are estimated at ±14% against ` +
      `real BPE tokenisation.`,
    ``,
  );

  /* --------------------------- remediation plan -------------------------- */
  push(`## Recommended remediation, in order`, ``);
  push(`Ordered by impact per unit of effort, not by severity alone.`, ``);
  const ordered = [...unique].sort((a, b) => {
    const t1 = triage(a);
    const t2 = triage(b);
    const rank = { High: 0, Medium: 1, Low: 2 };
    return rank[t1.impact] - rank[t2.impact] || rank[t1.effort] - rank[t2.effort];
  });
  push(`| # | Action | Effort | Impact |`, `|---|---|---|---|`);
  ordered.forEach((f, i) => {
    const t = triage(f);
    push(`| ${i + 1} | ${t.note} _(${f.title.toLowerCase()})_ | ${t.effort} | ${t.impact} |`);
  });
  push('');

  /* --------------------------- instrumentation --------------------------- */
  push(`## Instrument before you optimise further`, ``);
  push(
    `This audit is static analysis: it reads the prompt and the request, not your traffic. To turn ` +
      `these estimates into measurements, log the provider's cache-token fields on every response:`,
    ``,
    `- **Anthropic** — \`usage.cache_read_input_tokens\`, \`usage.cache_creation_input_tokens\``,
    `- **OpenAI** — \`usage.input_tokens_details.cached_tokens\``,
    `- **Gemini** — \`usage.total_cached_tokens\``,
    ``,
    `Hit rate is \`cache_read_input_tokens ÷ (cache_read_input_tokens + uncached input)\`. Alert on ` +
      `sustained zeros after warm-up — the first call in any session always writes and never reads, by design.`,
    ``,
  );

  /* ------------------------------- caveats ------------------------------- */
  push(`## What this audit could not determine`, ``);
  push(
    `Stated plainly, because it bounds every number above:`,
    ``,
    `1. **We saw prompts, not traffic.** Cache breakpoint placement at runtime, TTL behaviour and ` +
      `routing are not visible in a prompt file. A flagged prompt is evidence of a cache break, not ` +
      `proof of a measured low hit rate.`,
    `2. **Dollar figures are modelled**, from the request volume you supplied and public list prices. ` +
      `They are not measured spend.`,
    `3. **Token counts are estimated** at ±14% against real BPE tokenisation.`,
    `4. **A flagged prompt is not a claim that your product is broken.** Many teams cache correctly ` +
      `through harness behaviour that the prompt text does not reveal.`,
    `5. **Static analysis has false positives.** Every finding above cites the exact line so it can be ` +
      `checked in seconds. Please check them.`,
    ``,
  );

  push(`---`, ``);
  push(
    `_Generated by PrefixAudit v${json.version || '—'}. Static analysis: no API keys, no network calls. ` +
      `Rule catalogue and methodology available on request._`,
  );

  return L.join('\n');
}

/** Self-contained HTML rendering for emailing. No external assets. */
export function buildHtml(markdown, { client, date }) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = esc(markdown);
  // Minimal, predictable markdown subset — the generator only emits these.
  html = html
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.*)$/gm, '<li>$2</li>');

  // Tables: group consecutive pipe rows.
  html = html.replace(/(?:^|\n)((?:\|.*\|\n?)+)/g, (block) => {
    const rows = block.trim().split('\n').filter((r) => !/^\|[\s\-|]+\|$/.test(r));
    const cells = rows.map((r) => r.split('|').slice(1, -1).map((c) => c.trim()));
    if (!cells.length) return '';
    const head = cells.shift();
    return (
      '\n<table><thead><tr>' +
      head.map((c) => `<th>${c}</th>`).join('') +
      '</tr></thead><tbody>' +
      cells.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>\n'
    );
  });

  html = html
    .split('\n\n')
    .map((b) => (/^\s*</.test(b) ? b : `<p>${b.replace(/\n/g, '<br>')}</p>`))
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prompt Cache Audit — ${esc(client || '')}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
max-width:820px;margin:0 auto;padding:40px 24px;color:#14181d;line-height:1.65;font-size:15.5px}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 18px}
h2{font-size:21px;margin:36px 0 10px;padding-top:14px;border-top:1px solid #e3e8ee}
h3{font-size:17px;margin:24px 0 8px}h4{font-size:15px;margin:20px 0 6px;color:#3d4753}
p{margin:0 0 13px}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:0 0 16px}
th,td{padding:7px 9px;text-align:left;border-bottom:1px solid #e3e8ee;vertical-align:top}
th{background:#f6f8fa;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5a6673}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;
background:#f2f5f8;padding:1px 4px;border-radius:3px;word-break:break-word}
blockquote{margin:8px 0;padding:8px 14px;border-left:3px solid #d0d7de;color:#4a5561;background:#fafbfc}
li{margin-bottom:6px}
strong{color:#0d1117}
</style></head><body>
${html}
</body></html>
`;
}

/* --------------------------------- CLI ---------------------------------- */

export function parseArgs(argv) {
  const o = { in: null, out: null, html: null, client: '', engineer: '', scope: '', date: '' };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--in': o.in = argv[++i]; break;
      case '--out': o.out = argv[++i]; break;
      case '--html': o.html = argv[++i]; break;
      case '--client': o.client = argv[++i]; break;
      case '--engineer': o.engineer = argv[++i]; break;
      case '--scope': o.scope = argv[++i]; break;
      case '--date': o.date = argv[++i]; break;
      case '--help': o.help = true; break;
      default: if (!o.in) o.in = argv[i];
    }
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  if (o.help || !o.in) {
    process.stdout.write(
      'usage: audit-report.mjs --in <audit.json> [--out report.md] [--html report.html]\n' +
        '                        [--client "Acme Corp"] [--engineer "Name"] [--scope "…"] [--date YYYY-MM-DD]\n',
    );
    return o.help ? 0 : 2;
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(o.in, 'utf8'));
  } catch (e) {
    process.stderr.write(`audit-report.mjs: cannot read ${o.in}: ${e.message}\n`);
    return 2;
  }
  const md = buildMarkdown({ json, client: o.client, engineer: o.engineer, scope: o.scope, date: o.date });
  if (o.out) {
    fs.writeFileSync(o.out, md);
    process.stdout.write(`wrote ${o.out} (${md.length} bytes)\n`);
  } else {
    process.stdout.write(md + '\n');
  }
  if (o.html) {
    const h = buildHtml(md, { client: o.client, date: o.date });
    fs.writeFileSync(o.html, h);
    process.stdout.write(`wrote ${o.html} (${h.length} bytes)\n`);
  }
  return 0;
}

import { createRequire } from 'node:module';
createRequire(import.meta.url);
if (process.argv[1] && /audit-report\.mjs$/.test(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
