/**
 * Real-world precision tests.
 *
 * Every case in here came from running the auditor over a corpus of 236 real,
 * published system prompts (CC0). They are the false positives the synthetic
 * tests could not see, because the synthetic tests used prompts I wrote myself.
 *
 * This file is the reason the corpus numbers are trustworthy. If any of these
 * regress, the study is measuring detector noise rather than prompt structure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, maskCodeBlocks } from '../src/engine.mjs';

const OPTS = { providerKey: 'anthropic', hasBreakpoint: true, logsCacheTokens: true };

function ids(text, opts = {}) {
  return audit({ systemPrompt: text, ...OPTS, ...opts }).findings.map((f) => f.id);
}
function has(text, id, opts) {
  return ids(text, opts).includes(id);
}
function pad(text) {
  // Push past the 1,024-token cache minimum so we test structure, not length.
  return text + '\n\n' + 'Follow the policy handbook precisely and never speculate. '.repeat(40);
}

/* ===================== maskCodeBlocks ===================== */

test('maskCodeBlocks: blanks a fenced block but preserves line count and offsets', () => {
  const src = 'line one\n```py\nx = datetime.now()\n```\nline five';
  const masked = maskCodeBlocks(src);
  assert.equal(masked.split('\n').length, src.split('\n').length, 'line count must be preserved');
  assert.ok(!masked.includes('datetime.now'), 'code body should be blanked');
  assert.ok(masked.includes('line one') && masked.includes('line five'));
  // Offsets: the text after the block must start at the same index.
  assert.equal(src.indexOf('line five'), masked.indexOf('line five'), 'offsets must be preserved');
});

test('maskCodeBlocks: blanks inline code spans', () => {
  const masked = maskCodeBlocks('Call `crypto.randomUUID()` for each request.');
  assert.ok(!masked.includes('randomUUID'));
  assert.ok(masked.includes('Call'));
});

test('maskCodeBlocks: leaves prose untouched', () => {
  const src = 'Today is Monday. No code here.';
  assert.equal(maskCodeBlocks(src), src);
});

/* ===================== code examples are not signals ===================== */

test('a Date.now() inside a code example is NOT a timestamp finding', () => {
  const text = pad(
    'You are a coding agent.\n\n```js\nconst f = path.join(DIR, `ss-${Date.now()}` + ".png");\n```\n',
  );
  assert.equal(has(text, 'dynamic-timestamp'), false, ids(text).join(','));
});

test('a {session_id} inside a URL path is NOT an id finding', () => {
  const text = pad('You are an agent.\n- get_run_log: GET /v1/code/sessions/{session_id}/events\n');
  assert.equal(has(text, 'volatile-id'), false, ids(text).join(','));
});

test('a `"session_id": "string"` schema declaration is NOT an id finding', () => {
  const text = pad('You are an agent.\n"session_id": "string", // Unique session ID\n');
  assert.equal(has(text, 'volatile-id'), false, ids(text).join(','));
});

test('a json.dumps example in a doc is NOT a serialisation finding', () => {
  const text = pad('## Notes\n```py\njson.dumps(d)  # without sort_keys\n```\n');
  assert.equal(has(text, 'unstable-serialisation'), false, ids(text).join(','));
});

/* ===================== prose ABOUT the anti-pattern ===================== */

test('a prompt warning against interpolating dates is NOT flagged', () => {
  const text = pad(
    '**Keep the system prompt frozen.** Don\'t interpolate "current date: 2026-09-22", "mode: Y", "user name: Z" into the system prompt.\n',
  );
  assert.equal(has(text, 'dynamic-timestamp'), false, ids(text).join(','));
});

test('a documented anti-pattern table is NOT flagged as a retry rebuild', () => {
  const text = pad(
    '| `uuid4()` / `crypto.randomUUID()` / request IDs early in content | Same - every request is unique |\n',
  );
  assert.equal(has(text, 'volatile-id'), false, ids(text).join(','));
});

/* ===================== prose that merely contains the words ===================== */

