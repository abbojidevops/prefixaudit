/**
 * Request-payload parsing.
 *
 * This is the difference between "did you tick the cache_control box?" and a
 * measurement. The case that matters most is breakpoint PLACEMENT: volatile
 * content before the breakpoint invalidates everything downstream; the same
 * content after it costs only its own write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestPayload, auditPayload, stableStringify, audit } from '../src/engine.mjs';

// Must clear the 1,024-token Anthropic cache minimum, otherwise `below-minimum`
// zeroes the hit rate and every breakpoint assertion below becomes meaningless.
// repeat(60) is 756 tokens — too short. repeat(120) is 1,512.
const POLICY = 'You are a support agent. Verify identity. Never invent policy. '.repeat(120);

/* ------------------------------ detection ------------------------------ */

test('parseRequestPayload: plain text falls through unchanged', () => {
  const p = parseRequestPayload('You are a helpful assistant.\nFollow policy.');
  assert.equal(p.kind, 'text');
  assert.equal(p.prefixText, 'You are a helpful assistant.\nFollow policy.');
  assert.equal(p.hasBreakpoint, false);
});

test('parseRequestPayload: invalid JSON falls back to text instead of throwing', () => {
  const p = parseRequestPayload('{ this is not json');
  assert.equal(p.kind, 'text');
  assert.equal(p.parseError, true);
  assert.ok(p.prefixText.includes('not json'));
});

test('parseRequestPayload: Anthropic string system prompt', () => {
  const p = parseRequestPayload(JSON.stringify({ model: 'claude-opus-4-7', system: POLICY }));
  assert.equal(p.kind, 'request');
  assert.equal(p.provider, 'anthropic');
  assert.equal(p.model, 'claude-opus-4-7');
  assert.equal(p.prefixText, POLICY);
  assert.equal(p.hasBreakpoint, false);
  assert.ok(p.warnings.some((w) => /no cache_control/.test(w)));
});

