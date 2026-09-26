# PrefixAudit

**Find the line in your prompt prefix that's costing you thousands.**

Prompt caching bills cached input at **0.1× base price** — a 90% discount with no change to
model output. It works by *exact-prefix match*: the first changed byte kills the cache for
everything after it, and **no provider raises an error when that happens.**

So a single rendered timestamp in your system prompt can silently turn a 90% discount into a
0% one. You keep paying full input price while your dashboard says caching is enabled.

Paste your prompt. Get the offending lines and a dollar figure.

---

## Try it

```bash
cd prefixaudit
npm run build                       # -> dist/index.html (single 102KB file)
open dist/index.html                # or serve dist/ on any static host
```

Or audit from the command line:

```bash
node cli/prefix-audit.mjs examples/broken-support-prompt.md --requests 8000
```

```
──────────────────────────────────────────────────────────────────────────────
  examples/broken-support-prompt.md
  score 0/100  grade F   prefix ~1,812 tokens   hit rate 0%
──────────────────────────────────────────────────────────────────────────────

  [CRITICAL] A timestamp is inside the cached prefix
      Cache hits need a byte-exact prefix match. A rendered date or time
      makes every request unique, so the cache writes full price and reads
      never. The single most common cause of a 0% hit rate.
      > line 3: Current date and time: 2026-09-22T14:03:11Z
      FIX Delete the timestamp from the system prompt, or move it to the END
      of the final user message where it cannot invalidate the prefix. If
      the model needs "today", inject it as a trailing user turn.

  [CRITICAL] Per-request identifiers are inside the cached prefix
      Request IDs, session IDs, trace IDs and UUIDs change on every call.
      Anything before them stops matching, so the whole prefix re-bills
      fresh.
      > line 4: request_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f
      ...

  modelled cost at 240,000 req/month, Anthropic Claude:
      as-is      $1,363/mo   (reads $0, misses $1,305, writes $59)
      if fixed   $330/mo   at 88% hit rate
      waste      $1,033/mo   $12,399/yr

  Fixable. You are re-billing a cached prefix at full input price, roughly $1,033/month.
──────────────────────────────────────────────────────────────────────────────
  => FAIL (threshold: --fail-on critical)
```

`examples/clean-support-prompt.md` is the same prompt with the volatile lines moved to the
trailing user turn. It passes.

---

## The 14 rules

| Severity | Rule |
|---|---|
| critical | Dynamic timestamp inside the cached prefix |
| critical | Per-request identifiers (UUID, `request_id`, `session_id`, nonce) |
| critical | Prefix below the provider minimum — caching silently skipped, no error |
| high | Mutable working memory in the system prompt |
| high | Per-user personalisation (name, locale, timezone, currency, plan) |
| high | Volatile content ordered ahead of stable content |
| high | Tool definitions can change between calls |
| critical | No `cache_control` breakpoint (Anthropic) — nothing caches at all |
| high | No cache-hit-rate instrumentation |
| medium | Requests may land on different models or service tiers |
| medium | Cached prefix larger than it needs to be |
| medium | Non-deterministic serialisation (random value interpolated into the prefix) |
| medium | Cache TTL does not match request cadence |
| medium | Error-retry path rebuilds the prefix |

Full catalogue: `node cli/prefix-audit.mjs --list-rules`

## Client audit reports

The done-for-you engagement deliverable. Turns CLI output into a report you can
send to an engineering lead:

```bash
node cli/prefix-audit.mjs --dir prompts --requests 8000 --json > audit.json

node scripts/audit-report.mjs --in audit.json \
     --client "Acme Corp" --engineer "Your Name" \
     --out report.md --html report.html
```

It produces an executive summary, findings with cited evidence, a cost model, a
remediation plan ordered by impact-per-effort, and the instrumentation fields
needed to turn estimates into measurements.

Two invariants are enforced by tests, because they are what the engagement is
actually worth:

- **Every dollar figure is labelled a model**, in the body and again in a
  dedicated caveats section.
