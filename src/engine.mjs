/*
 * PrefixAudit engine — pure, dependency-free, runs in Node and the browser.
 *
 * Everything here is deterministic static analysis + published-price arithmetic.
 * No network calls. No API keys. A prompt never leaves the machine that ran it.
 *
 * Prices are DEFAULTS transcribed from public 2026 provider tables. They drift.
 * Every one of them is overridable by the caller, and the UI exposes them.
 */

export const VERSION = '0.1.1';

/* ------------------------------------------------------------------ */
/* Token estimation                                                    */
/* ------------------------------------------------------------------ */

/**
 * BPE-ish token estimate. Plain `len/4` is bad for prompts full of JSON,
 * camelCase identifiers and punctuation, which is exactly what a system
 * prompt + tool schema is. This splits on BPE-like boundaries first.
 *
 * Not a real tokenizer. Treat as +-15%. Good enough to rank prompts and to
 * size a cost estimate; never quote it as a billing figure.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;

  const runs = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+|\s+/gu) || [];

  // Coefficients below were fit against real o200k_base BPE counts over a
  // 16-sample corpus of prompts, markdown, JSON tool schemas and code
  // (see test/estimator.test.mjs, which pins the ground truth).
  // Measured: RMSE 14.2%, worst single case 33%.
  const K = {
    newline: 0.8,
    space: 3,
    punct: 1.8,
    digit: 1.8,
    digitFloor: 0.7,
    word: 4.8,
    mixed: 4.6,
    alnum: 2.6,
    upper: 3.4,
    wordFloor: 0.6,
  };

  // Accumulate fractionally and round once. Rounding every part to a whole
  // token is what makes naive per-word counting overshoot prose by ~2x.
  let acc = 0;

  for (const run of runs) {
    if (/^\s+$/.test(run)) {
      // A single space merges into the following token and costs nothing.
      // Newlines and indentation are real tokens.
      const newlines = (run.match(/\n/g) || []).length;
      acc += newlines * K.newline + Math.max(0, (run.length - newlines - 1) / K.space);
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(run)) {
      acc += run.length / K.punct;
      continue;
    }
    if (/^[0-9]+$/.test(run)) {
      acc += Math.max(K.digitFloor, run.length / K.digit);
      continue;
    }
    // ALL-CAPS runs (env-style identifiers, acronyms) merge differently.
    if (/^[A-Z0-9_]+$/.test(run) && run.length > 1) {
      acc += Math.max(K.digitFloor, run.length / K.upper);
      continue;
    }
    // Split camelCase, PascalCase, snake_case, and digit/letter boundaries.
    const parts = run
      .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])|_/)
      .filter(Boolean);
    for (const part of parts) {
      if (/^[0-9]+$/.test(part)) {
        acc += Math.max(K.digitFloor, part.length / K.digit);
        continue;
      }
      const divisor = /[A-Z]/.test(part) ? K.mixed : /[0-9]/.test(part) ? K.alnum : K.word;
      acc += Math.max(K.wordFloor, part.length / divisor);
    }
  }

  return Math.round(acc);
}

/**
 * Blank out fenced code blocks and inline code spans, preserving every
 * newline and every character offset.
 *
 * Why: real system prompts are full of worked examples — Python snippets with
 * `${Date.now()}`, curl lines with `/sessions/{session_id}/events`, JSON
 * schemas with `"user_id": "string"`. Those are documentation, not the
 * request the caller actually sends, and flagging them is a false positive.
 *
 * Offsets are preserved exactly, so detection can run on the masked text and
 * snippets can still be lifted from the original.
 */
/**
 * Blank code so prose-only detectors cannot fire on examples, while keeping
 * every character offset identical (so line numbers and evidence snippets can
 * still be lifted from the original).
 *
 * Fences are tracked with a line state machine rather than a paired regex. A
 * paired regex mis-handles an odd number of fence markers: it pairs the Nth
 * opener with the Nth closer, so one stray marker shifts every subsequent
 * pair and leaks whole code blocks into the scan text. Real system prompts
 * hit this — one 385-fence prompt in the corpus has an odd count, which is
 * how documentation JSON started looking like serialised runtime state.
 * An unterminated fence at EOF blanks to the end of the text.
 */