test('parseRequestPayload: Anthropic block array with cache_control', () => {
  const p = parseRequestPayload(
    JSON.stringify({
      model: 'claude-opus-4-7',
      system: [
        { type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Per-user notes go here.' },
      ],
    }),
  );
  assert.equal(p.hasBreakpoint, true);
  assert.equal(p.breakpointBlock, 0);
  // Breakpoint sits at the end of block 0; block 1 is tiny, so this rounds to 100%.
  assert.ok(p.breakpointPercent >= 95 && p.breakpointPercent <= 100, `percent was ${p.breakpointPercent}`);
  assert.equal(p.warnings.length, 0);
});

test('parseRequestPayload: reads the cache TTL when present', () => {
  const p = parseRequestPayload(
    JSON.stringify({
      system: [{ type: 'text', text: POLICY, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    }),
  );
  assert.equal(p.breakpointTtl, '1h');
});

test('parseRequestPayload: OpenAI instructions are recognised, no marker expected', () => {
  const p = parseRequestPayload(JSON.stringify({ model: 'gpt-5.6', instructions: POLICY, input: 'hi' }));
  assert.equal(p.provider, 'openai');
  assert.equal(p.prefixText, POLICY);
  assert.ok(p.warnings.some((w) => /automatic/i.test(w)), JSON.stringify(p.warnings));
  assert.ok(!p.warnings.some((w) => /no cache_control/.test(w)), 'should not warn about markers on OpenAI');
});

test('parseRequestPayload: tools are prepended to the prefix, as the API orders them', () => {
  const tool = { name: 'look_up', description: 'Find an invoice', input_schema: { type: 'object' } };
  const p = parseRequestPayload(JSON.stringify({ system: POLICY, tools: [tool] }));
  assert.equal(p.toolCount, 1);
  assert.equal(p.prefixBlocks[0].role, 'tools');
  assert.equal(p.prefixBlocks[1].role, 'system');
  assert.ok(p.prefixText.startsWith('{'), 'tools serialise first');
  assert.ok(p.prefixText.includes(POLICY.slice(0, 20)));
});

test('parseRequestPayload: messages are the volatile suffix, not the prefix', () => {
  const p = parseRequestPayload(
    JSON.stringify({ system: POLICY, messages: [{ role: 'user', content: 'Refund INV-4471 please.' }] }),
  );
  assert.equal(p.prefixText, POLICY);
  assert.ok(!p.prefixText.includes('INV-4471'), 'user turn leaked into the prefix');
  assert.ok(p.messageText.includes('INV-4471'));
});

test('parseRequestPayload: a JSON object with no recognisable field warns instead of passing', () => {
  const p = parseRequestPayload(JSON.stringify({ foo: 'bar', baz: 1 }));
  assert.equal(p.kind, 'text');
  assert.equal(p.parseError, true);
  assert.ok(p.warnings.length > 0);
});

/* ------------------------ stable serialisation ------------------------- */

test('stableStringify: key order does not change the output', () => {
  const a = stableStringify({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = stableStringify({ a: 2, c: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b);
});

test('stableStringify: different values do change the output', () => {
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('stableStringify: handles arrays, nulls and primitives', () => {
  assert.equal(stableStringify([1, 'x', null]), '[1,"x",null]');
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(42), '42');
});

test('stableStringify: reordered tool schemas produce an identical prefix', () => {
  const t1 = { name: 'x', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } };
  const t2 = { input_schema: { properties: { a: { type: 'string' } }, type: 'object' }, description: 'd', name: 'x' };
  const p1 = parseRequestPayload(JSON.stringify({ system: 'sys', tools: [t1] }));
  const p2 = parseRequestPayload(JSON.stringify({ system: 'sys', tools: [t2] }));
  assert.equal(p1.prefixText, p2.prefixText, 'key order must not change the cached bytes');
});

/* --------------------- breakpoint placement (the money) ----------------- */

test('auditPayload: volatile content BEFORE the breakpoint is called out', () => {
  const payload = JSON.stringify({
    model: 'claude-opus-4-7',
    system: [
      {
        type: 'text',
        text: 'Current date: 2026-09-22\n\n' + POLICY,
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
  const res = auditPayload(payload);
  assert.ok(res.breakpoint, 'expected breakpoint analysis');
  assert.equal(res.breakpoint.clean, false);
  assert.ok(res.breakpoint.volatileBefore.length > 0);
  assert.match(res.breakpoint.verdict, /BEFORE the breakpoint/);
});

test('auditPayload: volatile content AFTER the breakpoint is fine', () => {
  const payload = JSON.stringify({
    model: 'claude-opus-4-7',
    system: [
      { type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ],
  });
  const res = auditPayload(payload);
  assert.ok(res.breakpoint);
  assert.equal(res.breakpoint.clean, true, JSON.stringify(res.breakpoint.volatileBefore));
  assert.ok(res.breakpoint.volatileAfter.length > 0);
  assert.match(res.breakpoint.verdict, /correctly placed/);
});

test('auditPayload: the same prompt scores better with the breakpoint placed correctly', () => {
  const bad = JSON.stringify({
    system: [{ type: 'text', text: 'Current date: 2026-09-22\n' + POLICY, cache_control: { type: 'ephemeral' } }],
  });
  const good = JSON.stringify({
    system: [
      { type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ],
  });
  const a = auditPayload(bad);
  const b = auditPayload(good);
  assert.ok(b.hitRate > a.hitRate, `good=${b.hitRate} bad=${a.hitRate}`);
});

test('auditPayload: derives hasBreakpoint from the payload, not a checkbox', () => {
  const noBp = auditPayload(JSON.stringify({ system: POLICY }));
  const withBp = auditPayload(
    JSON.stringify({ system: [{ type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } }] }),
  );
  assert.equal(noBp.payload.hasBreakpoint, false);
  assert.equal(withBp.payload.hasBreakpoint, true);
  // No breakpoint on Anthropic means nothing caches at all.
  assert.equal(noBp.hitRate, 0);
  assert.ok(withBp.hitRate > 0.5);
});

test('auditPayload: an explicit hasBreakpoint override still wins', () => {
  const res = auditPayload(JSON.stringify({ system: POLICY }), { hasBreakpoint: true });
  assert.ok(res.hitRate > 0.5, 'override should be honoured');
});

test('auditPayload: a missing marker is not flagged on an OpenAI payload', () => {
  const res = auditPayload(JSON.stringify({ instructions: POLICY }));
  assert.equal(res.findings.some((f) => f.id === 'no-breakpoint'), false);
});

test('auditPayload: code inside the payload is still masked', () => {
  const payload = JSON.stringify({
    system: [{ type: 'text', text: 'Policy.\n```js\nconst t = `${Date.now()}`;\n```\n' + POLICY }],
  });
  const res = auditPayload(payload);
  assert.equal(res.findings.some((f) => f.id === 'dynamic-timestamp'), false);
});

test('auditPayload: breakpoint token split is reported', () => {
  const payload = JSON.stringify({
    system: [
      { type: 'text', text: POLICY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Volatile tail with a session note.' },
    ],
  });
  const res = auditPayload(payload);
  assert.ok(res.breakpoint.tokensBefore > 100, `tokensBefore=${res.breakpoint.tokensBefore}`);
  assert.ok(res.breakpoint.tokensAfter > 0);
});

test('auditPayload: plain text input still works end to end', () => {
  const res = auditPayload('Current date: 2026-09-22\n' + POLICY);
  assert.equal(res.payload.kind, 'text');
  assert.ok(res.findings.some((f) => f.id === 'dynamic-timestamp'));
});

test('auditPayload: result shape matches audit() so the UI can render either', () => {
  const viaPayload = auditPayload(JSON.stringify({ system: POLICY }));
  const viaAudit = audit({ systemPrompt: POLICY, providerKey: 'anthropic' });
  for (const key of ['score', 'grade', 'hitRate', 'findings', 'cost', 'monthlyWaste', 'verdict']) {
    assert.ok(key in viaPayload, `missing ${key}`);
    assert.ok(key in viaAudit);
  }
  // Scores are deliberately NOT compared here: a parsed request can be shown
  // to lack cache_control (critical), while plain prose cannot express it
  // (advisory). Shape compatibility is what this test is for; the scoring
  // relationship is pinned by the tests below it.
  assert.equal(typeof viaPayload.score, 'number');
  assert.equal(typeof viaAudit.score, 'number');
});

/* ---------- findings must not contradict the breakpoint verdict ---------- */

const LONG = 'You are a support agent. Verify identity. Never invent policy. '.repeat(120);

function payloadWith(systemBlocks) {
  return JSON.stringify({ model: 'claude-opus-4-7', system: systemBlocks });
}

test('auditPayload: a finding entirely after the breakpoint is demoted, not CRITICAL', () => {
  const res = auditPayload(
    payloadWith([
      { type: 'text', text: LONG, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ]),
  );
  const f = res.findings.find((x) => x.id === 'dynamic-timestamp');
  assert.ok(f, 'finding should still be reported');
  assert.equal(f.severity, 'info', `expected demotion, got ${f.severity}`);
  assert.equal(f.originalSeverity, 'critical', 'original severity should be preserved');
  assert.equal(f.afterBreakpoint, true);
  assert.match(f.note, /after the cache breakpoint/);
});

test('auditPayload: demotion removes the contradiction with the breakpoint card', () => {
  const res = auditPayload(
    payloadWith([
      { type: 'text', text: LONG, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ]),
    { logsCacheTokens: true },
  );
  assert.equal(res.breakpoint.clean, true);
  assert.match(res.breakpoint.verdict, /correctly placed/);
  assert.equal(res.counts.critical, 0, 'must not report a critical while saying "correctly placed"');
  assert.equal(res.counts.high, 0);
  assert.equal(res.score, 100, `score was ${res.score}: ${JSON.stringify(res.findings.map((f) => f.id + ':' + f.severity))}`);
  assert.equal(res.grade, 'A');
});

test('auditPayload: a finding BEFORE the breakpoint stays critical', () => {
  const res = auditPayload(
    payloadWith([{ type: 'text', text: 'Current date: 2026-09-22\n' + LONG, cache_control: { type: 'ephemeral' } }]),
  );
  const f = res.findings.find((x) => x.id === 'dynamic-timestamp');
  assert.equal(f.severity, 'critical', 'must NOT be demoted');
  assert.equal(f.afterBreakpoint, undefined);
  assert.ok(res.counts.critical >= 1);
  assert.ok(res.score < 50);
});

test('auditPayload: mixed placement keeps the finding critical and says so', () => {
  const res = auditPayload(
    payloadWith([
      { type: 'text', text: 'Current date: 2026-09-22\n' + LONG, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-23' },
    ]),
  );
  const f = res.findings.find((x) => x.id === 'dynamic-timestamp');
  // One occurrence is before the breakpoint, so the finding as a whole stands.
  assert.equal(f.severity, 'critical');
});

test('auditPayload: below-minimum is not demoted by breakpoint placement', () => {
  const res = auditPayload(
    payloadWith([{ type: 'text', text: 'Short prompt.', cache_control: { type: 'ephemeral' } }]),
  );
  const f = res.findings.find((x) => x.id === 'below-minimum');
  assert.ok(f);
  assert.equal(f.severity, 'critical', 'a structural floor cannot be fixed by placement');
});

test('auditPayload: scoring matches audit() when both have the same breakpoint knowledge', () => {
  const viaAudit = audit({
    systemPrompt: LONG,
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
    breakpointKnown: true,
  });
  const viaPayload = auditPayload(JSON.stringify({ system: LONG }), {
    providerKey: 'anthropic',
    hasBreakpoint: true,
    logsCacheTokens: true,
  });
  assert.equal(viaPayload.score, viaAudit.score);
  assert.equal(viaPayload.grade, viaAudit.grade);
});

/* --- plain prose cannot express cache_control, so absence is advisory --- */

test('audit: a missing breakpoint in plain prose is advisory, not critical', () => {
  const res = audit({
    systemPrompt: LONG,
    providerKey: 'anthropic',
    hasBreakpoint: false,
    logsCacheTokens: true,
  });
  const f = res.findings.find((x) => x.id === 'no-breakpoint');
  assert.ok(f, 'should still be reported as a hint');
  assert.equal(f.severity, 'low', `expected advisory, got ${f.severity}`);
  assert.match(f.evidence[0].snippet, /cannot confirm/i);
});

test('auditPayload: a missing breakpoint in a real request IS critical', () => {
  const res = auditPayload(JSON.stringify({ model: 'claude-opus-4-7', system: LONG }), {
    logsCacheTokens: true,
  });
  const f = res.findings.find((x) => x.id === 'no-breakpoint');
  assert.ok(f);
  assert.equal(f.severity, 'critical', 'a parsed request with no marker caches nothing');
  assert.match(f.evidence[0].snippet, /parsed request payload/);
});

test('audit: the prose advisory does not fail a critical CI gate', () => {
  const res = audit({
    systemPrompt: LONG,
    providerKey: 'anthropic',
    hasBreakpoint: false,
    logsCacheTokens: true,
  });
  assert.equal(res.counts.critical, 0, 'prose must not produce a critical');
});
