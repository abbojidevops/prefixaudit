# Accuracy review — 2026-09-22

Pulled from Anthropic's official prompt-caching documentation today. The engine
models one blended `anthropic` provider; reality has moved. **Nothing here is a
reason not to launch** — the errors run in the conservative direction — but
they are real and should be fixed before an Enterprise audit where the dollar
figures are the deliverable.

## 1. The provider table is a simplification, and it now understates

`src/engine.mjs` models Anthropic as: base **$3/MTok**, cache read **0.1×**,
5m write **1.25×**, 1h write **2.0×**, minimum **1,024** tokens.

The write multipliers are **correct** and still current. The base price and the
read multiplier are not:

| Model | Base $/MTok | Cache-read multiplier |
|---|---|---|
| Fable 5.1 / Mythos 5.1 | 10 | **0.025×** |
| Fable 5 / Mythos 5 | 10 | 0.1× |
| **Opus 5.5** | **4** | **0.05×** |
| Opus 5, 4.8, 4.7, 4.6, 4.5 | 5 | 0.1× |
| Opus 4.1, 4 (retired) | 15 | 0.1× |
| Sonnet 5 | 2 | 0.1× |
| Sonnet 4.6, 4.5 | 3 | 0.1× |
| Haiku 4.5 | 1 | 0.1× |
| Haiku 3.5 (retired) | 0.80 | 0.1× |

**Direction of error — both conservative, which is the safe way to be wrong:**

- Base $3 vs the $5 real Opus price ⇒ **understates waste** for Opus users
- Read 0.1× vs the real 0.05×/0.025× on the newest models ⇒ **understates
  savings**, because cheaper reads mean caching is worth more

So no client has ever been shown an inflated number by this. But an Opus 5.5
user on a large prefix is being told a meaningfully smaller opportunity than
the truth, which is a weaker sales document than it could be.

**Fix:** the `custom` provider path already accepts `--base-price` and
`--read-mult`. The real fix is a per-model table rather than one blended row.

## 2. Automatic caching exists, and one rule's premise has moved

Anthropic now supports a **top-level** `cache_control` that automatically
applies the breakpoint to the last cacheable block and moves it forward as the
conversation grows — no per-block markers needed.

This affects the `no-breakpoint` rule. It is already gated on
`breakpointKnown` (so it stays quiet when the breakpoint can't be determined),
which is why it has not misfired. But the *advice* the product gives assumes
explicit breakpoints are the only mode. Worth updating before an audit where
the client is on automatic caching — otherwise the remediation list tells them
to add markers they don't need.

## 3. The provider now ships a competing diagnostic

Anthropic documents **cache diagnostics**: the API compares consecutive
requests and reports which part of the prompt diverged.

That overlaps directly with `prefix-audit --stability`. Not fatal — the vendor
tool needs two live requests and tells you *what* diverged, while `--stability`
works offline on saved renders and the rule engine tells you *why* and what it
costs — but the differentiation claim should be stated that precisely, not
overstated.

## 4. What the docs confirm — the core thesis is provider-endorsed

Quoted from Anthropic's own troubleshooting guidance:

> Place the breakpoint on the last block that stays identical across requests.
> For a prompt with a static prefix and a varying suffix (timestamps,
> per-request context, the incoming message), that is the end of the prefix,
> not the varying block.

> Cache writes happen only at the breakpoint, and if that block changes
> (timestamps, per-request context, the incoming message), the prefix hash
> never matches. The lookback does not find stable content behind the
> breakpoint.

> Verify that the keys in your `tool_use` content blocks have stable ordering
> as some languages (for example, Swift, Go) randomize key order during JSON
> conversion, breaking caches.

That third one independently validates the `unstable-serialisation` rule, which
fired on **zero** corpus files and was close to being deleted as unreachable.
It is not a false rule — it is a rare one, and the provider documents it as a
real failure mode. **Keep it.**

Also confirmed: cache hits require 100% identical segments; 5-minute default
TTL; caches are isolated per workspace, so two teams in one org cannot share a
warm prefix.

## 5. Unresolved conflict — do not "fix" this without checking

**Cache minimums disagree between sources.**

- Engine table: Opus 4.8 → **1,024**, Opus 4.7 → **2,048**, Haiku 4.5 → 4,096
- OpenRouter's blog (July 2026): "Claude Opus 4.5 through 4.8 and Claude Haiku
  4.5 need **4,096**"; Gemini 2.5 Pro 4,096, Gemini 2.5 Flash 1,024

I did **not** retrieve the official "Cache limitations" section today, so this
is genuinely unresolved. The OpenRouter post is older, and floors have moved
before — but that is a hypothesis, not a finding.

**Action before any paid audit:** read Anthropic's Cache limitations section
directly and reconcile. Getting a floor wrong flips `below-minimum` — the rule
that fired on **68 of 236** corpus prompts — from correct to false positive or
false negative wholesale. This is the highest-consequence open item in the
product.

**Do not** resolve it by picking whichever number makes the finding rate look
better.
