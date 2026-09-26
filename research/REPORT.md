# The State of Prompt Caching in Production System Prompts

**236 real system prompts · 16 vendors · audited 2026-09-22**

I ran PrefixAudit over every system prompt in a public-domain (CC0) archive of published and
extracted prompts — Claude, ChatGPT, Gemini, Grok, Cursor, Copilot, Perplexity, Devin, Warp,
Zed and others. This is what the cached prefixes of the world's most-used AI products actually
look like.

---

## Headline numbers

| | |
|---|---|
| System prompts analysed | **236** |
| Non-prompt files excluded | 177 (skills, examples, API references, repo metadata) |
| Vendors | 16 |
| With ≥1 in-scope finding | **167 / 236 — 70.8%** |
| With a high-severity or worse finding | **154 / 236 — 65.3%** |
| With a critical finding | **131 / 236 — 55.5%** |
| Below the provider cache minimum (structurally *cannot* cache) | **68 / 236 — 28.8%** |

**Prefix size (estimated tokens):** median **2,914** · mean 11,054 · p90 39,821 · max 134,569.

## What actually breaks, ranked

| Rule | Files | Share | Severity |
|---|---|---|---|
| Rendered date/time in the cached prefix | 76 | 32.2% | critical |
| Below the provider minimum cacheable length | 68 | 28.8% | critical |
| Cached prefix far larger than it needs to be | 36 | 15.3% | medium |
| Mutable memory / scratchpad in the prefix | 27 | 11.4% | high |
| Per-user personalisation in the prefix | 11 | 4.7% | high |
| Per-request identifier in the prefix | 7 | 3.0% | critical |
| Volatile content ahead of stable content | 4 | 1.7% | high |
| Tool definitions can change between calls | 2 | 0.8% | high |

### The single most common pattern

A rendered date, in one form or another:

```
Today's date: Monday, August 10, 2026 (for more granularity, use bash)
The current date is {{currentDateTime}}.
Remember, current date is {{CURRENTDATE}}. Use this date in search query if user mentions specific date
```

Appears in **32.2%** of the corpus. This is the exact failure mode documented in the wild: a
170,000-token context fully reprocessed on every request, cache reads at zero, costs running
10× higher than expected — because a `Current Date & Time` field changed on every turn.

Anthropic's own AI director has described the design intent plainly: system prompts exist partly
so "they let us give the model 'live' information like the date." That is a legitimate product
decision. It is also, mechanically, a cache invalidator — which is why the fix is *placement*,
not deletion.

### The second most common pattern

**28.8% of prompts are below the provider's minimum cacheable length** (1,024 tokens on
Anthropic Sonnet-class and OpenAI GPT-5.6+). Below that floor the `cache_control` marker is
ignored with **no error and no warning**. You pay full input price while believing caching is on.

Median prompt in the corpus is 2,914 tokens — comfortably above. But the p25 is **810 tokens**,
below the floor. Small, focused prompts are the ones silently excluded.

---

## Position matters, and it changes the verdict

A timestamp at byte 40 of a 40,000-byte prefix kills the cache for essentially everything.
The same timestamp as the final line, after a cache breakpoint, only costs the suffix.

PrefixAudit v0.1 treated them identically. That was wrong, and it made the study dishonest.
v0.2 weights position-sensitive rules by how much of the prefix sits at or after the offending
byte, and reports it:

```
> line 3: Current date and time: 2026-09-22T14:03:11Z
at 1% into the prefix — invalidates nearly the whole prefix after it
```

This is the difference between "your prompt is broken" and a real number.

---

## The part that makes these numbers credible

**My first pass over this corpus was substantially wrong, and running it is what proved that.**

The initial run reported 78.2% of prompts with findings and 63.2% with a critical one. Then I
checked whether the detectors were firing on genuine patterns. They weren't:

| Pattern | What it actually matched |
|---|---|
| `user name` | "user names", "user named.", "user name the" |
| `caller is` | "Caller is optional", "caller is jumping", "caller is staying" |
| `current/latest state` | prose like "read a task's latest state using TaskGet" |
| `session_id` | `"session_id": "string"` — a tool-schema *declaration* |
| `{session_id}` | `GET /v1/code/sessions/{session_id}/events` — an API path |
| ISO-8601 timestamp | `- "2026-03-05T14:30:00-08:00" — Runs once on March 5 at 2:30 PM` — a cron example |
| `# Memory` | a documentation heading, not mutable state |
| `Date.now()` | `path.join(DIR, \`ss-${Date.now()}\`)` — inside a code example |
| `Todo` | `export const Todo = () => {` — a React component |
| model names in prose | "works with claude models, gemini models and grok models" — 169 hits |

