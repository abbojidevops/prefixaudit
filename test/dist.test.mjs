/**
 * End-to-end check of the SHIPPED artefact, not the source.
 *
 * Pulls the two <script> blocks out of dist/index.html and executes them in a
 * minimal DOM. That means the real inlined engine and the real UI handlers
 * (run / render / runFix / applyFix / loadSample) all execute, and we assert on
 * what actually lands in the DOM.
 *
 * If the engine-to-classic-script transform ever breaks, or a UI function
 * references an element that no longer exists, this fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import '../scripts/ensure-dist.mjs'; // builds dist/ if this session lost it

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist', 'index.html');

function extractScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/* --------------------------- minimal DOM stub --------------------------- */

function makeEl(id) {
  const el = {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getPropertyValue(k) { return this._props[k]; },
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild(child) { (el.children ||= []).push(child); },
    scrollIntoView() {},
    select() {},
    files: [],
  };
  return el;
}

function makeDom(html) {
  const els = {};
  // Seed every id present in the markup so getElementById never returns undefined.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) els[id] = makeEl(id);
  return els;
}

function loadPage() {
  const html = fs.readFileSync(DIST, 'utf8');
  const scripts = extractScripts(html);
  assert.ok(scripts.length >= 2, `expected engine + UI scripts, found ${scripts.length}`);

  const els = makeDom(html);

  const document = {
    getElementById: (id) => els[id] || (els[id] = makeEl(id)),
    createElement: () => makeEl('tmp'),
    addEventListener: () => {},
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  };

  const sandbox = {
    document,
    navigator: { clipboard: null },
    window: {},
    console,
    setTimeout,
    clearTimeout,
    FileReader: function () {},
    setTimeout: (fn) => { sandbox.__timers.push(fn); return sandbox.__timers.length; },
    __timers: [],
  };
  sandbox.window.setTimeout = sandbox.setTimeout;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const code of scripts) vm.runInContext(code, ctx, { filename: 'dist-inline.js' });

  // Top-level `const`/`let` in a classic script land in the realm's global
  // lexical environment: visible to later scripts, but NOT as properties of
  // the sandbox object. Read them the way a later script would.
  const read = (expr) => vm.runInContext(expr, ctx);

  return { sandbox, els, ctx, read };
}

/* -------------------------------- tests --------------------------------- */

test('dist/index.html exists and is a single self-contained file', () => {
  assert.ok(fs.existsSync(DIST), 'run `npm run build` first');
  const html = fs.readFileSync(DIST, 'utf8');
  assert.ok(!html.includes('__ENGINE__'), 'build marker was not replaced');
  // No external resources: the page must work with zero network.
  assert.ok(!/<script[^>]+src=/i.test(html), 'external script found — must stay inline');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'external stylesheet found — must stay inline');
});

test('the inlined engine + UI both execute without throwing', () => {
  const { sandbox, read } = loadPage();
  assert.equal(typeof sandbox.audit, 'function', 'engine did not inline');
  assert.equal(typeof sandbox.autoFix, 'function');
  assert.equal(typeof sandbox.run, 'function', 'UI did not load');
  assert.equal(typeof read('RULE_CATALOG'), 'object', 'engine const bindings not reachable by the UI script');
  assert.equal(typeof read('PROVIDERS'), 'object');
  assert.ok(read('RULE_CATALOG').length >= 10);
});

test('on load the page auto-runs the broken sample and renders an F', () => {
  const { els } = loadPage();
  assert.ok(els.prompt.value.length > 500, 'sample prompt did not load');
  assert.equal(els.scoreN.textContent, 0, 'broken sample should score 0');
  assert.equal(els.scoreG.textContent, 'grade F');
  assert.equal(els.sHit.textContent, '0%', 'timestamp should zero the hit rate');
  assert.match(els.vTitle.textContent, /cache-break patterns found/);
  assert.match(els.findings.innerHTML, /timestamp/i);
  assert.match(els.findings.innerHTML, /request/i);
});

test('findings HTML is escaped — a prompt cannot inject markup', () => {
  const { sandbox, els } = loadPage();
  // Put the payload INSIDE the flagged line so it lands in an evidence snippet.
  // The payload must sit on a line the detector genuinely flags. A bare
  // "Current date: <img>" is NOT a rendered date, so use a template variable.
  els.prompt.value = ('The current date is {{currentDate}} <img src=x onerror=alert(1)>\n').padEnd(5000, 'policy. ');
  sandbox.run();
  assert.ok(!els.findings.innerHTML.includes('<img src=x'), 'raw HTML leaked into the DOM');
  assert.ok(els.findings.innerHTML.includes('&lt;img'), 'flagged snippet should be escaped');
  assert.match(els.findings.innerHTML, /timestamp/i);
});

test('the cost table renders real numbers for the broken sample', () => {
  const { els } = loadPage();
  assert.match(els.cost.innerHTML, /Per month/);
  assert.match(els.cost.innerHTML, /\$\d/);
  assert.match(els.costnote.textContent, /requests\/month/);
  assert.ok(els.sYear.textContent.startsWith('$'));
});

