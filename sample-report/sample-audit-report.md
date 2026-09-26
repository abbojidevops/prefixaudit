# Prompt Cache Audit

| | |
|---|---|
| **Prepared for** | Example Client (demo) |
| **Prepared by** | PrefixAudit |
| **Date** | 2026-09-22 |
| **Scope** | 4 prompt prefixes from examples/ |
| **Method** | Static analysis, PrefixAudit v0.1.0 |

## Executive summary

We audited **4** prompt prefixes. The mean cache-health score is **54/100**; the weakest scores **0/100 (F)**.

**2 critical issues** will prevent prompt caching from working as intended:

- **A timestamp is inside the cached prefix** — affects 2 prefixes
- **Per-request identifiers are inside the cached prefix** — affects 2 prefixes

Across the audited scope the modelled waste is **$2,618 per month** (**$31,414 per year**), against an estimated achievable hit rate of **88%** after remediation.

> **These dollar figures are a model, not a measurement.** They are derived from the request volume supplied (240,000 requests/month on the first prefix) and published provider list prices. They indicate the size of the opportunity; they are not an invoice line.

## Findings

| Severity | Finding | Prefixes affected |
|---|---|---|
| Critical | A timestamp is inside the cached prefix | 2 |
| Critical | Per-request identifiers are inside the cached prefix | 2 |
| High | Per-user personalisation is inside the cached prefix | 1 |
| High | Mutable working memory lives in the system prompt | 1 |
| Low | No cache breakpoint marker found | 2 |
| Info | A timestamp is inside the cached prefix | 1 |

### Detail

#### Critical — A timestamp is inside the cached prefix

**Why it costs money.** Cache hits need a byte-exact prefix match. A rendered date or time makes every request unique, so the cache writes full price and reads never. The single most common cause of a 0% hit rate.

**Evidence** (from `examples/broken-request.json`):

> `Current date and time: 2026-09-22T14:03:11Z`  
> — line 5, at 8% into the prefix

**Remediation.** Delete the timestamp from the system prompt, or move it to the END of the final user message where it cannot invalidate the prefix. If the model needs "today", inject it as a trailing user turn.

Also present in: `examples/broken-support-prompt.md`

#### Critical — Per-request identifiers are inside the cached prefix

**Why it costs money.** Request IDs, session IDs, trace IDs and UUIDs change on every call. Anything before them stops matching, so the whole prefix re-bills fresh.

**Evidence** (from `examples/broken-request.json`):

> `request_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f`  
> — line 6, at 9% into the prefix

**Remediation.** Move IDs out of the system block entirely. Put them in the user turn or in a separate uncached system block placed AFTER the cache breakpoint.

Also present in: `examples/broken-support-prompt.md`

#### High — Per-user personalisation is inside the cached prefix

**Why it costs money.** A name, locale, timezone or currency in the system prompt splits your cache into one cold entry per user segment. Each segment pays a full-price write before it ever reads. Teams that moved a 300-token user block out of the system prompt took their hit rate from 23% to 71%.

**Evidence** (from `examples/broken-support-prompt.md`):

> `The user's name is Priya Sharma`  
> — line 5, at 2% into the prefix

> `User locale: en-IN, timezone: Asia/Kolkata, currency: INR`  
> — line 6, at 2% into the prefix

**Remediation.** Keep the system prompt a policy document, not a render target for user state. Move name/locale/timezone/currency/plan into the trailing user message. Use a separate cache breakpoint if you must cache per-user context.

#### High — Mutable working memory lives in the system prompt

**Why it costs money.** Agent state that mutates between steps invalidates the prefix on nearly every step. ProjectDiscovery ran at a 7% hit rate for exactly this reason; relocating the working memory to a trailing user message took it to 84% and cut LLM cost 59%, with 9.8B tokens eventually served from cache.

**Evidence** (from `examples/broken-support-prompt.md`):

> `## Working memory`  
> — line 8, at 3% into the prefix

**Remediation.** Move scratch state, scratchpads, task lists, tool-result summaries and running memory OUT of the system block into the last user message. The system prompt should be static for the whole session.

#### Low — No cache breakpoint marker found