- **A finding demoted to advisory is never counted as critical.** A timestamp
  *after* the cache breakpoint costs only its own write; reporting it as a
  critical defect in a client document would be wrong.

## Auditing a real API request

Paste a raw Anthropic or OpenAI request body instead of prose and the audit works
from the actual bytes, not from a checkbox:

```bash
node cli/prefix-audit.mjs my-request.json --requests 8000 --logs-cache
```

`.json` inputs are auto-detected (`--payload` forces it). The tool parses the
`system` blocks and `tools`, finds the `cache_control` marker, and then asks the
question that actually decides the bill: **is there cache-breaking content
before the breakpoint?**

- Volatile content **before** it invalidates the whole cached span downstream.
- The same content **after** it costs only its own write.

Findings that sit entirely after the breakpoint are demoted and annotated rather
than reported as critical — the cost model already prices them.

```
  payload: request JSON · claude-opus-4-7 · 2 tools
  breakpoint: at 100% of prefix · 1,151 tokens cached, 0 after
      2 volatile pattern(s) before it, 0 after
      2 cache-breaking pattern(s) sit BEFORE the breakpoint, so everything
      from there down re-bills fresh. Move the breakpoint earlier, or move
      that content after it.
```

`examples/broken-request.json` and `examples/clean-request.json` are the same
prompt with only the breakpoint placement changed — 8% vs 92% hit rate, $598/mo
versus $0.

---

## CI gate

Fail the PR that breaks the prefix, before the invoice explains it three weeks later.

```yaml
name: prompt-cache
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx -y -p prefixaudit prefix-audit prompts/support.md \
             --provider anthropic \
             --requests 8000 \
             --fail-on critical \
             --max-waste 500
```

Exit codes: `0` clean · `1` findings at or above `--fail-on` · `2` usage or IO error.

**Install.** The package is `prefixaudit`; the command it puts on your PATH is
`prefix-audit`:

```bash
npm i -g prefixaudit                       # then just: prefix-audit <args>
# or without installing anything:
npx -y -p prefixaudit prefix-audit <args>
```

```
--provider <id>       anthropic | openai | gemini | deepseek | custom
--requests <n>        requests per day for the cost model
--gap <minutes>       average minutes between requests on one prefix
--ttl <5m|1h>         cache TTL tier
--breakpoint          assert the prefix carries a cache_control marker
--logs-cache          assert you log provider cache-token usage fields
--fail-on <sev>       critical | high | medium
--max-waste <n>       also fail if modelled monthly waste exceeds $n
--baseline <file>     fail if the prefix hash changed vs. a stored baseline
--update-baseline     write the baseline instead of comparing
--stability           treat the inputs as N renders of one prefix and diff them
--dir <dir>           audit every prompt/source file under a directory
--json                machine-readable output
```

`--stability` is the sharpest one. Give it N real renders of the same prefix and it points at
the exact byte where they diverge:

```bash
prefix-audit --stability samples/turn1.txt samples/turn2.txt
#   UNSTABLE. The prefix diverges between renders, so the cache cannot hit.
#       first divergence at byte 41 (sample #2)
#       stable prefix: 12 of 16 tokens (75%)
#       hit-rate ceiling: 75%
#       around the break: ...ou are an agent. Current date: 2026-09-22. Follow policy....
#   FIX  Move everything after that byte into the trailing user message,
#        so the cached prefix stops at the last stable byte.
```

---

## Privacy

**The web auditor runs entirely in your browser.** There is no backend, no upload, no
analytics, no account. This is structural, not a policy: `dist/index.html` is a single
self-contained file with no network calls, so there is nowhere for a prompt to go.

That matters because a system prompt is competitive IP and often contains customer data.

---

## Accuracy — read this before quoting numbers

**Detection is exact.** A regex either matches your prompt or it does not.