test('auto-fix moves the volatile lines and applying it raises the score', () => {
  const { sandbox, els } = loadPage();
  // Without a cache_control marker nothing caches at all, so the score is 0
  // before and after and there is nothing to demonstrate. Model the realistic
  // case: the marker is set, the prefix content is what is broken.
  sandbox.loadSample('broken');
  els.bp.checked = true;
  els.logs.checked = true;
  sandbox.run();
  // The broken sample scores 0 outright, so this asserts a rise from the floor.
  const before = Number(els.scoreN.textContent);
  assert.ok(Number.isFinite(before), `score did not render: ${JSON.stringify(els.scoreN.textContent)}`);
  sandbox.runFix();
  assert.equal(els.fixcard.style.display, 'block', 'fix panel should open');
  assert.ok(els.fixSuffix.textContent.includes('Current date'), 'timestamp should move to the suffix');
  assert.ok(!els.fixPre.textContent.includes('Current date'), 'timestamp should leave the prefix');

  sandbox.applyFix();
  const after = Number(els.scoreN.textContent);
  assert.ok(after > before, `score should rise after fix: ${before} -> ${after}`);
  assert.ok(!els.prompt.value.includes('Current date'), 'applied prefix still has the timestamp');
  assert.ok(els.user.value.includes('<volatile-context>'), 'suffix was not appended to the user turn');
});

test('auto-fix on a clean prompt reports nothing to move', () => {
  const { sandbox, els } = loadPage();
  sandbox.loadSample('clean');
  sandbox.runFix();
  // Toast path, panel stays hidden.
  assert.equal(els.fixcard.style.display, 'none');
});

test('switching provider re-syncs the price fields and re-audits', () => {
  const { sandbox, els } = loadPage();
  els.provider.value = 'openai';
  sandbox.syncPrices();
  assert.equal(els.base.value, 5.0);
  assert.equal(els.mintok.value, 1024);
  assert.equal(els.provbadge.textContent, 'OpenAI GPT-5.x');
  sandbox.run();
  assert.match(els.costnote.textContent, /Automatic caching/);
  assert.match(els.costnote.textContent, /\$5\.00\/MTok/);
});

test('an empty prompt resets the UI instead of crashing', () => {
  const { sandbox, els } = loadPage();
  els.prompt.value = '';
  sandbox.run();
  assert.equal(els.scoreN.textContent, '—');
  assert.match(els.vTitle.textContent, /Waiting for a prompt/);
  assert.match(els.findings.innerHTML, /No audit yet/);
});

test('rule cards render for every rule in the catalogue', () => {
  const { els, read } = loadPage();
  const cat = read('RULE_CATALOG');
  const count = (els.ruleCards.innerHTML.match(/class="mini"/g) || []).length;
  assert.equal(count, cat.length);
  for (const r of cat) {
    assert.ok(els.ruleCards.innerHTML.includes(r.title), `missing card for ${r.id}`);
  }
});

test('a below-minimum prefix is caught in the browser build too', () => {
  const { sandbox, els } = loadPage();
  els.prompt.value = 'You are a helpful assistant.';
  sandbox.run();
  assert.match(els.findings.innerHTML, /below the provider minimum/i);
  assert.equal(els.sHit.textContent, '0%');
});

/* =================== request-payload mode in the browser =================== */

test('UI: loading the request sample switches into payload mode', () => {
  const { sandbox, els } = loadPage();
  sandbox.loadSample('request');
  assert.equal(els.bp.disabled, true, 'checkbox should be derived, not asked');
  assert.equal(els.bp.checked, true, 'payload carries cache_control, so this should be checked');
  assert.equal(els.modebadge.style.display, '', 'payload badge should show');
  assert.match(els.modebadge.textContent, /request payload/);
  assert.match(els.modebadge.textContent, /claude-opus-4-7/);
  assert.match(els.modebadge.textContent, /2 tools/);
});

test('UI: the breakpoint card renders and calls out volatile content before it', () => {
  const { sandbox, els } = loadPage();
  sandbox.loadSample('request');
  assert.equal(els.bpcard.style.display, '', 'breakpoint card should be visible');
  // The sample puts the timestamp and request_id INSIDE the cached block.
  assert.match(els.bpverdict.innerHTML, /BEFORE the breakpoint/);
  assert.equal(els.bpbadge.style.color, 'var(--warn)');
  assert.match(els.bptable.innerHTML, /before breakpoint/i);
});

