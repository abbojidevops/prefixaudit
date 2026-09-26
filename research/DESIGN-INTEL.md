# DESIGN INTEL — what the top AI/dev startups actually ship
Scraped from live HTML 2026-09-25 (head CSS, theme-color, font stacks), plus the
20-style map. Purpose: decide PrefixAudit's visual language with evidence, not taste.

## Observed tokens (live scrape)

| Site | Background | Accent | Type identity |
|---|---|---|---|
| Anthropic | `#000` | terracotta `rgba(204,120,92,·)` (#CC785C) | **display serif** variables — editorial on black |
| Linear | `#08090a` (theme-color) | muted violet/green per section | **monospace everywhere** (61× `--font-monospace`) |
| Vercel | pure `#000` / `#fff` duality | none — geometry is the accent | grotesk + `--font-mono` accents |
| Cursor | warm black `#14120b` | warm greys `#1c1c1e→#2c2c2e` | **serif** (`Iowan Old Style, Palatino…` stack) |
| ElevenLabs | white | near-black ink | `Inter` + custom grotesk (`Waldenburg`) |
| Mistral | white | single bold amber `#ffaf01` | grotesk, one loud accent |
| OpenAI / Stripe | JS-rendered heads (no static signal) | known: OpenAI = black/white minimal grotesk (Söhne); Stripe = aurora mesh gradients on white |

## The 2026 consensus recipe for trust-heavy dev/AI tools
1. Near-black canvas (`#000`–`#0a0a0a`), occasionally *warm* black.
2. One of two type identities: heavy grotesk **+ mono for data**, or **editorial serif accents** on the black.
3. At most one or two accent hues; aurora/glass as *spice*, not the meal.
4. Swiss grid discipline: tight letterspacing, mono numerals, visible structure.

## The 20 styles, mapped to who ships them and our verdict

| # | Style | Shipped by (examples) | PrefixAudit verdict |
|---|---|---|---|
| 1 | Minimalism | OpenAI, Vercel, Linear | BASE — keep |
| 2 | Maximalism | Spotify-style consumer wraps | avoid — noise kills trust |
| 3 | Futuristic | Cursor/Vercel glows, us | BASE — keep |
| 4 | Vector art | Notion/Stripe illustrations | optional later (docs art) |
| 5 | Collage art | creative agencies | avoid |
| 6 | Retro | novelty brands | avoid |
| 7 | Cyberpunk | gaming/web3 | avoid — reads untrustworthy to FinOps buyers |
| 8 | Pop art | consumer | avoid |
| 9 | Glassmorphism | Apple visionOS era; our cards | ACCENT — keep, dosed |
| 10 | Clay style | playful SaaS mascots | avoid |
| 11 | Pixel art | indie games | avoid |
| 12 | Editorial | **Anthropic, Cursor**, Stripe blog | ADOPT NOW — serif accents (was our only missing signal) |
| 13 | Y2K | fashion | avoid |
| 14 | Swiss design | Linear's grid, Stripe docs | BASE — mono numerals, tight tracking |
| 15 | Surreal | Runway, creative-AI | avoid for the tool; maybe launch video |
| 16 | Bohemian | lifestyle | avoid |
| 17 | Victorian | heritage brands | avoid |
| 18 | Graffiti | streetwear | avoid |
| 19 | Aurora | Stripe mesh, our orbs | BASE — keep |
| 20 | Handwritten | personal brands | avoid |

## Decision
Our stack = 1+3+9+14+19, which is exactly the Linear/Vercel convergence. The single
highest-signal gap vs Anthropic/Cursor was **12 (Editorial)**. Implemented 2026-09-25:
hero and section heading accents (`em`) now render in a system editorial serif
italic (Iowan Old Style/Palatino/Georgia stack — the same family Cursor ships),
zero network cost, layered under the existing gradient. No other style earns a
place: every rejected row above would cost us the trust signal that converts
FinOps buyers.

## 2026-09-25 — full editorial transformation (creative brief)
The dark aurora/glass iteration was replaced by a warm editorial system per a
25-point creative brief:

- Palette: ivory #F6F1E8 / parchment #EFE7DA canvas; espresso #211D1A dark
  sections; terracotta #B86B4B primary accent; lavender #7564A8 and champagne
  #C9A86A as rare accents; forest #4E806B success; muted red #B85C55 error.
  Ratio ≈ 60/25/8/4/3 as briefed. No blue, no neon, no gradient headlines.
- Type: editorial serif display (Instrument Serif/Playfair/Cormorant fallbacks
  to Iowan/Georgia — zero webfont requests) against Inter-class sans and
  IBM Plex Mono technical labels. Oversized serif hero with italic accents.
- Hero: eyebrow → 3-line editorial headline ("that *breaks*" in italic
  terracotta serif) → confident sub → CTAs → an explanatory instrument
  (token stream → breakpoint line → three readouts). No terminal in hero.
- Motion is explanatory only: staggered token reveal, breakpoint draw,
  readout sequence, CI pipeline node walk, console line-in, counters,
  reveals, magnetic CTAs, cursor light confined to the dark section.
  Everything dies under prefers-reduced-motion.
- Rules became a numbered ledger (CSS counters), pricing a
  Free/Developer(espresso)/Team editorial table, footer a 5-column
  enterprise footer; privacy.html + terms.html added (not in sitemap).
- Radii capped at 6/10/14; 1px hairlines; 3.5% paper grain; no glassmorphism.
The 258-test contract held through the transformation (IDs, rendered strings,
JSON-LD, canonical, single-file rule all preserved).