**The token count is an estimate.** It is a calibrated heuristic, not a real BPE tokenizer.
Measured against `tiktoken`'s `o200k_base` over a 16-sample corpus: **RMSE 14.2%**, and within
**13%** on the inputs this tool is actually used for (prompts, markdown, JSON tool schemas).
The ground-truth counts are pinned in `test/estimator.test.mjs` — change the estimator and the
build fails if accuracy regresses. Regenerate with `python3 scripts/measure-bpe.py`.

**The dollar figure is a model, not a measurement.** It applies published provider multipliers
(cache read 0.1×, write 1.25× at 5-minute TTL, minimum cacheable length by model) to your
stated request volume. Prices drift; every one is editable in the UI or via
`--base-price / --read-mult / --write-mult / --min-tokens`. Confirm against your own invoice.

---

## Tests

```bash
npm test
```

258 tests:

| File | Tests | What it covers |
|---|---|---|
| `test/engine.test.mjs` | 43 | Detection rules, cost model, auto-fix, stability diff, position weighting, catalogue completeness |
| `test/payload.test.mjs` | 32 | **Request-payload parsing** — breakpoint placement, stable serialisation, provider detection |
| `test/realworld.test.mjs` | 34 | **Precision on real-world text** — false positives found in a 236-prompt corpus, each paired with a true positive that must survive |
| `test/cli.test.mjs` | 32 | Real CLI entry point: exit codes, flags, baseline, `--dir`, `--stability`, `--payload` |
| `test/dist.test.mjs` | 19 | Executes the **shipped** `dist/index.html` in a DOM stub and asserts on rendered output |
| `test/estimator.test.mjs` | 18 | Tokenizer pinned against real `tiktoken` counts |
| `test/action.test.mjs` | 23 | GitHub Action report formatter — annotation line accuracy, PR markdown, exit codes |
| `test/seo.test.mjs` | 16 | Generated pages pinned to the engine — prices, minimums, breakeven, corpus figures |
| `test/report.test.mjs` | 19 | Client audit report — severity grouping, honesty invariants, HTML safety |

The two that matter most are the ones that caught real bugs:

- `dist.test.mjs` caught `autoFix` failing on `Current date and time:` — the exact phrasing in
  the flagship example.
- `realworld.test.mjs` exists because the first run over a real prompt corpus was substantially
  wrong. Synthetic tests only contain the patterns you were looking for. Real prompts contain
  `"user names"`, `"caller is jumping"`, `GET /v1/sessions/{session_id}/events`,
  `` `ss-${Date.now()}` `` inside a code example, and `name: str`. All of those were false
  positives. See `research/REPORT.md`.

---

## Layout

```
src/engine.mjs          analysis engine — pure, no imports, no DOM
cli/prefix-audit.mjs    CI gate
site/template.html      UI shell
scripts/build.mjs       inlines the engine -> dist/index.html, then regenerates dist/
scripts/gen-seo.mjs     generates llms.txt, robots, sitemap, _redirects, provider + rule pages
                        (every number computed from the engine, so pages cannot drift)
scripts/measure-bpe.py  regenerates tokenizer ground truth
action.yml              composite GitHub Action (the paid CI tier)
action/report.mjs       CI report formatter: log summary, PR comment, diff annotations
examples/               broken vs clean prompts + broken/clean request payloads
sample-report/          a generated client audit report (md + self-contained html)
DEPLOY.md               Cloudflare Pages + npm publish walkthrough
```

## Why a single file?

`scripts/build.mjs` inlines the engine into the HTML at a marker and emits one 68KB artefact.
No bundler, no dependencies, no build chain to maintain. It drops onto any static host — or
opens straight off disk — and it makes the privacy claim structurally true rather than a
promise.

## Research

`research/REPORT.md` — PrefixAudit run over **236 real system prompts** from 16 vendors
(CC0 corpus). 65.3% carry at least one structural finding; 32.2% render a date or time into the
cached prefix; 28.8% sit below the provider minimum and cannot cache at all. It also documents
the false positives the first pass produced and what changed as a result.

Reproduce: `node scripts/corpus-study.mjs <prompts-dir>`