test('UI: moving the volatile block after the breakpoint flips the verdict', () => {
  const { sandbox, els, read } = loadPage();
  const policy = 'You are an agent. '.padEnd(6000, 'Follow the policy handbook precisely. ');
  els.prompt.value = JSON.stringify({
    model: 'claude-opus-4-7',
    system: [
      { type: 'text', text: policy, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Current date: 2026-09-22' },
    ],
  });
  sandbox.run();
  assert.equal(els.bpcard.style.display, '');
  assert.match(els.bpverdict.innerHTML, /correctly placed/, els.bpverdict.innerHTML);
  assert.equal(els.bpbadge.className, 'badge ok');
  void read;
});

test('UI: a payload with no cache_control reports that nothing is cached', () => {
  const { sandbox, els } = loadPage();
  const policy = 'You are an agent. '.padEnd(6000, 'Follow the policy handbook precisely. ');
  els.prompt.value = JSON.stringify({ model: 'claude-opus-4-7', system: policy });
  sandbox.run();
  assert.equal(els.bpcard.style.display, '');
  assert.equal(els.bpbadge.textContent, 'none found');
  assert.match(els.bpverdict.innerHTML, /nothing is cached/i);
  assert.equal(els.sHit.textContent, '0%');
});

test('UI: an OpenAI payload does not demand a marker', () => {
  const { sandbox, els } = loadPage();
  const policy = 'You are an agent. '.padEnd(6000, 'Follow the policy handbook precisely. ');
  els.provider.value = 'openai';
  sandbox.syncPrices();
  els.prompt.value = JSON.stringify({ model: 'gpt-5.6', instructions: policy });
  sandbox.run();
  assert.equal(els.findings.innerHTML.includes('No cache breakpoint marker found'), false);
  assert.match(els.modebadge.textContent, /request payload/);
});

test('UI: switching back to plain text re-enables the checkbox', () => {
  const { sandbox, els } = loadPage();
  sandbox.loadSample('request');
  assert.equal(els.bp.disabled, true);
  sandbox.loadSample('clean');
  assert.equal(els.bp.disabled, false);
  assert.equal(els.modebadge.style.display, 'none');
  assert.equal(els.bpcard.style.display, 'none');
});

test('UI: malformed JSON does not crash the page', () => {
  const { sandbox, els } = loadPage();
  els.prompt.value = '{ "system": "broken json ';
  let threw = null;
  try {
    sandbox.run();
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, `run() threw on malformed JSON: ${threw}`);
  assert.ok(els.vTitle.textContent.length > 0, 'UI should still render something');
});


test('UI: the shipped request sample is valid JSON and parses as a request', () => {
  const { els, read } = loadPage();
  const raw = read('SAMPLES.request');
  assert.doesNotThrow(() => JSON.parse(raw), 'shipped sample must be valid JSON');
  const parsed = read('parseRequestPayload')(raw);
  assert.equal(parsed.kind, 'request');
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.hasBreakpoint, true);
  assert.equal(parsed.toolCount, 2);
  void els;
});

/* ============ structured data must not drift from the engine ============ */

/** Pull every application/ld+json block out of the shipped file. */
function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );
}

test('dist ships valid JSON-LD that parses', () => {
  const html = fs.readFileSync(DIST, 'utf8');
  const blocks = jsonLdBlocks(html);
  assert.ok(blocks.length >= 2, `expected SoftwareApplication + FAQPage, found ${blocks.length}`);
  assert.ok(blocks.some((b) => b['@type'] === 'SoftwareApplication'));
  assert.ok(blocks.some((b) => b['@type'] === 'FAQPage'));
});

test('JSON-LD FAQ figures match the engine and the corpus study', async () => {
  // These numbers are also in launch/POST.md and research/REPORT.md. If the
  // engine's provider table changes, this test fails instead of the schema
  // quietly lying to a search engine.
  const { PROVIDERS } = await import('../src/engine.mjs');
  const html = fs.readFileSync(DIST, 'utf8');
  const faq = jsonLdBlocks(html).find((b) => b['@type'] === 'FAQPage');
  const all = faq.mainEntity.map((q) => q.acceptedAnswer.text).join('\n');

  assert.equal(PROVIDERS.anthropic.readMult, 0.1, 'engine read multiplier changed');
  assert.equal(PROVIDERS.anthropic.writeMult, 1.25, 'engine write multiplier changed');
  assert.equal(PROVIDERS.anthropic.minTokens, 1024);
  assert.equal(PROVIDERS.gemini.minTokens, 2048);

  assert.ok(all.includes('0.1x'), 'read discount must match the engine');
  assert.ok(all.includes('1.25x'), 'write premium must match the engine');
  assert.ok(all.includes('1,024'), 'Anthropic floor must be stated');
  assert.ok(all.includes('4,096'), 'Haiku 4.5 / Opus 4.6 floor must be stated');
  assert.ok(all.includes('2,048'), 'Gemini floor must match the engine');

  // Corpus figures, read from the generated study rather than retyped.
  const study = JSON.parse(fs.readFileSync(path.join(root, "research", "findings.json"), 'utf8'));
  const h = study.summary.headline;
  assert.ok(all.includes(`${h.belowProviderMinimumPct}%`), 'below-minimum share drifted');
  assert.ok(all.includes(`${h.withCriticalPct}%`), 'critical share drifted');
});

test('dist declares a canonical URL and a robots directive', () => {
  const html = fs.readFileSync(DIST, 'utf8');
  assert.match(html, /<link rel="canonical" href="https:\/\/[^"]+">/);
  assert.match(html, /<meta name="robots" content="index,follow/);
  assert.match(html, /<meta name="twitter:card"/);
});