test('"user names" / "user named" prose is NOT a personalisation finding', () => {
  const text = pad('Prefer user names that are short. Never refer to a user named. in output.\n');
  assert.equal(has(text, 'personalisation-in-prefix'), false, ids(text).join(','));
});

test('"Caller is optional" prose is NOT a personalisation finding', () => {
  const text = pad('Caller is optional. The caller is jumping to conclusions if it assumes otherwise.\n');
  assert.equal(has(text, 'personalisation-in-prefix'), false, ids(text).join(','));
});

test('agent definitions like `name: Explore` are NOT personalisation', () => {
  const text = pad('## Agents\nname: Explore\nname: Plan\nname: claude-code-guide\n');
  assert.equal(has(text, 'personalisation-in-prefix'), false, ids(text).join(','));
});

test('type annotations like `name: str` are NOT personalisation', () => {
  const text = pad('```py\nname: str\nemail: str\nplan: str\n```\n');
  assert.equal(has(text, 'personalisation-in-prefix'), false, ids(text).join(','));
});

test('prose about "the latest state" is NOT a mutable-memory finding', () => {
  const text = pad("Make sure to read a task's latest state using `TaskGet` before updating it.\n");
  assert.equal(has(text, 'mutable-memory-in-prefix'), false, ids(text).join(','));
});

test('a CLI flag `--session-id` is NOT an ordering finding', () => {
  const text = pad('ant beta:sessions:events list --session-id session_01...\n\nYou are an agent.\n');
  assert.equal(has(text, 'ordering'), false, ids(text).join(','));
});

test('model names in prose are NOT a model-churn finding', () => {
  const text = pad('This works with claude models, gemini models and grok models alike.\n');
  assert.equal(has(text, 'model-churn'), false, ids(text).join(','));
});

test('a React component named Todo is NOT a mutable-memory finding', () => {
  const text = pad('```jsx\nexport const Todo = () => { return null; };\n```\n');
  assert.equal(has(text, 'mutable-memory-in-prefix'), false, ids(text).join(','));
});

/* ===================== true positives must survive ===================== */

test('a real interpolated clock IS still flagged', () => {
  const text = pad('You are an agent.\nThe current date is {{currentDateTime}}.\n');
  assert.ok(has(text, 'dynamic-timestamp'), 'lost a true positive');
});

test('a real rendered date line IS still flagged', () => {
  const text = pad("You are an agent.\nToday's date: Monday, August 10, 2026 (for more granularity, use bash)\n");
  assert.ok(has(text, 'dynamic-timestamp'), 'lost a true positive');
});

test('a real rendered UUID IS still flagged', () => {
  const text = pad('You are an agent.\nrequest_id: 8f14e45f-ceea-467a-9b1e-1f2b3c4d5e6f\n');
  assert.ok(has(text, 'volatile-id'), 'lost a true positive');
});

test('a real per-user identity line IS still flagged', () => {
  const text = pad("You are an agent.\nThe user's name is Priya Sharma\n");
  assert.ok(has(text, 'personalisation-in-prefix'), 'lost a true positive');
});

test('a real rendered timezone IS still flagged', () => {
  const text = pad('You are an agent.\ntimezone: Asia/Kolkata\n');
  assert.ok(has(text, 'personalisation-in-prefix'), 'lost a true positive');
});

test('a placeholder/example UUID is NOT flagged', () => {
  const text = pad('You are an agent.\nrequest_id: 00000000-0000-0000-0000-000000000000\n');
  assert.equal(has(text, 'volatile-id'), false, ids(text).join(','));
});

test('a real scratchpad section IS still flagged', () => {
  const text = pad('You are an agent.\n## Working memory\n- nothing yet\n');
  assert.ok(has(text, 'mutable-memory-in-prefix'), 'lost a true positive');
});

test('model assignments that genuinely differ ARE flagged as churn', () => {
  const text = pad('You are an agent.\nmodel: claude-opus-4-7\nmodel: gpt-5.6\n');
  assert.ok(has(text, 'model-churn'), ids(text).join(','));
});

