# PrefixAudit GitHub Action

Fail CI when a change to a system prompt would silently break prompt caching —
and name the line that costs the money.

Static analysis only. **No API keys, no network calls, no prompt text leaves
CI.** The action runs the same zero-dependency CLI in the repo; there is nothing
to install and no server to bill.

---

## Quick start

```yaml
# .github/workflows/prefixaudit.yml
name: prefix-audit
on:
  pull_request:
    paths: ['prompts/**', 'src/**']

permissions:
  contents: read
  pull-requests: write # only needed for the PR comment

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - uses: prefixaudit/prefixaudit@v1
        with:
          path: prompts
          provider: anthropic
          requests-per-day: '8000'
          fail-on: critical
```

That is the whole install. No secrets, no `npm install`, no Docker.

---

## What it does

1. **Audits** every prompt under `path` with the 14 detection rules.
2. **Fails the build** when a finding at or above `fail-on` severity appears.
3. **Comments on the PR** with a table of findings, the offending line quoted,
   the fix, and a modelled dollar figure. The comment is *upserted* — one
   comment per PR, edited on each push, not one per commit.
4. **Annotates the diff** so a finding appears inline on the exact line in
   "Files changed".
5. **Detects baseline drift** when you give it a `baseline` file.

### The PR comment

Verbatim from `examples/broken-support-prompt.md` at 8,000 requests/day:

> ### ❌ `examples/broken-support-prompt.md` — score **0/100** (F)
>
> est. hit rate **0%** → **88%** if fixed · prefix ~**1,812** tokens ·
> modelled waste **$1,033/mo** ($12,399/yr)
>
> | | Finding | Line |
> |---|---|---|
> | 🔴 critical | A timestamp is inside the cached prefix | `3` |
> | 🔴 critical | Per-request identifiers are inside the cached prefix | `4` |
> | 🟠 high | Per-user personalisation is inside the cached prefix | `5` |
> | 🔵 low | No cache breakpoint marker found | whole prefix |
>
> > `Current date and time: 2026-09-22T14:03:11Z`
> > — at **1%** into the prefix, so everything after it re-bills fresh.
>
> **Fix:** Delete the timestamp from the system prompt, or move it to the END of
> the final user message where it cannot invalidate the prefix.

Reproduce it yourself:

```bash
node cli/prefix-audit.mjs examples/broken-support-prompt.md --requests 8000 --json \
  > audit.json
node action/report.mjs --in audit.json --comment-out pr.md
```

Dollar figures are always labelled a **model**, never a measurement, and token
counts carry their ±14% estimator caveat in the footer.

---

## Inputs

| Input | Default | Notes |
|---|---|---|
| `path` | `prompts` | File, glob, or directory. Directories are scanned for `.md`/`.txt`/`.json`. |
| `provider` | `anthropic` | `anthropic` \| `openai` \| `gemini` \| `deepseek` \| `custom` |
| `requests-per-day` | `1000` | Drives the cost model. |
| `ttl` | `5m` | `5m` or `1h`. |
| `fail-on` | `critical` | `critical` \| `high` \| `medium`. |
| `max-waste` | — | Also fail if modelled monthly waste exceeds this many dollars. |
| `baseline` | — | Path to a baseline JSON; fails on prefix-hash drift. |
| `update-baseline` | `false` | Write the baseline instead of comparing. |
| `breakpoint` | `false` | Assert a `cache_control` marker exists. **Leave off for plain-text prompts** — prose cannot express a marker. `.json` request payloads are parsed and checked automatically. |
| `logs-cache` | `false` | Assert you log provider cache-token usage fields. |
| `comment` | `true` | Post the PR comment. |
| `annotate` | `true` | Emit inline diff annotations. |

## Outputs

| Output | Meaning |
|---|---|
| `score` | Score of the worst-scoring audited prompt (0–100). |
| `grade` | Its letter grade. |
| `findings` | Total findings across audited prompts. |
| `monthly-waste` | Total modelled monthly waste in dollars. |
| `passed` | `"true"` when the gate passed. |

---

## Baseline drift

Catches an accidental edit to a prompt nobody meant to ship — every cache entry
goes cold the moment the prefix bytes change.

```yaml
      # One-off: record the baseline and commit the file.
      - uses: prefixaudit/prefixaudit@v1
        with:
          path: prompts/support.md
          baseline: .prefixaudit-baseline.json
          update-baseline: 'true'

      # Every PR after that: fail if the prefix changed.
      - uses: prefixaudit/prefixaudit@v1
        with:
          path: prompts/support.md
          baseline: .prefixaudit-baseline.json
```

```
[BASELINE] prompt prefix changed since the recorded baseline.
           Every cache entry is now cold.
```

To accept a deliberate change, re-run with `update-baseline: 'true'` and commit
the new file — so the diff is reviewed in the same PR.

---

## Notes on correctness

**Annotations are suppressed for request payloads.** For a `.json` request the
prefix is reassembled from `system` blocks and `tools`, so a prefix line number
does not correspond to a line in the JSON file. Pointing an annotation at the
wrong line is worse than no annotation, so the comment reports
`prefix line 6` instead of a file link. Plain-text prompts get real file
annotations.

**`breakpoint` is advisory, not fatal, on plain prose.** A missing
`cache_control` marker in a *parsed request* is critical — nothing will cache.
In plain text the marker is not even representable, so the action reports it as
a hint rather than failing your CI over something the input format cannot
express.

**The gate cannot be bypassed by a failing step order.** The audit step exits
non-zero on findings, which would normally abort the job before the comment
posts. The action captures the exit code, posts the report, then re-raises it —
so a failing audit always comes with an explanation.

---

## Local equivalent

Everything the action does is the CLI, so you can reproduce a CI failure
exactly:

```bash
node cli/prefix-audit.mjs prompts --provider anthropic --requests 8000 \
     --fail-on critical --json > audit.json

node action/report.mjs --in audit.json --comment-out pr.md --annotate
```