export function maskCodeBlocks(text) {
  if (typeof text !== 'string') return '';
  const blankLine = (l) => l.replace(/[^\n]/g, ' ');
  const lines = text.split('\n');
  let fence = null; // the marker that opened the current block
  const out = lines.map((line) => {
    const open = line.match(/^\s{0,3}(```+|~~~+)/);
    if (open) {
      if (!fence) {
        fence = open[1][0]; // ` or ~
        return blankLine(line);
      }
      if (open[1][0] === fence) {
        fence = null;
        return blankLine(line);
      }
      // A different marker inside a block is content, not a closer.
      return blankLine(line);
    }
    if (fence) return blankLine(line);
    return line
      .replace(/`[^`\n]+`/g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/<code>[\s\S]*?<\/code>/g, (m) => m.replace(/[^\n]/g, ' '));
  });
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Provider price table (defaults — editable)                          */
/* ------------------------------------------------------------------ */

/**
 * Multipliers are relative to base input price.
 * readMult   = price of a cache-hit token  / base input price
 * writeMult  = price of a cache-write token / base input price
 * minTokens  = below this the provider silently skips caching. No error.
 *
 * Source notes (verified Sept 2026):
 *  - Anthropic: reads 0.1x; writes 1.25x @ 5m TTL, 2.0x @ 1h TTL.
 *    Minimum cacheable length is model-dependent (512 / 1024 / 2048 / 4096).
 *  - OpenAI GPT-5.6+: reads 0.1x, writes 1.25x, min 1024. Earlier GPT-5.x
 *    models had free writes and a smaller (0.25-0.5x) read discount.
 *  - Gemini 2.5+/3.x: reads ~0.1x, no write multiplier, but explicit caches
 *    bill per-token-per-hour storage on top.
 *  - DeepSeek: reads ~0.1x.
 */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    baseInputPerM: 3.0,
    readMult: 0.1,
    writeMult: 1.25, // 5-minute TTL. Set 2.0 if you use ttl: "1h".
    minTokens: 1024,
    note: 'Explicit cache_control breakpoints (max 4). Reads 0.1x; write 1.25x @5m / 2.0x @1h.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI GPT-5.x',
    baseInputPerM: 5.0,
    readMult: 0.1,
    writeMult: 1.25, // GPT-5.6+. Pre-5.6 had no write surcharge.
    minTokens: 1024,
    note: 'Automatic caching, min 1024 tokens. GPT-5.6+ bills writes at 1.25x.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseInputPerM: 1.25,
    readMult: 0.1,
    writeMult: 1.0,
    minTokens: 2048,
    note: 'Implicit caching is free and automatic; explicit caches add storage $/token/hr.',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseInputPerM: 0.28,
    readMult: 0.1,
    writeMult: 1.0,
    minTokens: 1024,
    note: 'Automatic prefix caching; cached reads ~0.1x.',
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    baseInputPerM: 3.0,
    readMult: 0.1,
    writeMult: 1.25,
    minTokens: 1024,
    note: 'Bring your own numbers from your provider price page.',
  },
};

export function resolveProvider(key, overrides = {}) {
  const base = PROVIDERS[key] || PROVIDERS.custom;
  return { ...base, ...overrides, id: base.id, label: overrides.label || base.label };
}

/* ------------------------------------------------------------------ */
/* Request-payload parsing                                             */
/* ------------------------------------------------------------------ */

/**
 * Real callers do not have "a system prompt". They have an API request, and
 * the cached prefix is a specific slice of it: tools, then system, in that
 * order, up to the last cache breakpoint.
 *
 * Parsing the payload is what turns "did you tick the cache_control box?" into
 * a measurement. It also answers the question that actually determines the
 * bill: is your volatile content BEFORE or AFTER the breakpoint?
 *
 * Understands:
 *   - Anthropic Messages API   { system: string | [ {type,text,cache_control} ], tools, messages }
 *   - OpenAI Responses API     { instructions, input | messages, tools, prompt_cache_key }
 *   - A bare array of system blocks
 *   - Plain text (falls back to treating the whole thing as the prefix)
 *
 * @returns {object} parsed payload descriptor, or { kind: 'text' } if not JSON
 */
export function parseRequestPayload(input) {
  const raw = typeof input === 'string' ? input : '';
  const text = raw.trim();

  if (!text || !(text.startsWith('{') || text.startsWith('['))) {
    return { kind: 'text', prefixText: raw, hasBreakpoint: false };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // Not JSON. Treat as plain prompt text rather than failing.
    return { kind: 'text', prefixText: raw, hasBreakpoint: false, parseError: true };
  }

  const warnings = [];
  const blocks = []; // { text, cache: bool, role: 'tools'|'system'|'messages' }

  /* ---- tools: these precede the system prompt in the cached prefix ---- */
  const tools = Array.isArray(doc.tools) ? doc.tools : [];
  if (tools.length) {
    // Serialise deterministically so the hash is stable across calls.
    const serialised = tools.map((t) => stableStringify(t));
    blocks.push({
      text: serialised.join('\n'),
      cache: tools.some((t) => t && t.cache_control),
      role: 'tools',
      count: tools.length,
    });
  }

  /* ---- system: string or array of blocks ---- */
  const sys = doc.system ?? doc.instructions;
  if (typeof sys === 'string') {
    blocks.push({ text: sys, cache: false, role: 'system' });
  } else if (Array.isArray(sys)) {
    for (const b of sys) {
      if (b && typeof b === 'object' && typeof b.text === 'string') {
        blocks.push({
          text: b.text,
          cache: Boolean(b.cache_control),
          ttl: b.cache_control && b.cache_control.ttl,
          role: 'system',
        });
      } else if (typeof b === 'string') {
        blocks.push({ text: b, cache: false, role: 'system' });
      }
    }
  }

  /* ---- messages: the volatile tail ---- */
  const msgs = Array.isArray(doc.messages)
    ? doc.messages
    : Array.isArray(doc.input)
      ? doc.input
      : [];
  for (const m of msgs) {
    const body = typeof m === 'string' ? m : m && typeof m.content === 'string' ? m.content : null;
    if (body) blocks.push({ text: body, cache: false, role: 'messages' });
  }

  if (!blocks.length) {
    return {
      kind: 'text',
      prefixText: raw,
      hasBreakpoint: false,
      parseError: true,
      warnings: ['parsed as JSON but found no system, instructions, tools or messages field'],
    };
  }

  // The cached prefix is tools + system. Messages are the volatile suffix.
  const prefixBlocks = blocks.filter((b) => b.role === 'tools' || b.role === 'system');
  const prefixText = prefixBlocks.map((b) => b.text).join('\n');

  // Breakpoint = the last block carrying cache_control, in prefix order.
  let breakpointBlock = -1;
  let breakpointOffset = -1;
  let cursor = 0;
  const blockOffsets = [];
  for (let i = 0; i < prefixBlocks.length; i += 1) {
    blockOffsets.push(cursor);
    if (prefixBlocks[i].cache) {
      breakpointBlock = i;
      breakpointOffset = cursor + prefixBlocks[i].text.length;
    }
    cursor += prefixBlocks[i].text.length + 1;
  }

  const hasBreakpoint = breakpointBlock >= 0;
  if (!hasBreakpoint && prefixText.length) {
    warnings.push('no cache_control marker on any system or tool block');
  }
  if (tools.length && !tools.some((t) => t && t.cache_control) && hasBreakpoint) {
    // A breakpoint on the system block still caches preceding tools on
    // Anthropic, so this is fine — but worth saying so.
  }

  const breakpointPercent =
    hasBreakpoint && prefixText.length ? Math.round((breakpointOffset / prefixText.length) * 100) : 0;

  // OpenAI caches automatically; no marker is expected.
  const looksOpenAI = doc.instructions !== undefined || doc.prompt_cache_key !== undefined || doc.prompt_cache_options !== undefined;
  if (looksOpenAI && !hasBreakpoint) {
    warnings.pop();
    warnings.push('OpenAI-style payload: caching is automatic above the 1,024-token minimum, no marker needed');
  }

  return {
    kind: 'request',
    provider: looksOpenAI ? 'openai' : 'anthropic',
    model: typeof doc.model === 'string' ? doc.model : undefined,
    prefixText,
    prefixBlocks,
    blockOffsets,
    toolCount: tools.length,
    hasBreakpoint,
    breakpointBlock,
    breakpointOffset: hasBreakpoint ? breakpointOffset : -1,
    breakpointPercent,
    breakpointTtl: hasBreakpoint ? prefixBlocks[breakpointBlock].ttl : undefined,
    messageText: blocks.filter((b) => b.role === 'messages').map((b) => b.text).join('\n'),
    promptCacheKey: doc.prompt_cache_key,
    warnings,
  };
}

/** Deterministic serialisation: sorted keys, so a stable object hashes stable. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Audit a real request payload.
 *
 * Beyond the normal audit this measures the one thing that decides the bill:
 * whether volatile content sits before or after the cache breakpoint. Content
 * after the breakpoint costs its own write and nothing else; content before it
 * invalidates everything downstream.
 */
export function auditPayload(input, opts = {}) {
  const parsed = parseRequestPayload(input);

  if (parsed.kind === 'text') {
    const res = audit({ ...opts, systemPrompt: input, userMessage: opts.userMessage || '' });
    return { ...res, payload: parsed };
  }

  const res = audit({
    ...opts,
    systemPrompt: parsed.prefixText,
    userMessage: parsed.messageText,
    providerKey: opts.providerKey || parsed.provider,
    hasBreakpoint: opts.hasBreakpoint === undefined ? parsed.hasBreakpoint : opts.hasBreakpoint,
    breakpointKnown: true,
  });

  /* --- breakpoint analysis ----------------------------------------- */
  let breakpoint = null;
  if (parsed.hasBreakpoint) {
    const before = parsed.prefixText.slice(0, parsed.breakpointOffset);
    const after = parsed.prefixText.slice(parsed.breakpointOffset);
    const beforeHits = volatileContentIn(before);
    const afterHits = volatileContentIn(after);
    breakpoint = {
      percent: parsed.breakpointPercent,
      tokensBefore: estimateTokens(before),
      tokensAfter: estimateTokens(after),
      volatileBefore: beforeHits,
      volatileAfter: afterHits,
      // The verdict that matters.
      clean: beforeHits.length === 0,
      verdict:
        beforeHits.length === 0
          ? afterHits.length
            ? 'Breakpoint is correctly placed. Volatile content sits after it, where it only costs its own write.'
            : 'Breakpoint is correctly placed and nothing volatile follows it.'
          : `${beforeHits.length} cache-breaking pattern(s) sit BEFORE the breakpoint, so everything from there down re-bills fresh. Move the breakpoint earlier, or move that content after it.`,
    };
  }

  /* --- reconcile findings with the breakpoint ----------------------- */
  // Content after the breakpoint is already priced correctly by the cost
  // model: it costs its own write and nothing else. Reporting it as CRITICAL
  // while the breakpoint card says "correctly placed" is self-contradictory,
  // so those findings are demoted and annotated instead.
  let out = res;
  if (breakpoint && parsed.hasBreakpoint) {
    const at = parsed.breakpointOffset;
    const findings = res.findings.map((f) => {
      const offsets = f.evidence.map((e) => e.offset).filter((o) => typeof o === 'number');
      const allAfter = offsets.length > 0 && offsets.every((o) => o >= at);
      if (!allAfter) return f;
      return {
        ...f,
        severity: 'info',
        afterBreakpoint: true,
        originalSeverity: f.severity,
        note:
          'Sits after the cache breakpoint, so it does not invalidate the cached prefix. ' +
          'It costs its own cache write per request and is already reflected in the cost model.',
      };
    });
    const { score, grade } = scoreFindings(findings);
    out = {
      ...res,
      findings,
      counts: countSeverities(findings),
      score,
      grade,
      verdict: verdictFor(score, res.monthlyWaste),
    };
  }

  return { ...out, payload: parsed, breakpoint };
}

/** Lightweight volatile-content probe used for breakpoint placement. */
function volatileContentIn(text) {
  if (!text) return [];
  const probes = [
    { re: /\{\{[^}]*\b(?:now|today|current[_-]?(?:date|time|datetime)|timestamp)\b[^}]*\}\}/gi, label: 'interpolated date/time' },
    { re: /\b(?:current|today'?s)\s+(?:date|time|datetime)\s*(?:and\s+(?:date|time))?\s*[:=]\s*\S+/gi, label: 'rendered date/time' },
    { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, label: 'UUID' },
    { re: /\{\{[^}]*(?:request|session|trace|conversation)[_.-]?id[^}]*\}\}/gi, label: 'interpolated id' },
  ];
  const masked = maskCodeBlocks(text);
  const out = [];
  for (const p of probes) {
    p.re.lastIndex = 0;
    const m = p.re.exec(masked);
    if (m && !NEGATED.test(lineAt(masked, m.index)) && !PLACEHOLDER_ID.test(m[0])) {
      out.push({ label: p.label, snippet: trimLine(text, m.index) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Detection rules                                                     */
/* ------------------------------------------------------------------ */

/**
 * A "finding" is { id, severity, title, why, evidence, fix, costMultiplierHint }.
 *
 * severity: critical | high | medium | low | info
 *
 * `wastedPrefixShare` is this rule's estimated share of the prefix that gets
 * re-billed fresh instead of cached. Rules compose; the auditor caps at 1.0.
 */

const RULES = [];

function rule(def) {
  RULES.push(def);
  return def;
}

/* ---- R1: timestamps and dates in the cached prefix ---------------- */
rule({
  id: 'dynamic-timestamp',
  positionSensitive: true,
  severity: 'critical',
  title: 'A timestamp is inside the cached prefix',
  wastedPrefixShare: 1.0,
  why:
    'Cache hits need a byte-exact prefix match. A rendered date or time makes ' +
    'every request unique, so the cache writes full price and reads never. ' +
    'The single most common cause of a 0% hit rate.',
  fix:
    'Delete the timestamp from the system prompt, or move it to the END of the ' +
    'final user message where it cannot invalidate the prefix. If the model ' +
    'needs "today", inject it as a trailing user turn.',
  detect(text, source) {
    const patterns = [
      // Interpolated clock: the strongest signal there is. {{currentDateTime}}
      // is rendered per request by construction.
      {
        re: /\{\{[^}]*\b(?:now|date|time|today|current[_-]?(?:date|time|datetime)|timestamp)\b[^}]*\}\}/gi,
        label: 'interpolated date/time variable',
      },
      {
        re: /\{\{[^}]*(?:datetime\.now|strftime|toISOString|Date\.now|now\(\))[^}]*\}\}/gi,
        label: 'datetime call in template',
      },
      {
        re: /\$\{[^}]*(?:new Date|Date\.now|now\(\)|toLocale(?:Date|Time)String)[^}]*\}/g,
        label: 'clock call in template literal',
      },
      {
        re: /\{[a-z_]*(?:current_?date|current_?time|today|now)[a-z_]*\}/gi,
        label: 'format-string date field',
      },
      // "Current date: 2026-04-24" — only when a real date, weekday or
      // placeholder follows. Requiring DATE_VALUE is what stops this matching
      // prose that merely mentions "the current date".
      {
        re: /\b(?:current|today'?s)\s+(?:date|time|datetime)\s*(?:and\s+(?:date|time))?\s*[:=]\s*\S+/gi,
        label: 'rendered "current date/time" line',
        requireLine: [DATE_VALUE],
        rejectLine: NEGATED_OR_ILLUSTRATIVE,
      },
      {
        re: /\b(?:today|now)\s+is\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2},? \d{4})/gi,
        label: 'rendered date sentence',
        rejectLine: NEGATED_OR_ILLUSTRATIVE,
      },
      // A bare ISO timestamp is only interesting on a line framing it as *now*.
      // Everywhere else it is a worked example or a schema default.
      {
        re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
        label: 'ISO-8601 timestamp rendered as "now"',
        requireLine: [/\b(?:current|today|now|as of)\b/i],
        rejectLine: NEGATED_OR_ILLUSTRATIVE,
      },
    ];
    return collect(text, patterns, source);
  },
});

/* ---- R2: ids and nonces in the cached prefix ---------------------- */
rule({
  id: 'volatile-id',
  positionSensitive: true,
  severity: 'critical',
  title: 'Per-request identifiers are inside the cached prefix',
  wastedPrefixShare: 1.0,
  why:
    'Request IDs, session IDs, trace IDs and UUIDs change on every call. ' +
    'Anything before them stops matching, so the whole prefix re-bills fresh.',
  fix:
    'Move IDs out of the system block entirely. Put them in the user turn or in ' +
    'a separate uncached system block placed AFTER the cache breakpoint.',
  detect(text, source) {
    const patterns = [
      // A real UUID in the prefix. Placeholder/example UUIDs are excluded.
      {
        re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
        label: 'UUID literal in the prefix',
        rejectLine: PLACEHOLDER_ID,
      },
      // Interpolated identifiers: the value is filled in per request.
      {
        re: /\{\{[^}]*(?:request|req|session|sess|trace|conversation|correlation|invocation|tenant)[_.-]?id[^}]*\}\}/gi,
        label: 'interpolated id',
        rejectLine: ENDPOINT,
      },
      {
        re: /\$\{[^}]*(?:request|session|trace|correlation|invocation)[_.-]?id[^}]*\}/gi,
        label: 'interpolated id in template literal',
      },
      {
        re: /\{(?:request|session|trace|correlation|invocation)[_-]?id\}/gi,
        label: 'format-string id field',
        rejectLine: new RegExp('(' + NEGATED.source + ')|(' + ENDPOINT.source + ')', 'i'),
      },
      // A labelled id followed by a real value. The SCHEMA guard rejects
      // tool-schema declarations like `"session_id": "string"`, which declare
      // a parameter rather than rendering one.
      {
        re: /\b(?:request|session|trace|correlation|invocation)[_-]?id\s*[:=]\s*[^\s,)}\]]+/gi,
        label: 'rendered id value',
        rejectLine: new RegExp(
          '(' + NEGATED.source + ')|(' + SCHEMA.source + ')|(' + PLACEHOLDER_ID.source + ')|(' + ENDPOINT.source + ')',
          'i',
        ),
      },
      {
        re: /\b(?:uuid\.uuid4|crypto\.randomUUID|nanoid\(\)|randomUUID\(\))\b/g,
        label: 'nonce / random key generated per call',
        rejectLine: NEGATED,
      },
    ];
    return collect(text, patterns, source);
  },
});

/* ---- R3: personalisation in the prefix ---------------------------- */
rule({
  id: 'personalisation-in-prefix',
  positionSensitive: true,
  severity: 'high',
  title: 'Per-user personalisation is inside the cached prefix',
  wastedPrefixShare: 0.9,
  why:
    'A name, locale, timezone or currency in the system prompt splits your cache ' +
    'into one cold entry per user segment. Each segment pays a full-price write ' +
    'before it ever reads. Teams that moved a 300-token user block out of the ' +
    'system prompt took their hit rate from 23% to 71%.',
  fix:
    'Keep the system prompt a policy document, not a render target for user ' +
    'state. Move name/locale/timezone/currency/plan into the trailing user ' +
    'message. Use a separate cache breakpoint if you must cache per-user context.',
  detect(text, source) {
    const patterns = [
      // Interpolated user attributes: rendered per user, so every user gets
      // their own cold cache entry.
      {
        re: /\{\{[^}]*(?:user|customer|account|profile|person|caller)[_.-]?(?:name|first[_-]?name|last[_-]?name|email|locale|language|lang|timezone|time[_-]?zone|currency|plan|tier|company|org)\b[^}]*\}\}/gi,
        label: 'interpolated user attribute',
      },
      {
        re: /\$\{[^}]*(?:user|customer|account|profile)[_.-]?(?:name|email|locale|timezone|currency|plan|tier)\b[^}]*\}/gi,
        label: 'interpolated user attribute in template literal',
      },
      // A labelled identity/preference line with a value. Requires the label
      // to start the line (optionally behind a list or heading marker) so it
      // cannot match prose that happens to contain the words "user name".
      // Identity requires an explicit user/customer qualifier. Without it,
      // `name: Explore` (an agent definition) and `name: str` (a type
      // annotation) both match, which is most of a real prompt corpus.
      {
        re: /^[ \t]*(?:[-*>#]+[ \t]*)?(?:the )?(?:user'?s|customer'?s|caller'?s|account'?s|person'?s)[ \t]+(?:name|full name|first name|last name|email|handle|username)[ \t]*[:=][ \t]*\S+/gim,
        label: 'rendered identity line',
        rejectLine: new RegExp('(' + NEGATED.source + ')|(' + SCHEMA.source + ')', 'i'),
      },
      {
        re: /\b(?:the )?(?:user'?s|customer'?s|caller'?s)\s+(?:name|email)\s+is\s+\S+/gi,
        label: 'rendered identity sentence',
        rejectLine: NEGATED,
      },
      // Preference fields require a value that looks like a real locale,
      // currency, timezone or plan — not a type name.
      {
        re: /^[ \t]*(?:[-*>#]+[ \t]*)?(?:user|customer|account|caller)?[ \t]*(?:locale|language|lang|timezone|time zone|tz|currency|plan|tier)[ \t]*[:=][ \t]*\S+/gim,
        label: 'rendered locale/timezone/currency/plan',
        requireLine: [PERSONAL_VALUE],
        rejectLine: new RegExp('(' + NEGATED.source + ')|(' + SCHEMA.source + ')', 'i'),
      },
      // An IANA timezone id is only meaningful when it is being assigned,
      // not when it appears as an example inside a tool description.
      {
        re: /\b(?:America|Europe|Asia|Australia|Africa|Pacific|Atlantic)\/[A-Z][A-Za-z_]+/g,
        label: 'IANA timezone id assigned in the prefix',
        requireLine: [/^[ \t]*(?:[-*>#]+[ \t]*)?(?:timezone|time zone|tz|locale)[ \t]*[:=]/im],
        rejectLine: SCHEMA,
      },
    ];
    return collect(text, patterns, source);
  }
});

/* ---- R4: mutable working memory in the prefix --------------------- */
rule({
  id: 'mutable-memory-in-prefix',
  positionSensitive: true,
  severity: 'high',
  title: 'Mutable working memory lives in the system prompt',
  wastedPrefixShare: 1.0,
  why:
    'Agent state that mutates between steps invalidates the prefix on nearly ' +
    'every step. ProjectDiscovery ran at a 7% hit rate for exactly this reason; ' +
    'relocating the working memory to a trailing user message took it to 84% and ' +
    'cut LLM cost 59%, with 9.8B tokens eventually served from cache.',
  fix:
    'Move scratch state, scratchpads, task lists, tool-result summaries and ' +
    'running memory OUT of the system block into the last user message. The ' +
    'system prompt should be static for the whole session.',
  detect(text, source) {
    const patterns = [
      // Explicit scratch/working-memory blocks. A bare "# Memory" heading is
      // documentation of a memory feature, not mutable state, so the heading
      // pattern requires a scratch/working/running/short-term qualifier.
      {
        re: /^[ \t]*#{1,6}[ \t]*(?:working|scratch|running|short[- ]term|agent|task)[ \t]+memory\b/gim,
        label: 'working-memory section in the prefix',
      },
      {
        re: /^[ \t]*#{1,6}[ \t]*(?:scratchpad|scratch pad|working state|current state|task list|todo list|todo)\b/gim,
        label: 'scratchpad section in the prefix',
      },
      {
        re: /\b(?:working|scratch|running)[ \t]+memory\b/gi,
        label: 'working memory reference',
        rejectLine: NEGATED,
      },
      {
        re: /\b(?:scratchpad|scratch pad)\b/gi,
        label: 'scratchpad reference',
        rejectLine: NEGATED,
      },
      // An instruction to mutate a block that lives in the prefix. Requires
      // the mutation verb AND the target on the same line.
      {
        re: /\b(?:update|append to|rewrite|overwrite|maintain|mutate|replace)\b[^.\n]{0,40}\b(?:scratchpad|scratch pad|working memory|working state|task list|todo list)\b/gi,
        label: 'instruction to mutate prefix state',
        rejectLine: NEGATED,
      },
    ];
    return collect(text, patterns, source);
  }
});

/* ---- R5: below the minimum cacheable length ----------------------- */
rule({
  id: 'below-minimum',
  severity: 'critical',
  title: 'Prefix is below the provider minimum, so caching is silently skipped',
  wastedPrefixShare: 1.0,
  why:
    'Every provider has a minimum cacheable prefix length. Below it the ' +
    'cache_control marker is ignored with NO error and NO warning. You keep ' +
    'paying full input price while believing caching is on.',
  fix:
    'Either grow the static prefix above the minimum (bundle stable reference ' +
    'docs, examples and tool schemas into the cached block) or drop the ' +
    'breakpoint and stop paying the write premium for nothing.',
  detect() {
    return []; // Evaluated by the auditor, which knows prefixTokens + provider.
  },
  evaluate(ctx) {
    if (ctx.prefixTokens >= ctx.provider.minTokens) return null;
    return {
      evidence: [
        {
          line: 0,
          snippet: `${ctx.prefixTokens.toLocaleString()} estimated tokens vs. ${ctx.provider.minTokens.toLocaleString()} minimum for ${ctx.provider.label}`,
        },
      ],
    };
  },
});

/* ---- R6: dynamic content ordered before static content ------------ */
rule({
  id: 'ordering',
  severity: 'high',
  title: 'Volatile content sits ahead of stable content',
  wastedPrefixShare: 0.8,
  why:
    'Caching is a prefix match: the first changed byte kills the cache for ' +
    'everything after it. The correct order is tools, then the static system ' +
    'prompt, then reference docs, then history, then the live user query.',
  fix:
    'Reorder so the prompt goes most-stable to least-stable. Anything that can ' +
    'change must come AFTER the last cache breakpoint.',
  detect(text, source) {
    const snippetFrom = source || text;
    // Only unambiguous volatile markers. A bare "session id" in prose or a
    // CLI flag is not volatile content, so it is deliberately not here — the
    // volatile-id rule handles identifiers with proper value guards.
    const firstVolatile = firstIndex(text, [
      /\{\{[^}]*\b(?:now|today|current[_-]?(?:date|time|datetime))\b[^}]*\}\}/i,
      /\b(?:current|today'?s)\s+(?:date|time|datetime)\s*(?:and\s+(?:date|time))?\s*[:=]\s*[^\s]/i,
      /^[ \t]*#{1,6}[ \t]*(?:working|scratch|running)[ \t]+memory\b/im,
    ]);
    const firstStable = firstIndex(text, [
      /^[ \t]*(?:#{0,6}[ \t]*)?(?:you are|role|instructions|guidelines|policy|rules|objective|system)\b/im,
    ]);
    if (firstVolatile === -1 || firstStable === -1) return [];
    if (firstVolatile < firstStable) {
      // Do not report a volatile line that is itself a negated instruction.
      const line = lineAt(text, firstVolatile);
      if (NEGATED.test(line)) return [];
      return [{ line: lineOf(text, firstVolatile), snippet: trimLine(snippetFrom, firstVolatile) }];
    }
    return [];
  },
});

/* ---- R7: tool schema instability --------------------------------- */
rule({
  id: 'tool-churn',
  severity: 'high',
  title: 'Tool definitions can change between calls',
  wastedPrefixShare: 0.8,
  why:
    'Tools are part of the cached prefix and are ordered BEFORE the system ' +
    'prompt. Adding, removing, reordering, or re-serialising a tool with a ' +
    'different JSON key order breaks the cache for the entire request. OpenAI ' +
    'reports this as reason "tools_changed".',
  fix:
    'Freeze the tool list and its order for the life of a session. Sort JSON ' +
    'keys deterministically when serialising. To restrict a tool at runtime use ' +
    'tool_choice/allowed_tools instead of mutating the schema you send.',
  detect(text, source) {
    const patterns = [
      { re: /\b(?:if|when)\s+(?:the user|we|the customer)\s+(?:has|is|needs)[^.]{0,60}\btools?\b/gi, label: 'conditional tool list' },
      { re: /\b(?:add|remove|append|inject|insert)\s+(?:this\s+)?tool(?:s| definitions?)?\s+(?:to|from|into)\b/gi, label: 'mutating tool list' },
      { re: /\bjson\.dumps\((?![^)]*sort_keys\s*=\s*True)[^)]*\)/g, label: 'json.dumps without sort_keys' },
      { re: /\b(?:filter|map|reduce)\s*\([^)]*\btools\b/g, label: 'tools built by transformation' },
      { re: /\bshuffle\b[^.]{0,40}\btools?\b/gi, label: 'shuffled tools' },
    ];
    return collect(text, patterns, source);
  },
});

/* ---- R8: no cache breakpoint -------------------------------------- */
rule({
  id: 'no-breakpoint',
  // Critical, not high: on Anthropic this produces the same outcome as being
  // below the token minimum — nothing caches at all, hit rate 0%.
  severity: 'critical',
  title: 'No cache breakpoint marker found',
  wastedPrefixShare: 1.0,
  why:
    'On Anthropic nothing is cached unless cache_control is attached to the ' +
    'block. Setting the parameter is not automatic: a custom system prompt ' +
    'passed as a plain string bypasses the tagging code path entirely, so you ' +
    'pay a 1.25x write on every call and collect zero reads.',
  fix:
    'Attach cache_control: {"type":"ephemeral"} to the system block and/or the ' +
    'last tool definition. A breakpoint on the last tool also caches every tool ' +
    'before it. Then verify with cache_read_input_tokens > 0 on call 2.',
  detect() {
    return [];
  },
  evaluate(ctx) {
    if (ctx.provider.id !== 'anthropic') return null;
    if (ctx.options.hasBreakpoint) return null;
    // On a parsed request we SAW that the marker is missing: critical, because
    // nothing will cache. On plain prose the marker is not even representable,
    // so failing a CI gate over it would be blaming the user for something the
    // input format cannot express. Advisory instead.
    if (!ctx.options.breakpointKnown) {
      return {
        severity: 'low',
        evidence: [
          {
            line: 0,
            snippet:
              'cannot confirm a cache_control marker from prompt text alone — audit the request payload to check',
          },
        ],
      };
    }
    return {
      evidence: [
        { line: 0, snippet: 'no cache_control marker present in the parsed request payload' },
      ],
    };
  },
});

/* ---- R9: model / tier churn --------------------------------------- */
rule({
  id: 'model-churn',
  severity: 'medium',
  title: 'Requests in this set may land on different models or tiers',
  wastedPrefixShare: 0.9,
  why:
    'The cache is per-model. A router, A/B test, fallback or changed service ' +
    'tier that moves a request to a different model produces a cold miss even ' +
    'though the prompt is identical. OpenAI reports "model_changed" and ' +
    '"service_tier_changed" as distinct miss reasons.',
  fix:
    'Pin the model for calls that are meant to share a prefix. If you must ' +
    'route, use sticky routing keyed on the conversation so a session stays on ' +
    'one model and one shard.',
  detect(text) {
    // Only assignment-shaped model references count. Prose that mentions two
    // model names is not evidence that a request can land on either.
    const assign =
      /^[ \t]*(?:[-*>#]+[ \t]*)?(?:"|')?model(?:_name|Name|_id|Id)?(?:"|')?[ \t]*[:=][ \t]*(?:"|')?[a-z0-9][\w.\-]*[a-z0-9](?:"|')?[ \t]*[,;]?[ \t]*$/gim;
    const names = new Set();
    let m;
    while ((m = assign.exec(text)) !== null) {
      const val = m[0].split(/[:=]/)[1].trim().replace(/^["']|["'],?$/g, '');
      if (val) names.add(val.toLowerCase());
    }
    if (names.size < 2) return [];
    return [
      {
        line: 0,
        snippet: `${names.size} distinct models assigned in this prefix: ${[...names].slice(0, 6).join(', ')}`,
      },
    ];
  }
});

/* ---- R12: TTL vs cadence ------------------------------------------ */
rule({
  id: 'ttl-cadence',
  severity: 'medium',
  title: 'Cache TTL may not match your request cadence',
  wastedPrefixShare: 0,
  why:
    'Anthropic caches expire after 5 minutes by default (1 hour at 2x write ' +
    'cost). A prefix reused every 20 minutes never earns a read and pays the ' +
    'write premium every single time. Over-pinging to keep it warm is also ' +
    'expensive: 30s pings cost ~$3.60/hr vs ~$0.45/hr at the ~4min optimum for ' +
    'a 100K-token prefix.',
  fix:
    'Measure your real inter-request gap. Under 5 minutes: default TTL is fine. ' +
    'Between 5 and 60 minutes on steady traffic: the 1h tier usually wins. ' +
    'Longer: stop caching and stop paying the write surcharge.',
  detect() {
    return [];
  },
  evaluate(ctx) {
    if (ctx.provider.id !== 'anthropic') return null;
    const gap = ctx.options.gapMinutes;
    if (typeof gap !== 'number' || Number.isNaN(gap)) return null;
    if (gap > 5 && ctx.options.ttl === '5m') {
      return {
        evidence: [
          { line: 0, snippet: `~${gap} min between requests vs. a 5-minute TTL` },
        ],
      };
    }
    return null;
  },
});

/* ---- R13: retry path rebuilds the prefix -------------------------- */
rule({
  id: 'retry-rebuilds',
  severity: 'medium',
  title: 'Error-retry path appears to rebuild the prefix',
  wastedPrefixShare: 0.6,
  why:
    'A structured-output retry loop that resends a fresh system prompt pays a ' +
    'new write every time. A 98.4% structured-output success rate can still ' +
    'hide a 2% retry loop eating 12-18% of the inference budget.',
  fix:
    'Append the parse error and a corrective instruction as a new user message ' +
    'after the cached span. Never rebuild and resend the system prompt to retry.',
  detect(text, source) {
    const patterns = [
      // Requires the retry AND the prefix being rebuilt, on one line.
      {
        re: /\b(?:retry|retries|re-?attempt|resend|re-?send)\b[^.\n]{0,60}\b(?:system prompt|system message|full prompt|from scratch|entire prompt)\b/gi,
        label: 'retry rebuilds the system prompt',
        rejectLine: NEGATED,
      },
      {
        re: /\b(?:json|schema|parse|validation|structured)[ \t]+(?:error|failure|invalid)\b[^.\n]{0,50}\b(?:resend|re-?send|retry|start over|from scratch)\b/gi,
        label: 'resend on parse error',
        rejectLine: NEGATED,
      },
    ];
    return collect(text, patterns, source);
  }
});

/* ---- R14: logging blind spot -------------------------------------- */
rule({
  id: 'no-cache-metric',
  severity: 'high',
  title: 'No cache-hit-rate instrumentation found',
  wastedPrefixShare: 0,
  why:
    'Caching failures are invisible until the invoice arrives. A hit rate that ' +
    'starts at 72% and decays to 18% pages nobody. Every provider returns the ' +
    'fields you need, and a 10-point drop in a 24h window almost always means ' +
    'a deploy changed the prefix.',
  fix:
    'Log cache_read_input_tokens (Anthropic), cached_tokens (OpenAI) or ' +
    'total_cached_tokens (Gemini) on every call. Alert on N consecutive zeros ' +
    'after warm-up, and on a >10pt drop in a rolling 24h window.',
  detect() {
    return [];
  },
  evaluate(ctx) {
    if (ctx.options.logsCacheTokens) return null;
    return { evidence: [{ line: 0, snippet: 'no cache-token usage field referenced in the analysed input' }] };
  },
});

/* ------------------------------------------------------------------ */
/* Detector helpers                                                    */
/* ------------------------------------------------------------------ */

/** Collapse duplicate evidence rows (same line + same snippet). */
function dedupeEvidence(evidence) {
  const seen = new Set();
  const out = [];
  for (const e of evidence) {
    const key = `${e.line}|${e.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * @param {string} text     the text to scan (may be code-masked)
 * @param {Array}  patterns
 * @param {string} [source] original text for snippets; offsets match `text`
 */
function collect(text, patterns, source) {
  const hits = [];
  const seen = new Set();
  const snippetFrom = source || text;
  for (const pat of patterns) {
    const { re, label, requireLine, rejectLine } = pat;
    re.lastIndex = 0;
    let m;
    let count = 0;
    let firstIdx = -1;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      // Line-context guards. This is what keeps the detector honest on real
      // prompts, which are full of prose ABOUT cache-breakers, tool schemas
      // that merely DECLARE an id parameter, and worked examples.
      const line = lineAt(text, m.index);
      if (rejectLine && rejectLine.test(line)) continue;
      if (requireLine && !requireLine.some((r) => r.test(line))) continue;
      count += 1;
      if (firstIdx === -1) firstIdx = m.index;
    }
    if (count > 0 && !seen.has(label)) {
      seen.add(label);
      hits.push({
        line: lineOf(text, firstIdx),
        offset: firstIdx,
        snippet: trimLine(snippetFrom, firstIdx),
        label,
        count,
      });
    }
  }
  return hits;
}

/** The full line containing a character index. */
function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * Guards shared by several rules.
 *
 * NEGATED matches prose that is *warning about* the anti-pattern rather than
 * exhibiting it — real prompts do this constantly ("never interpolate the
 * current date into the system prompt").
 *
 * SCHEMA matches a tool/JSON-schema declaration, where an id or a timezone is
 * a declared parameter rather than a rendered value.
 */
const NEGATED =
  /\b(?:don'?t|do not|never|avoid|instead of|must not|should not|wrong|incorrect|bad|anti-?pattern|mistake|forbidden|prohibited|without|never put)\b/i;
const SCHEMA = /(?::|->|→)\s*["'`]?(?:string|str|integer|int|number|boolean|bool|uuid|datetime|date|enum|object|array|any)\b|\(\s*(?:string|str|integer|int|number|boolean|bool|uuid)\s*\)|"type"\s*:\s*"|"description"\s*:/i;
const PLACEHOLDER_ID = /\b(?:0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|1{8}-1{4}-1{4}-1{4}-1{12}|12345678-1234-\d{4}-\d{4}-123456789012|xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)\b/i;

/**
 * A value that actually looks like a personalisation value rather than a type
 * annotation. `timezone: str` is a schema; `timezone: America/New_York` is a
 * rendered value that splits your cache per user.
 */
const PERSONAL_VALUE =
  /(?:\b(?:en|fr|de|es|it|pt|ja|ko|zh|hi|ar|ru|nl|sv|pl|tr|id|vi|th)(?:[-_][A-Za-z]{2,4})?\b|\b(?:USD|EUR|GBP|INR|JPY|CAD|AUD|CHF|CNY|SEK|NOK|DKK|SGD|HKD)\b|(?:America|Europe|Asia|Australia|Africa|Pacific|Atlantic)\/[A-Z][A-Za-z_]+|\b(?:enterprise|business|premium|pro|starter|free|team|trial|paid|basic)\b)/i;

/**
 * An HTTP endpoint or URL path. `GET /v1/sessions/{session_id}/events` is API
 * documentation, not a rendered identifier in the prefix.
 */
const ENDPOINT =
  /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|https?:\/\/|\/[a-z0-9_\-]+\/[a-z0-9_\-{}]+\/|\bcurl\b|endpoint|route|api path)/i;

/* An actual rendered date/time value: a weekday, an ISO date, or a clock. */
/**
 * A line that illustrates behaviour rather than stating live state. System
 * prompts routinely teach date handling with a worked example containing a
 * hardcoded date ("Example: If today is 2026-08-20 ..."). That date is frozen
 * documentation, not a per-request value, so it cannot break a cache.
 * Measured on the 236-prompt corpus: excluding these removes exactly one
 * finding and it was the only false positive the rule produced.
 */
const ILLUSTRATIVE =
  /^\s*(?:[-*>#]+\s*)*(?:example|e\.g\.|for example|for instance|sample|illustration|walkthrough|scenario)\b/i;

/** NEGATED or an illustrative/example line. */
const NEGATED_OR_ILLUSTRATIVE = new RegExp(
  '(?:' + NEGATED.source + ')|(?:' + ILLUSTRATIVE.source + ')',
  NEGATED.flags.includes('i') ? NEGATED.flags : NEGATED.flags + 'i',
);

const DATE_VALUE =
  /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\{\{|\{%|\$\{|<[a-z_]+>|\{[a-z_]+\})/i;

function firstIndex(text, patterns) {
  let best = -1;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function lineOf(text, index) {
  if (index < 0) return 0;
  return text.slice(0, index).split('\n').length;
}

function trimLine(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  const line = text.slice(start, end).trim();
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

/* ------------------------------------------------------------------ */
/* Cost model                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cost of the cached-prefix tokens for one month of traffic.
 *
 * writesPerDay models how often the cache has to be rebuilt: once per TTL
 * window that actually sees traffic. That is the honest way to cost a write
 * premium rather than pretending the first call is the only one.
 */
export function costModel({ provider, prefixTokens, requestsPerDay, hitRate, ttlMinutes = 5 }) {
  const prefixM = prefixTokens / 1e6;
  const base = provider.baseInputPerM;
  const readRate = base * provider.readMult;
  const writeRate = base * provider.writeMult;

  const reqPerMonth = requestsPerDay * 30;

  // Writes: one per TTL window with traffic, per day, capped at request count.
  const windowsPerDay = Math.max(1, Math.ceil((24 * 60) / ttlMinutes));
  const writesPerDay = Math.min(requestsPerDay, windowsPerDay);
  const writesPerMonth = writesPerDay * 30;

  const readsPerMonth = reqPerMonth * hitRate;
  const missesPerMonth = reqPerMonth * (1 - hitRate);

  const readCost = readsPerMonth * prefixM * readRate;
  // A miss re-processes the prefix at full input price.
  const missCost = missesPerMonth * prefixM * base;
  // Writes happen regardless, because every window's first call populates.
  const writeCost = writesPerMonth * prefixM * writeRate;

  const total = readCost + missCost + writeCost;
  const noCache = reqPerMonth * prefixM * base;

  return {
    prefixTokens,
    requestsPerMonth: reqPerMonth,
    hitRate,
    readCost,
    missCost,
    writeCost,
    total,
    noCache,
    savingsVsNoCache: Math.max(0, noCache - total),
    perRequest: reqPerMonth ? total / reqPerMonth : 0,
    effectivePerMtok: prefixTokens ? total / (prefixM * reqPerMonth || 1) : 0,
    rates: { base, readRate, writeRate },
  };
}

/* ------------------------------------------------------------------ */
/* The auditor                                                         */
/* ------------------------------------------------------------------ */

const SEVERITY_WEIGHT = { critical: 40, high: 22, medium: 9, low: 4, info: 0 };

/**
 * @param {object} input
 * @param {string} input.systemPrompt  the cached prefix (system + tools + docs)
 * @param {string} [input.userMessage] the volatile suffix
 * @param {string} [input.providerKey]
 * @param {object} [input.priceOverrides]
 * @param {number} [input.requestsPerDay]
 * @param {number} [input.gapMinutes]
 * @param {string} [input.ttl]           '5m' | '1h'
 * @param {boolean} [input.hasBreakpoint]
 * @param {boolean} [input.logsCacheTokens]
 */
export function audit(input) {
  const systemPrompt = input.systemPrompt ?? '';
  const userMessage = input.userMessage ?? '';
  const provider = resolveProvider(
    input.providerKey || 'anthropic',
    input.priceOverrides || {},
  );

  const prefixTokens = estimateTokens(systemPrompt);
  const userTokens = estimateTokens(userMessage);
  const ttlMinutes = input.ttl === '1h' ? 60 : 5;

  // Detection runs on the code-masked text; token counts and evidence
  // snippets still come from the original, because offsets are preserved.
  const ignoreCode = input.ignoreCodeBlocks !== false;
  const scanText = ignoreCode ? maskCodeBlocks(systemPrompt) : systemPrompt;

  const ctx = {
    prefixTokens,
    userTokens,
    provider,
    options: {
      hasBreakpoint: Boolean(input.hasBreakpoint),
      // True only when we parsed a real API request and could look for the
      // marker. Plain prose cannot carry cache_control, so its absence there
      // is a hint, not a defect.
      breakpointKnown: Boolean(input.breakpointKnown),
      logsCacheTokens: Boolean(input.logsCacheTokens),
      gapMinutes: input.gapMinutes,
      ttl: input.ttl || '5m',
    },
  };

  const findings = [];
  for (const r of RULES) {
    let evidence = [];
    if (typeof r.detect === 'function') {
      // detect() may run against masked text; snippets are re-lifted from the
      // original below using the preserved offsets.
      evidence = r.detect(scanText, systemPrompt) || [];
    }
    let severityOverride = null;
    if (typeof r.evaluate === 'function') {
      const extra = r.evaluate(ctx);
      if (extra && extra.evidence) {
        evidence = evidence.concat(extra.evidence);
        if (extra.severity) severityOverride = extra.severity;
      }
    }
    if (!evidence.length) continue;
    findings.push({
      id: r.id,
      severity: severityOverride || r.severity,
      title: r.title,
      why: r.why,
      fix: r.fix,
      evidence: dedupeEvidence(evidence),
      wastedPrefixShare: r.wastedPrefixShare,
    });
  }

  findings.sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.evidence.length - a.evidence.length,
  );

  /* --- derive the hit rate this prompt would actually get ---------- */
  // Position matters. A timestamp at byte 40 of a 40,000-byte prefix kills the
  // cache for essentially everything. The same timestamp as the final line,
  // after a cache breakpoint, only costs the suffix. Weight position-sensitive
  // rules by how much of the prefix sits at or after the offending byte.
  const len = Math.max(1, systemPrompt.length);
  for (const f of findings) {
    const rule = RULES.find((r) => r.id === f.id);
    if (!rule || !rule.positionSensitive) continue;
    const offsets = f.evidence.map((e) => e.offset).filter((o) => typeof o === 'number' && o > 0);
    if (!offsets.length) continue;
    const earliest = Math.min(...offsets);
    const shareAfter = 1 - earliest / len;
    // Never below 5%: even a trailing volatile line forces one extra write.
    f.wastedPrefixShare = Math.max(0.05, Math.min(1, shareAfter));
    f.atOffset = earliest;
    f.atPercent = Math.round((earliest / len) * 100);
  }

  // A prefix can only be reused from the first stable byte onward.
  const maxWaste = findings.reduce((m, f) => Math.max(m, f.wastedPrefixShare || 0), 0);
  const structuralHitRate = Math.max(0, 1 - maxWaste);

  // Below the minimum there is no cache at all, whatever the structure says.
  const belowMinimum = findings.some((f) => f.id === 'below-minimum');
  const noBreakpoint = findings.some((f) => f.id === 'no-breakpoint');
  let hitRate = structuralHitRate;
  if (belowMinimum || noBreakpoint) hitRate = 0;

  // Real traffic never achieves a perfect 1.0: TTL expiry and cold starts
  // take a bite. Cap a structurally-clean prompt at 0.92.
  hitRate = Math.min(hitRate, 0.92);

  const requestsPerDay = Number(input.requestsPerDay) || 1000;

  const broken = costModel({ provider, prefixTokens, requestsPerDay, hitRate, ttlMinutes });
  const fixedHitRate = prefixTokens >= provider.minTokens ? 0.88 : 0;
  const repaired = costModel({ provider, prefixTokens, requestsPerDay, hitRate: fixedHitRate, ttlMinutes });

  const monthlyWaste = Math.max(0, broken.total - repaired.total);
  const annualWaste = monthlyWaste * 12;

  /* --- score -------------------------------------------------------- */
  const { score, grade } = scoreFindings(findings);

  return {
    version: VERSION,
    provider,
    prefixTokens,
    userTokens,
    totalTokens: prefixTokens + userTokens,
    findings,
    counts: countSeverities(findings),
    hitRate,
    fixedHitRate,
    cost: broken,
    repairedCost: repaired,
    monthlyWaste,
    annualWaste,
    score,
    grade,
    verdict: verdictFor(score, monthlyWaste),
  };
}

/** Shared scoring so audit() and auditPayload() cannot drift apart. */
function scoreFindings(findings) {
  let score = 100;
  for (const f of findings) {
    score -= SEVERITY_WEIGHT[f.severity] * (f.wastedPrefixShare > 0 ? 1 : 0.5);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade };
}

function countSeverities(findings) {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };
}

function verdictFor(score, monthlyWaste) {
  if (score >= 90 && monthlyWaste < 50) {
    return 'Prefix is stable. You are getting the cached price.';
  }
  if (monthlyWaste >= 1000) {
    return `Fixable. You are re-billing a cached prefix at full input price, roughly $${Math.round(monthlyWaste).toLocaleString()}/month.`;
  }
  if (score < 55) {
    return 'This prefix will not cache reliably. Fix the critical findings first.';
  }
  return 'Some structural risk in the prefix. Worth a look before it scales.';
}

/* ------------------------------------------------------------------ */
/* Auto-fix: relocate volatile content out of the cached prefix        */
/* ------------------------------------------------------------------ */

/**
 * Rewrites a prefix so volatile lines move to the trailing suffix.
 * Deliberately conservative: it only MOVES lines it is confident about,
 * and it tells you what it moved. It never deletes content.
 */
export function autoFix(systemPrompt) {
  const lines = String(systemPrompt ?? '').split('\n');
  const kept = [];
  const moved = [];

  const volatileLine =
    /^\s*(?:[-*#>]\s*)?(?:current|today'?s)?\s*(?:date|time|datetime)(?:\s+and\s+(?:date|time))?\s*[:=]/i;
  const volatileTemplate =
    /\{\{\s*(?:now|date|time|today|current[_-]?date|current[_-]?time|timestamp|request[_-]?id|session[_-]?id|user[_-]?name)\s*\}\}/i;
  const volatileId = /^\s*(?:[-*#>]\s*)?(?:request|session|trace|correlation)[_-]?id\s*[:=]/i;
  const volatileIdentity = /^\s*(?:[-*#>]\s*)?(?:the user'?s name is|user name|customer name)\s*[:=]?/i;
  const volatilePrefs =
    /^\s*(?:[-*#>]\s*)?(?:user|account|customer)?\s*(?:locale|language|timezone|time zone|currency|plan|tier)\s*[:=]/i;

  for (const line of lines) {
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    if (
      volatileLine.test(line) ||
      volatileTemplate.test(line) ||
      volatileId.test(line) ||
      volatileIdentity.test(line) ||
      volatilePrefs.test(line)
    ) {
      moved.push(line);
    } else {
      kept.push(line);
    }
  }

  if (!moved.length) {
    return { changed: false, systemPrompt: String(systemPrompt ?? ''), suffixBlock: '', movedLines: [] };
  }

  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const suffixBlock =
    '<volatile-context>\n' +
    moved.map((l) => l.replace(/^\s*[-*#>]\s*/, '').trim()).filter(Boolean).join('\n') +
    '\n</volatile-context>';

  return { changed: true, systemPrompt: cleaned, suffixBlock, movedLines: moved };
}

/* ------------------------------------------------------------------ */
/* Multi-sample prefix-stability check (the real cache-break detector) */
/* ------------------------------------------------------------------ */

/**
 * Given N rendered prefixes from the same code path, find the first byte
 * that diverges and how much of the prefix it invalidates.
 * This is what catches the bug a linter cannot see.
 */
export function prefixStability(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { ok: false, reason: 'need at least 2 samples' };
  }
  const [first, ...rest] = samples.map((s) => String(s));
  let breakAt = first.length;
  let breakSample = -1;

  for (let i = 0; i < rest.length; i += 1) {
    const s = rest[i];
    const n = Math.min(first.length, s.length);
    let j = 0;
    while (j < n && first[j] === s[j]) j += 1;
    if (j < breakAt) {
      breakAt = j;
      breakSample = i + 2;
    }
  }

  const stableTokens = estimateTokens(first.slice(0, breakAt));
  const totalTokens = estimateTokens(first);
  const stableShare = totalTokens ? stableTokens / totalTokens : 0;

  return {
    ok: breakAt >= first.length,
    samples: samples.length,
    breakAt,
    breakSample,
    breakContext: first.slice(Math.max(0, breakAt - 40), breakAt + 40),
    stableTokens,
    totalTokens,
    stableShare,
    hitRateCeiling: Math.max(0, Math.min(1, stableShare)),
  };
}

/* ---- R13: non-deterministic serialisation of prefix content ------- */
/**
 * Scope note, learned the hard way: a rendered prompt almost never contains
 * `json.dumps` — that lives in the code that BUILDS the prompt, and code
 * blocks are masked before detection so such a branch can never fire. What a
 * single rendered prompt CAN show is (a) a template variable that resolves to
 * a fresh random value every call, and (b) an embedded JSON blob whose keys
 * are not in a stable order. Both mean the prefix bytes are not a function of
 * the prompt's meaning alone. Anything subtler belongs to the stability diff
 * (`prefixStability`), which compares two renders.
 */
rule({
  id: 'unstable-serialisation',
  positionSensitive: true,
  severity: 'medium',
  title: 'Prefix content is serialised non-deterministically',
  wastedPrefixShare: 0.85,
  why:
    'If the prefix embeds a random or freshly generated value, or a structure ' +
    'serialised in an unstable key order, logically identical input produces ' +
    'different bytes. The cache key changes and the whole prefix re-bills, ' +
    'even though nothing meaningful changed.',
  fix:
    'Serialise with a stable order (sorted keys or a fixed key list) and keep ' +
    'random or generated values out of the cached span. Hash the rendered ' +
    'prefix in CI and fail on a change you did not intend.',
  detect(text, source) {
    const hits = collect(
      text,
      [
        {
          label: 'random value interpolated into the prefix',
          re: /\{\{\s*(?:random|rand|nonce|uuid|guid|request_?id|trace_?id|correlation_?id)[\w.]*\s*\}\}|\$\{\s*(?:Math\.random\(\)|crypto\.randomUUID\(\)|nanoid\(\)|uuid4?\(\)|random\(\))[^}]*\}/gi,
          rejectLine: NEGATED,
        },
      ],
      source,
    );

    // NOTE: an earlier revision also flagged embedded JSON blobs whose keys
    // were not in sorted order. Measured against the 236-prompt corpus it
    // fired twice and was wrong twice — both hits were JSON *examples* inside
    // documentation, not serialised runtime state. System prompts are full of
    // illustrative JSON, so that heuristic cannot be made precise from a
    // single rendered prompt. It is deliberately not shipped. Key-order
    // instability is instead caught by comparing two renders (prefixStability).
    return hits;
  },
});

/* ---- R14: the cached prefix is larger than it needs to be --------- */
rule({
  id: 'prefix-bloat',
  severity: 'medium',
  title: 'The cached prefix is far larger than it needs to be',
  wastedPrefixShare: 0.4,
  why:
    'Every cached token is re-read on every request at the read rate, and the ' +
    'whole span is rewritten on every miss. Reference material that the model ' +
    'only occasionally needs is being paid for on every single call, and it ' +
    'also pushes up latency. Duplicated blocks pay for themselves twice.',
  fix:
    'Move reference material, long examples and rarely-used policy behind a ' +
    'tool or a retrieval step so it is fetched on demand. Delete duplicated ' +
    'sections. Keep the cached span to the instructions that apply to every ' +
    'request.',
  detect(text, source) {
    const findings = [];
    // `text` is the code-masked scan text: maskCodeBlocks replaces code with
    // spaces so offsets survive, but the token estimate of a page of spaces is
    // not the token estimate of the prompt. Always count on the original, or
    // this rule quotes a different number than the rest of the report.
    const original = source || text;
    const tokens = estimateTokens(original);
    const BLOAT = 32000;
    if (tokens >= BLOAT) {
      findings.push({
        line: 0,
        offset: 0,
        snippet: `prefix is ~${tokens.toLocaleString()} tokens; above ~${BLOAT.toLocaleString()} every call re-reads it`,
        label: 'oversized cached prefix',
        count: 1,
      });
    }
    // Verbatim duplication: a real and unambiguous bloat signal. Scan the
    // masked text so identical code samples do not count as duplicated prose.
    const paras = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 160);
    const seen = new Map();
    let dupes = 0;
    let firstDupe = -1;
    for (const p of paras) {
      const k = p.slice(0, 240);
      if (seen.has(k)) {
        dupes += 1;
        if (firstDupe === -1) firstDupe = text.indexOf(p);
      } else {
        seen.set(k, 1);
      }
    }
    if (dupes > 0) {
      findings.push({
        line: firstDupe >= 0 ? lineOf(original, firstDupe) : 0,
        offset: firstDupe >= 0 ? firstDupe : 0,
        snippet: `${dupes} paragraph${dupes === 1 ? '' : 's'} appear verbatim more than once`,
        label: 'duplicated blocks in the prefix',
        count: dupes,
      });
    }
    return findings;
  },
});

export const RULE_CATALOG = RULES.map((r) => ({
  id: r.id,
  severity: r.severity,
  title: r.title,
  why: r.why,
  fix: r.fix,
}));