**Why it costs money.** On Anthropic nothing is cached unless cache_control is attached to the block. Setting the parameter is not automatic: a custom system prompt passed as a plain string bypasses the tagging code path entirely, so you pay a 1.25x write on every call and collect zero reads.

**Evidence** (from `examples/broken-support-prompt.md`):

> `cannot confirm a cache_control marker from prompt text alone — audit the request payload to check`  
> — whole prefix

**Remediation.** Attach cache_control: {"type":"ephemeral"} to the system block and/or the last tool definition. A breakpoint on the last tool also caches every tool before it. Then verify with cache_read_input_tokens > 0 on call 2.

Also present in: `examples/clean-support-prompt.md`

#### Info — A timestamp is inside the cached prefix

**Why it costs money.** Cache hits need a byte-exact prefix match. A rendered date or time makes every request unique, so the cache writes full price and reads never. The single most common cause of a 0% hit rate.

**Evidence** (from `examples/clean-request.json`):

> `Current date: 2026-09-22`  
> — line 38, at 100% into the prefix

**Remediation.** Delete the timestamp from the system prompt, or move it to the END of the final user message where it cannot invalidate the prefix. If the model needs "today", inject it as a trailing user turn.

## Cost model

| Prefix | Score | Est. hit rate | If fixed | Modelled waste |
|---|---|---|---|---|
| `examples/broken-request.json` | 20/100 (F) | 8% | 88% | $598/mo |
| `examples/broken-support-prompt.md` | 0/100 (F) | 0% | 88% | $1,033/mo |
| `examples/clean-request.json` | 100/100 (A) | 92% | 88% | $0/mo |
| `examples/clean-support-prompt.md` | 96/100 (A) | 0% | 88% | $987/mo |
| **Total** | | | | **$2,618/mo** |

Reads are billed at the provider's cache-read multiplier and misses re-bill the prefix at full base price. Writes are charged once per TTL window. Token counts are estimated at ±14% against real BPE tokenisation.

## Recommended remediation, in order

Ordered by impact per unit of effort, not by severity alone.

| # | Action | Effort | Impact |
|---|---|---|---|
| 1 | Relocate per-request or per-user state to a trailing message. _(per-user personalisation is inside the cached prefix)_ | Medium | High |
| 2 | Relocate per-request or per-user state to a trailing message. _(mutable working memory lives in the system prompt)_ | Medium | High |
| 3 | Move the value below the cache breakpoint, or into the user turn. _(a timestamp is inside the cached prefix)_ | Low | High |
| 4 | Move the value below the cache breakpoint, or into the user turn. _(per-request identifiers are inside the cached prefix)_ | Low | High |
| 5 | Attach cache_control to the system block or the last tool definition. _(no cache breakpoint marker found)_ | Low | High |
| 6 | Move the value below the cache breakpoint, or into the user turn. _(a timestamp is inside the cached prefix)_ | Low | High |

## Instrument before you optimise further

This audit is static analysis: it reads the prompt and the request, not your traffic. To turn these estimates into measurements, log the provider's cache-token fields on every response:

- **Anthropic** — `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`
- **OpenAI** — `usage.input_tokens_details.cached_tokens`
- **Gemini** — `usage.total_cached_tokens`

Hit rate is `cache_read_input_tokens ÷ (cache_read_input_tokens + uncached input)`. Alert on sustained zeros after warm-up — the first call in any session always writes and never reads, by design.

## What this audit could not determine

Stated plainly, because it bounds every number above:

1. **We saw prompts, not traffic.** Cache breakpoint placement at runtime, TTL behaviour and routing are not visible in a prompt file. A flagged prompt is evidence of a cache break, not proof of a measured low hit rate.
2. **Dollar figures are modelled**, from the request volume you supplied and public list prices. They are not measured spend.
3. **Token counts are estimated** at ±14% against real BPE tokenisation.
4. **A flagged prompt is not a claim that your product is broken.** Many teams cache correctly through harness behaviour that the prompt text does not reveal.
5. **Static analysis has false positives.** Every finding above cites the exact line so it can be checked in seconds. Please check them.

---

_Generated by PrefixAudit v0.1.0. Static analysis: no API keys, no network calls. Rule catalogue and methodology available on request._