/* ===================== the opt-out ===================== */

test('ignoreCodeBlocks: false makes code examples visible again', () => {
  const text = pad('You are an agent.\n```js\nconst t = `now ${Date.now()}`;\n```\n');
  assert.equal(has(text, 'dynamic-timestamp'), false, 'masked by default');
  assert.equal(
    has(text, 'dynamic-timestamp', { ignoreCodeBlocks: false }),
    true,
    'opt-out should expose code',
  );
});

/* ===== regression: odd fence counts used to leak whole code blocks ===== */

test('maskCodeBlocks: an odd number of fences still masks the trailing block', () => {
  // A paired regex pairs the Nth opener with the Nth closer, so one stray
  // marker shifts every later pair and leaks code into the scan text.
  const src = 'Intro.\n```\ncode A\n```\nMiddle.\n```\ncode B\nEnd.';
  const masked = maskCodeBlocks(src);
  assert.ok(!masked.includes('code A'), 'first block leaked');
  assert.ok(!masked.includes('code B'), 'trailing unpaired block leaked');
  assert.ok(masked.includes('Intro.'), 'prose before must survive');
  assert.ok(masked.includes('Middle.'), 'prose between must survive');
  assert.equal(masked.split('\n').length, src.split('\n').length, 'line count must be preserved');
});

test('maskCodeBlocks: an unterminated fence at EOF blanks to the end', () => {
  const src = 'Prompt.\n```py\nsecret_value = Date.now()\n';
  const masked = maskCodeBlocks(src);
  assert.ok(!masked.includes('secret_value'));
  assert.ok(masked.includes('Prompt.'));
});

test('maskCodeBlocks: a mismatched marker inside a block is content, not a closer', () => {
  const src = 'A\n```\n~~~\nstill code\n```\nB';
  const masked = maskCodeBlocks(src);
  assert.ok(!masked.includes('still code'), 'block closed early on the wrong marker');
  assert.ok(masked.includes('B'), 'trailing prose must survive');
});

test('maskCodeBlocks: offsets are preserved exactly', () => {
  const src = 'Header line here.\n```js\nconst x = 1;\nconst y = 2;\n```\nFooter line.';
  const masked = maskCodeBlocks(src);
  assert.equal(masked.length, src.length, 'character count must be identical');
  assert.equal(masked.indexOf('Footer line.'), src.indexOf('Footer line.'), 'offsets must not shift');
});

/* ===== regression: worked examples with a hardcoded date ===== */

test('a date inside an "Example:" line is NOT a rendered timestamp', () => {
  // Real false positive from xAI/grok-bot.md. The date is frozen documentation
  // teaching the model how to build a search query; it never changes.
  const text = pad(
    '- Example: If today is 2026-08-20 and the user asks for "latest React docs", search for "React documentation 2026", NOT "React documentation latest".\n',
  );
  assert.equal(has(text, 'dynamic-timestamp'), false, ids(text).join(','));
});

test('the same wording without "Example:" IS still flagged', () => {
  const text = pad('If today is 2026-08-20 you must search for "React documentation 2026".\n');
  assert.equal(has(text, 'dynamic-timestamp'), true, 'guard must not swallow real rendered dates');
});

test('a real rendered date elsewhere in the file survives an Example: line', () => {
  const text = pad(
    'Current date: 2026-09-22\n\n- Example: If today is 2026-08-20, search for "docs 2026".\n',
  );
  assert.equal(has(text, 'dynamic-timestamp'), true, 'the live date must still be caught');
});

test('the illustrative guard applies only to dates, not to other rules', () => {
  // Over-broad guarding was tried and reverted: an "Example:" line can still
  // legitimately contain a volatile id or mutable-memory reference.
  const text = pad('Example: store the user session_id in working memory for later.\n');
  assert.equal(has(text, 'mutable-memory-in-prefix'), true, 'other rules must not inherit the guard');
});