The root cause is the one every synthetic test suite hides: **I wrote the test prompts myself.**
They contained exactly the patterns I was looking for and none of the noise real prompts contain.

### What I changed

1. **Code masking.** Fenced blocks, inline code and `<code>` are blanked before detection, with
   every character offset preserved so line numbers and snippets stay accurate. Real prompts are
   full of worked examples; example code is not the request you send. Fences are tracked with a
   **line state machine**, not a paired regex: one prompt in the corpus has 385 fence markers
   (odd), and a paired regex mis-pairs every block after the stray one. Measured across the
   corpus, the old regex was blanking up to 5,561 lines of real prose per file while leaving up
   to 5,604 lines of code visible — on 34 of 236 files.
2. **Line-context guards.** `NEGATED` skips lines *warning about* an anti-pattern ("Don't
   interpolate the current date"). `SCHEMA` skips type declarations. `ENDPOINT` skips URL paths.
   `PLACEHOLDER_ID` skips `00000000-0000-...`.
3. **Value requirements.** A "current date" line must be followed by an actual date, weekday or
   placeholder. A personalisation field must carry a real locale, currency, timezone or plan —
   not `str`.
4. **Corpus filter.** 177 files excluded: on-demand skill docs, examples, API references, repo
   metadata, superseded versions. Auditing those and calling the result "236 system prompts"
   would be a lie, and it inflates every finding because example code is full of what we detect.
5. **An illustrative-example guard on dates.** System prompts teach date handling with a
   hardcoded worked example (`xAI/grok-bot.md`: "Example: If today is 2026-08-20 …"). That date
   is frozen documentation and cannot break a cache. Excluding it removes exactly one finding,
   and it was the only false positive the date rule produced.
6. **30 regression tests** built directly from the false positives above
   (`test/realworld.test.mjs`), each paired with a true positive that must survive.

Effect: 413 files → 236 real prompts; `model-churn` 169 hits → 8; `personalisation`
264 matches → 20; one shipped rule was **removed** after measurement (below).

### A rule that did not survive measurement

An `unstable-serialisation` detector originally flagged embedded JSON whose keys were not in
sorted order. Run against the corpus it fired **twice and was wrong twice** — both hits were JSON
*examples* inside documentation, not serialised runtime state. System prompts are full of
illustrative JSON, so the heuristic cannot be made precise from a single rendered prompt. It was
removed rather than shipped at ~0% precision, and the decision is pinned by a test. A second
branch of that rule (`json.dumps` without `sort_keys`) was removed for a different reason: it
lives in the code that *builds* the prompt, and code blocks are masked before detection, so it
could never fire at all. Key-order instability is instead caught by comparing two renders.

---

## Limitations — read before quoting anything here

1. **These are prompts, not requests.** I can see the text, not the API call. I cannot see where
   any vendor places its cache breakpoints. A prompt containing `{{currentDateTime}}` is
   *evidence of a cache-breaker*; it is not proof that the vendor's hit rate is low. They may
   place it after the breakpoint — which is exactly the fix this tool recommends.
2. **Detection is structural, not measured.** Real hit rates require `cache_read_input_tokens`
   from the provider. This study cannot produce them.
3. **Token counts are estimates.** Calibrated against real `tiktoken` counts: RMSE 14.2%, within
   13% on prompts and JSON tool schemas.
4. **No dollar figures.** I deliberately did not model spend. Request volumes for these products
   are not public, so any dollar number here would be invented.
5. **A finding is not a criticism.** Anthropic, OpenAI and Google have context, telemetry and
   engineering that no static analysis can see. This measures structure.
6. **The corpus is a snapshot** of a fast-moving target.

---

## Reproduce it

```bash
git clone --depth 1 https://github.com/asgeirtj/system_prompts_leaks.git /tmp/spl
node scripts/corpus-study.mjs /tmp/spl --out research/findings.json
```

`research/findings.json` contains the full per-file results. The methodology — including the
four rules excluded for needing request-level context, and the corpus filter — is documented in
the header of `scripts/corpus-study.mjs`.

**Corpus licence:** CC0 1.0 Universal (public domain). No prompt text is redistributed here;
quoted lines are short excerpts used for analysis.
