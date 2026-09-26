import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  audit,
  autoFix,
  prefixStability,
  costModel,
  resolveProvider,
  RULE_CATALOG,
} from '../src/engine.mjs';

/* ---------------- token estimator ---------------- */

test('estimateTokens: empty and non-string inputs are zero', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(42), 0);
});

test('estimateTokens: plain English lands near 4 chars/token', () => {
  const text = 'The quick brown fox jumps over the lazy dog while the sun sets slowly.';
  const t = estimateTokens(text);
  const naive = text.length / 4;
  // Should be in the same ballpark as the naive estimate for prose.
  assert.ok(t > naive * 0.6 && t < naive * 1.8, `got ${t}, naive ${naive}`);
});

test('estimateTokens: camelCase identifiers split into more tokens than naive', () => {
  const camel = 'getCustomerAccountBalanceForBillingPeriodAndUpdateLedgerEntry';
  const t = estimateTokens(camel);
  // One 62-char identifier is definitely more than one token.
  assert.ok(t >= 6, `expected camelCase to split, got ${t}`);
});

test('estimateTokens: monotonic in length', () => {
  const short = estimateTokens('You are a helpful assistant.');
  const long = estimateTokens('You are a helpful assistant. '.repeat(50));
  assert.ok(long > short * 10, `short=${short} long=${long}`);
});

/* ---------------- the critical detector: timestamps ---------------- */

test('audit: a rendered timestamp in the prefix is a critical finding', () => {
  const systemPrompt =
    'You are a support agent.\nCurrent date and time: 2026-09-22T14:03:11Z\n' +
    'Follow the escalation policy below.\n'.padEnd(6000, 'x ');
  const res = audit({ systemPrompt, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });

  const f = res.findings.find((x) => x.id === 'dynamic-timestamp');
  assert.ok(f, 'expected a dynamic-timestamp finding');
  assert.equal(f.severity, 'critical');
  assert.ok(f.evidence.length > 0);
  // Near zero, not exactly zero: the timestamp sits ~25 bytes into a ~6KB
  // prefix, so a sliver of the prefix is still reusable.
  assert.ok(res.hitRate < 0.05, `hitRate was ${res.hitRate}`);
});

test('audit: a clean static prefix gets a high score and no critical findings', () => {
  const systemPrompt = (
    'You are a support agent for Acme Corp.\n' +
    'Rules:\n- Be concise.\n- Never invent policy.\n- Escalate billing disputes.\n'
  ).padEnd(6000, 'Follow the policy handbook precisely. ');

  const res = audit({
    systemPrompt,
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
    requestsPerDay: 1000,
  });

  assert.equal(res.counts.critical, 0, JSON.stringify(res.findings.map((f) => f.id)));
  assert.ok(res.hitRate > 0.8, `hitRate was ${res.hitRate}`);
  assert.ok(res.score >= 85, `score was ${res.score}`);
});

/* ---------------- below the minimum ---------------- */

test('audit: a prefix under the provider minimum cannot cache at all', () => {
  const res = audit({
    systemPrompt: 'You are a helpful assistant.',
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
  });
  const f = res.findings.find((x) => x.id === 'below-minimum');
  assert.ok(f, 'expected a below-minimum finding');
  assert.equal(res.hitRate, 0);
  assert.equal(res.repairedCost.hitRate ?? res.fixedHitRate, 0);
});

/* ---------------- no breakpoint (Anthropic only) ---------------- */

test('audit: missing cache_control on Anthropic is critical and zeroes hit rate', () => {
  const systemPrompt = 'You are a support agent.\n'.padEnd(6000, 'Follow policy. ');
  const res = audit({ systemPrompt, providerKey: 'anthropic', hasBreakpoint: false, logsCacheTokens: true });
  const f = res.findings.find((x) => x.id === 'no-breakpoint');
  assert.ok(f, 'expected a no-breakpoint finding');
  assert.equal(res.hitRate, 0);
});

