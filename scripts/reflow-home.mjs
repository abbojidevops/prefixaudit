// One-shot structural reflow of site/template.html for the platform-grade pass.
// Moves: auditor -> hero; instrument -> own #viz section. Idempotent guard included.
import fs from 'node:fs';

const P = new URL('../site/template.html', import.meta.url);
let s = fs.readFileSync(P, 'utf8');

if (s.includes('id="viz"')) { console.log('already reflowed'); process.exit(0); }

/* ---- extract auditor section ---- */
const audStart = s.indexOf('  <!-- ===================== AUDITOR ===================== -->');
const audEndIdx = s.indexOf('  </section>', audStart);
if (audStart < 0 || audEndIdx < 0) throw new Error('auditor anchors not found');
let auditor = s.slice(audStart, audEndIdx + '  </section>'.length);
s = s.slice(0, audStart) + s.slice(audEndIdx + '  </section>'.length);

/* ---- extract instrument block ---- */
const instrStart = s.indexOf('      <!-- product instrument -->');
const wrapClose = s.indexOf('    </div>\n\n    <!-- trust strip -->');
if (instrStart < 0 || wrapClose < 0) throw new Error('instr anchors not found');
let instr = s.slice(instrStart, wrapClose).replace(/\s+$/, '');
s = s.slice(0, instrStart) + s.slice(wrapClose);

/* ---- reshape auditor: section -> hero div with compact kicker ---- */
auditor = auditor
  .replace('  <!-- ===================== AUDITOR ===================== -->\n', '')
  .replace('<section class="sec" id="auditor">', '<div class="hero-aud rv" id="auditor">')
  .replace(/  <\/section>$/, '  </div>')
  .replace(
    /      <div class="sechead rv">\n        <span class="micro t">The instrument<\/span>\n        <h2>Run the audit <em>here\.<\/em><\/h2>\n        <p class="secp">[\s\S]*?<\/p>\n      <\/div>/,
    `      <div class="aud-kicker">
        <span class="micro t">The instrument — live, in this tab</span>
        <span class="privline">Your prompt never leaves your browser · no upload · no API key · no storage · no server-side transmission</span>
      </div>`
  );

/* ---- insert privacy kicker + auditor where the instrument was ---- */
const insertAt = s.indexOf('    </div>\n\n    <!-- trust strip -->');
s = s.slice(0, insertAt) + auditor + '\n' + s.slice(insertAt);

/* ---- new diagnostic section holding the instrument, before HOW ---- */
const howAnchor = '  <!-- ===================== HOW ===================== -->';
const vizSec = `  <!-- ===================== DIAGNOSTIC ===================== -->
  <section class="sec parch" id="viz">
    <div class="wrap">
      <div class="sechead rv">
        <span class="micro t">The diagnostic</span>
        <h2>One stream. One breakpoint. <em>One bill.</em></h2>
        <p class="secp">A cached prefix is a byte-exact contract. Everything before the breakpoint must never
          change; everything after it may change freely. PrefixAudit draws that line on your prompt.</p>
      </div>
      <div class="stages rv" aria-label="Prefix lifecycle: cacheable prefix, cache break, fresh input, cost impact">
        <span>CACHEABLE PREFIX</span><i>↓</i><span class="e">CACHE BREAK</span><i>↓</i><span>FRESH INPUT</span><i>↓</i><span class="t2">POTENTIAL COST IMPACT</span>
      </div>
${instr}
    </div>
  </section>

${howAnchor}`;
s = s.replace(howAnchor, vizSec);

fs.writeFileSync(P, s);
console.log('reflowed: auditor->hero, instrument->#viz');
