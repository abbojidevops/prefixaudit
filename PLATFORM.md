# PLATFORM.md — Platform Assessment & Revenue-Gated Roadmap

Companion to `PROJECT.md`. This answers the question: *"PrefixAudit should become
the control plane for LLM prompt reliability and AI inference cost — what is the
honest path from here to there?"*

Verdict up front: **the vision is the correct north star; the build order is
revenue-gated, not calendar-gated.** Nothing in phases 8–14 of the platform
vision may be built before a customer pays for it. This is not timidity — it is
the brief's own rule (§3: deep architecture, not artificial complexity; §40:
build incrementally, do not pretend) applied to a solo founder at ₹0 capital.

---

## 1. Gap map — vision vs. shipped code

Every row below was verified against the repository on 2026-09-26, not assumed.

### Shipped (phases 1–7 of the vision, ~85% complete)

| Vision area | Where it lives | Evidence |
|---|---|---|
| Analysis pipeline (parse → analyze → cost → risk → recommend) | `src/engine.mjs` | `parseRequestPayload` → `audit`/`auditPayload` → `costModel` → `RULE_CATALOG` → `autoFix` |
| Prompt parser / internal representation | `parseRequestPayload` | Anthropic Messages API, OpenAI Responses API, bare system-block arrays, plain text fallback; typed descriptor with breakpoint positions |
| Rule-engine framework | `rule()` registry, 14 rules | each rule: `id`, `severity`, `title`, `why`, `fix`, `wastedPrefixShare`, `positionSensitive`, `detect(text, source)`; catalog exported via `RULE_CATALOG` |
| Provider abstraction | `PROVIDERS`, `resolveProvider` | anthropic/openai/gemini/deepseek/custom; per-provider `baseInputPerM`, `readMult`, `writeMult`, `minTokens`, behavioural `note`; `custom` + overrides = "add a provider without touching core" |
| Cost engine | `costModel()` | provider, prefix tokens, requests/day, hit rate, TTL; output always labelled **modeled estimate** (23 sales checks enforce this) |
| Optimization engine | `autoFix()` + per-rule `fix` text | explain / fix / preview; never applied without explicit user action |
| CLI | `cli/prefix-audit.mjs` | `--json --fail-on --max-waste --payload --breakpoint --provider --requests --read-mult --write-mult --ttl --min-tokens --dir --quiet --list-rules --gap --logs-cache` + exit codes 0/1/2 |
| Baseline & drift detection | CLI `--baseline` / `--update-baseline` | prefix-hash comparison gate |
| Stability testing | `prefixStability()` + `--stability` | N-render diff → first-divergence byte, stable/unstable regions |
| CI/CD (GitHub) | `.github/workflows/prefixaudit.yml` | PR gate with findings annotations |
| Web app | `site/`, 21 canonical URLs | landing, auditor, rules library, provider pages, pricing, privacy, terms |
| Report generator (paid audits) | `action/report.mjs` + `scripts/audit-report.mjs` | branded report from CLI JSON |
| Test suite | `test/` (9 files) | 258 tests / 0 fail, executed against the shipped artefact |
| Data-quality discipline | everywhere | every number on site/CLI/report labelled modeled/estimated; corpus stats traceable to `research/findings.json` |

### Deliberately NOT built (and the gate that unlocks each)

| Vision area | Why not now | Unlock gate |
|---|---|---|
| REST API (§22) | needs a running server; free Cloudflare tier suffices only once there are callers | first paying CI/dashboard customer |
| Dashboard (§17–19) | a dashboard with no data behind it is theatre | first paying customer |
| Auth / orgs / RBAC / SSO (§20, §40) | security obligations scale with data held; at ₹0 we hold nothing — that is the feature | first $199/mo or enterprise contract |
| Database (§27) | no structured data to store until accounts exist | with dashboard |
| Queues / workers (§28) | analysis is millisecond-scale, synchronous, client-side | workload that actually needs it |
| Monitoring / cost intelligence (§18–19, §29) | requires ingesting customer spend data = keys, retention, trust review; hardest sale in AI FinOps, funded competitors own it | enterprise contract that pays for it |
| Billing (§41) | Stripe integration only on first yes (standing decision) | first yes |
| SDKs (§23), VS Code (§24), GitLab/Jenkins (§13) | ₹0 items, but they dilute the launch window | week 2+ after launch, in order |
| Admin platform, feature flags (§42–43) | tooling for a team that does not exist yet | when there is a team |
| Kubernetes / Terraform (§30) | the brief itself says do not add it to sound impressive | private-deployment contract |

---

## 2. Revenue-gated roadmap

Phases are triggered by **money or users**, never by the calendar.

**Gate 0 — LAUNCH (Tue 29 Sep 19:30 IST).**
Ship. No platform work before this. The launch is the cheapest market research
that exists, and every hour of platform-building before it is building for an
imagined market.

**Gate 1 — Post-launch, ₹0, no infra (weeks 1–6, evenings).**
The free slice of the vision that deepens the moat without a server:
1. `prefix-audit` subcommands (`analyze`, `fix`, `diff`, `cost`, `providers`) — cosmetic sugar over existing flags; keep flags working (compat contract).
2. Split `src/engine.mjs` internals into modules under `src/` — **npm `files` and the inlined `dist/` contract do not change**; tests gate the refactor.
3. ADRs in `docs/architecture/adr/` — one per real decision already made (single-file auditor, zero-telemetry, flat deploy, rule registry, cost-model labelling).
4. Custom-rule documentation + a fixture-based example rule (framework already supports it).
5. Benchmark script (`benchmarks/`) measuring analysis latency/memory on the 236-prompt corpus — real numbers, never fabricated.
6. GitLab CI template (pure YAML, ₹0).
7. VS Code extension skeleton (diagnostics from engine JSON; free to publish).

**Gate 2 — First paying customer (any tier).**
Thin cloud on free tiers only (Cloudflare Pages Functions + D1/KV = ₹0):
- API `/api/v1/analyze` wrapping the existing engine (stateless, no prompt storage).
- API keys + orgs, minimal dashboard: projects, prompts, findings history, baselines.
- Notifications: email on baseline drift (Resend free tier).
Still zero telemetry on the free web/CLI path — that promise never moves.

**Gate 3 — First $6k consulting / $199 team contract.**
Baseline history over time, trend views, team seats, Slack webhook.

**Gate 4 — First $12k enterprise contract (signed, money in).**
Only now: hosted DB with retention policies, SSO, audit logs, private-deploy
packaging. The customer's contract pays for the infrastructure.

**Gate 5 — Enterprise demand, contractual.**
AI cost-intelligence ingestion (§18–19) last, not first: it is the most
dangerous surface in the whole product (customer billing data) and must be
dragged into existence by a contract, never volunteered.

---

## 3. Standing rules for all platform work

1. **Zero-telemetry on the free product is permanent.** Cloud features are
   opt-in additions, never replacements for local mode.
2. **Data-quality labels are a legal feature.** Observed / measured /
   estimated / modeled / assumed / imported — every number carries its class.
   Never present modeled values as billing data.
3. **No component without a responsibility.** Every service, table, queue or
   flag must name the capability it exists for and the test that proves it.
4. **Contracts are frozen surfaces.** npm package contents, `dist/` inlining,
   CLI flags/exit codes, site anchors, SEO URLs — extensions only, never
   breaking changes without a version gate.
5. **The launch is not negotiable.** Any platform work that endangers
   Tue 29 Sep loses to the launch, every time.