test('audit: missing breakpoint is NOT flagged on OpenAI (caching is automatic)', () => {
  const systemPrompt = 'You are a support agent.\n'.padEnd(6000, 'Follow policy. ');
  const res = audit({ systemPrompt, providerKey: 'openai', hasBreakpoint: false, logsCacheTokens: true });
  assert.equal(res.findings.find((x) => x.id === 'no-breakpoint'), undefined);
});

/* ---------------- per-request ids ---------------- */

test('audit: a request id in the prefix is critical', () => {
  const systemPrompt = 'You are an agent.\nrequest_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f\n'.padEnd(6000, 'Rules. ');
  const res = audit({ systemPrompt, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = res.findings.find((x) => x.id === 'volatile-id');
  assert.ok(f, JSON.stringify(res.findings.map((x) => x.id)));
  assert.equal(f.severity, 'critical');
});

/* ---------------- mutable memory ---------------- */

test('audit: a working-memory heading in the system prompt is flagged high', () => {
  const systemPrompt = 'You are an agent.\n\n## Working memory\n- nothing yet\n'.padEnd(6000, 'Rules. ');
  const res = audit({ systemPrompt, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = res.findings.find((x) => x.id === 'mutable-memory-in-prefix');
  assert.ok(f, JSON.stringify(res.findings.map((x) => x.id)));
});

/* ---------------- ordering ---------------- */

test('audit: volatile content before the role statement is an ordering finding', () => {
  const systemPrompt =
    'Current date: 2026-09-22\n\nYou are a support agent.\nFollow policy.\n'.padEnd(6000, 'Rules. ');
  const res = audit({ systemPrompt, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(res.findings.some((x) => x.id === 'ordering'));
});

/* ---------------- cost model ---------------- */

test('costModel: a working cache is far cheaper than no cache', () => {
  const provider = resolveProvider('anthropic');
  const noCache = costModel({ provider, prefixTokens: 20000, requestsPerDay: 5000, hitRate: 0 });
  const cached = costModel({ provider, prefixTokens: 20000, requestsPerDay: 5000, hitRate: 0.9 });
  assert.ok(cached.total < noCache.total, `cached ${cached.total} vs noCache ${noCache.total}`);
  // Sanity: 20k tokens x 5000/day x 30 = 3B tokens/month = 3000 MTok.
  // At $3/MTok with no cache that is $9,000.
  assert.ok(Math.abs(noCache.noCache - 9000) < 1, `noCache.noCache=${noCache.noCache}`);
});

test('costModel: monthly waste is positive for a broken prompt at real volume', () => {
  const res = audit({
    systemPrompt: 'You are an agent.\nCurrent date: 2026-09-22\n'.padEnd(20000, 'Rules. '),
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
    requestsPerDay: 5000,
  });
  assert.ok(res.monthlyWaste > 1000, `monthlyWaste=${res.monthlyWaste}`);
});

test('costModel: zero requests costs nothing', () => {
  const provider = resolveProvider('openai');
  const c = costModel({ provider, prefixTokens: 5000, requestsPerDay: 0, hitRate: 0.9 });
  assert.equal(c.total, 0);
});

/* ---------------- auto-fix ---------------- */

test('autoFix: moves a rendered date out of the prefix into a suffix block', () => {
  const input = 'You are a support agent.\nCurrent date: 2026-09-22\nFollow policy.';
  const out = autoFix(input);
  assert.equal(out.changed, true);
  assert.ok(!out.systemPrompt.includes('Current date'), out.systemPrompt);
  assert.ok(out.suffixBlock.includes('Current date: 2026-09-22'), out.suffixBlock);
  assert.equal(out.movedLines.length, 1);
});

test('autoFix: leaves a clean prefix untouched', () => {
  const input = 'You are a support agent.\nFollow policy.';
  const out = autoFix(input);
  assert.equal(out.changed, false);
  assert.equal(out.systemPrompt, input);
});

test('autoFix: never deletes content — every input line survives somewhere', () => {
  const input = 'Line one.\nCurrent time: 14:03\nLine three.\nsession_id: abc-123\nLine five.';
  const out = autoFix(input);
  const all = out.systemPrompt + '\n' + out.suffixBlock;
  for (const probe of ['Line one', 'Line three', 'Line five']) {
    assert.ok(all.includes(probe), `lost ${probe}`);
  }
});

test('autoFix: fixing a timestamp prompt actually raises the audit score', () => {
  const broken = 'You are an agent.\nCurrent date: 2026-09-22\n'.padEnd(8000, 'Rules. ');
  const before = audit({ systemPrompt: broken, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const fixed = autoFix(broken);
  const after = audit({ systemPrompt: fixed.systemPrompt, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(after.hitRate > before.hitRate, `${before.hitRate} -> ${after.hitRate}`);
});

/* ---------------- prefix stability ---------------- */

test('prefixStability: identical samples are stable', () => {
  const p = 'You are an agent. Follow policy.';
  const r = prefixStability([p, p, p]);
  assert.equal(r.ok, true);
  assert.equal(r.hitRateCeiling, 1);
});

test('prefixStability: localises the first divergent byte', () => {
  const a = 'You are an agent. Current date: 2026-09-22. Follow policy.';
  const b = 'You are an agent. Current date: 2026-09-23. Follow policy.';
  const r = prefixStability([a, b]);
  assert.equal(r.ok, false);
  assert.equal(r.breakSample, 2);
  assert.ok(r.stableShare < 1);
  assert.ok(r.stableShare > 0);
  assert.ok(r.breakContext.includes('Current date'));
});

test('prefixStability: rejects fewer than two samples', () => {
  assert.equal(prefixStability(['only one']).ok, false);
  assert.equal(prefixStability([]).ok, false);
});

/* ---------------- catalogue / regression guard ---------------- */

test('rule catalogue is exported and every rule has a fix', () => {
  assert.ok(RULE_CATALOG.length >= 10, `only ${RULE_CATALOG.length} rules`);
  for (const r of RULE_CATALOG) {
    assert.ok(r.title && r.why && r.fix, `rule ${r.id} missing copy`);
  }
});

test('audit: result shape is stable for consumers', () => {
  const res = audit({ systemPrompt: 'You are an agent.', providerKey: 'openai' });
  for (const key of ['score', 'grade', 'hitRate', 'findings', 'cost', 'monthlyWaste', 'verdict']) {
    assert.ok(key in res, `missing ${key}`);
  }
  assert.ok(res.grade.length === 1);
  assert.ok(res.score >= 0 && res.score <= 100);
});

/* ---------------- autoFix: regression coverage for real phrasings -------- */

test('autoFix: handles "Current date and time:" (the wording that broke v0.1)', () => {
  const out = autoFix('You are an agent.\nCurrent date and time: 2026-09-22T14:03:11Z\nFollow policy.');
  assert.equal(out.changed, true);
  assert.ok(!out.systemPrompt.includes('Current date'), out.systemPrompt);
  assert.ok(out.suffixBlock.includes('2026-09-22T14:03:11Z'), out.suffixBlock);
});

test('autoFix: moves locale/timezone/currency preference lines', () => {
  const out = autoFix('You are an agent.\nUser locale: en-IN, timezone: Asia/Kolkata, currency: INR\nFollow policy.');
  assert.equal(out.changed, true);
  assert.ok(out.suffixBlock.includes('Asia/Kolkata'));
});

test('autoFix: moves identity and id lines together', () => {
  const out = autoFix(
    "You are an agent.\nThe user's name is Priya Sharma\nrequest_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f\nFollow policy.",
  );
  assert.equal(out.changed, true);
  assert.equal(out.movedLines.length, 2, JSON.stringify(out.movedLines));
  assert.ok(!out.systemPrompt.includes('Priya'));
  assert.ok(!out.systemPrompt.includes('8f14e45f'));
});

test('autoFix: does not move a policy line that merely mentions a date', () => {
  const out = autoFix(
    'You are an agent.\nRefunds after the cutoff date are handled by the legacy team.\nFollow policy.',
  );
  assert.equal(out.changed, false, 'a sentence mentioning "date" is not a rendered date field');
});

test('autoFix: every volatile phrasing in the broken sample gets relocated', () => {
  const broken = `You are a senior support agent for Acme Billing.

Current date and time: 2026-09-22T14:03:11Z
request_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f
The user's name is Priya Sharma
User locale: en-IN, timezone: Asia/Kolkata, currency: INR

## Policy
Verify identity first.`;
  const out = autoFix(broken);
  assert.equal(out.movedLines.length, 4, JSON.stringify(out.movedLines));
  assert.ok(out.systemPrompt.includes('## Policy'));
  assert.ok(out.systemPrompt.includes('Verify identity first'));
});


/* ---------------- position weighting ---------------- */

test('position: a timestamp at the TOP of the prefix is far worse than one at the end', () => {
  const body = 'Follow the policy handbook precisely and never speculate about internals. '.repeat(80);
  const early = 'Current date: 2026-09-22\n' + body;
  const late = body + '\nCurrent date: 2026-09-22';

  const a = audit({ systemPrompt: early, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const b = audit({ systemPrompt: late, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });

  assert.ok(a.findings.some((f) => f.id === 'dynamic-timestamp'));
  assert.ok(b.findings.some((f) => f.id === 'dynamic-timestamp'));
  assert.ok(
    b.hitRate > a.hitRate + 0.5,
    `a trailing timestamp should cache far better: top=${a.hitRate} end=${b.hitRate}`,
  );
  assert.ok(a.monthlyWaste > b.monthlyWaste, 'the early timestamp should model more waste');
});

test('position: findings expose where the offending byte is', () => {
  const res = audit({
    systemPrompt: 'Header text here.\nCurrent date: 2026-09-22\n' + 'Body. '.repeat(300),
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
  });
  const f = res.findings.find((x) => x.id === 'dynamic-timestamp');
  assert.ok(typeof f.atOffset === 'number', 'expected atOffset on a position-sensitive finding');
  assert.ok(f.atOffset > 0 && f.atOffset < 40, `offset was ${f.atOffset}`);
  assert.equal(typeof f.atPercent, 'number');
});

test('position: non-position-sensitive rules keep a fixed weight', () => {
  const res = audit({
    systemPrompt: 'You are an agent.',
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
  });
  const f = res.findings.find((x) => x.id === 'below-minimum');
  assert.equal(f.wastedPrefixShare, 1.0);
  assert.equal(f.atOffset, undefined);
});

/* ==================== unstable-serialisation ==================== */

// Design decision, pinned by these two tests: `json.dumps` lives in the code
// that BUILDS the prompt, and code blocks are masked before detection, so a
// detector for it can never fire on a rendered prompt. Auditing builder code
// is a different product. Do not "fix" this by un-masking code blocks.
test('unstable-serialisation: json.dumps in a fenced code block is NOT flagged', () => {
  const text =
    'You are an agent.\n\n```py\nsystem_prompt = "Context: " + json.dumps(state)\n```\n' +
    'Filler policy line that is long enough to be a real instruction. '.repeat(40);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(!r.findings.some((f) => f.id === 'unstable-serialisation'), r.findings.map((f) => f.id).join(','));
});

test('unstable-serialisation: a random value interpolated into the prompt is flagged', () => {
  const text =
    'You are an agent. Your request is {{random}}.\n' +
    'Filler policy line that is long enough to be a real instruction. '.repeat(40);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = r.findings.find((x) => x.id === 'unstable-serialisation');
  assert.ok(f, r.findings.map((x) => x.id).join(','));
  assert.match(f.evidence[0].label, /random value/i);
});

test('unstable-serialisation: an unrelated json.dumps in a doc is not flagged', () => {
  const text =
    'You are an agent.\n\n## API reference\n\n```py\nresponse = json.dumps(payload)\n```\n' +
    'Filler policy line that is long enough to be a real instruction. '.repeat(40);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(!r.findings.some((f) => f.id === 'unstable-serialisation'));
});

/* ======================= prefix-bloat ======================= */

test('prefix-bloat: a very large prefix is flagged', () => {
  const text = 'Policy. '.repeat(20000);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = r.findings.find((x) => x.id === 'prefix-bloat');
  assert.ok(f, r.findings.map((x) => x.id).join(','));
  assert.ok(f.evidence.some((e) => e.label === 'oversized cached prefix'));
});

test('prefix-bloat: quotes the same token count as the rest of the report', () => {
  // Regression: detect() receives code-masked text, whose token estimate
  // differs from the real prompt. The rule must count the original.
  const code = '```\n' + 'const x = someLongIdentifier + anotherLongIdentifier;\n'.repeat(400) + '\n```\n';
  const text = code + 'Policy. '.repeat(20000);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = r.findings.find((x) => x.id === 'prefix-bloat');
  assert.ok(f, 'expected the rule to fire');
  const snippet = f.evidence.find((e) => e.label === 'oversized cached prefix').snippet;
  assert.ok(
    snippet.includes(r.prefixTokens.toLocaleString()),
    `snippet "${snippet}" should quote prefixTokens ${r.prefixTokens}`,
  );
});

test('prefix-bloat: verbatim duplicated paragraphs are flagged', () => {
  const block =
    'When the customer asks for a refund you must first verify the invoice identifier, ' +
    'then confirm the settled amount against the ledger, and only then issue the credit. ' +
    'Never guess at an amount and never promise a date that is not published.\n\n';
  const text = 'You are an agent.\n\n' + block.repeat(4) + 'Policy. '.repeat(2000);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = r.findings.find((x) => x.id === 'prefix-bloat');
  assert.ok(f, r.findings.map((x) => x.id).join(','));
  assert.ok(f.evidence.some((e) => e.label === 'duplicated blocks in the prefix'));
});

test('prefix-bloat: a normal-sized prompt with no duplication is clean', () => {
  const text =
    'You are an agent.\n\n' +
    Array.from({ length: 30 }, (_, i) => `Rule ${i}: a distinct instruction about handling case ${i} carefully.\n\n`).join('');
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(!r.findings.some((f) => f.id === 'prefix-bloat'), JSON.stringify(r.findings.map((f) => f.id)));
});

test('prefix-bloat: identical short code samples are not "duplicated prose"', () => {
  const fence = '```sh\nnpm install\n```\n\n';
  const text = 'You are an agent.\n\n' + fence.repeat(5) + 'Policy. '.repeat(2000);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  const f = r.findings.find((x) => x.id === 'prefix-bloat');
  const dupe = f && f.evidence.find((e) => e.label === 'duplicated blocks in the prefix');
  assert.ok(!dupe, 'code masking should suppress this');
});

/* =================== catalogue completeness =================== */

test('RULE_CATALOG exposes every rule the engine defines', () => {
  // Regression: the docs advertised 14 rules while only 12 existed.
  assert.equal(RULE_CATALOG.length, 14, `catalogue has ${RULE_CATALOG.length}`);
  for (const id of ['prefix-bloat', 'unstable-serialisation', 'no-breakpoint']) {
    assert.ok(RULE_CATALOG.some((r) => r.id === id), `${id} missing from catalogue`);
  }
});

// The embedded-JSON heuristic was implemented, measured against the 236-prompt
// corpus, and removed: it fired twice and was wrong twice (both were JSON
// examples in documentation). This pins the decision so it is not re-added.
test('unstable-serialisation: illustrative JSON in a prompt is NOT flagged', () => {
  const text =
    'You are an agent. Return JSON like this:\n\n' +
    '{\n  "zebra": 1,\n  "alpha": 2,\n  "monkey": 3,\n  "beta": 4\n}\n\n' +
    'Filler policy line that is long enough to be a real instruction. '.repeat(40);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(!r.findings.some((f) => f.id === 'unstable-serialisation'), r.findings.map((f) => f.id).join(','));
});

test('unstable-serialisation: still fires on a random template variable', () => {
  const text =
    'You are an agent. Trace {{request_id}} applies.\n' +
    'Filler policy line that is long enough to be a real instruction. '.repeat(40);
  const r = audit({ systemPrompt: text, providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true });
  assert.ok(r.findings.some((f) => f.id === 'unstable-serialisation'), r.findings.map((f) => f.id).join(','));
});
