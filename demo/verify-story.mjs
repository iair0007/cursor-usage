#!/usr/bin/env node
// Checks that the scripted story sessions in generate-fixtures.mjs actually
// trip the findings the `session` cut of the demo video narrates.
//
// This matters because every rule in src/webview/insights.js is a threshold
// test on token counts and timestamps: a fixture that drifts a few thousand
// tokens the wrong way does not fail loudly, it just renders a session
// breakdown with an empty findings panel — which is only discovered halfway
// through recording a voiced take. So this runs the *real* rules (imported,
// not reimplemented) over the *real* generated data and reports what fired.
//
//   node demo/generate-fixtures.mjs && node demo/verify-story.mjs
//
// Needs Node 22+, which strips the types off src/shared/usageLogic.ts on the
// way in. Node 20 throws ERR_UNKNOWN_FILE_EXTENSION on that import.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePricing, matchPricing, normalize } from '../src/webview/logic.js';
import { buildInsights, findingsForSession, dedupeFindings, FINDING_CARD_LIMIT } from '../src/webview/insights.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataPath = path.join(__dirname, 'data.js');
if (!fs.existsSync(dataPath)) {
  console.error('demo/data.js not found — run `node demo/generate-fixtures.mjs` first.');
  process.exit(1);
}

// data.js is a browser file that assigns to `window`; give it one.
const globalWindow = {};
new Function('window', fs.readFileSync(dataPath, 'utf8'))(globalWindow);
const demo = globalWindow.__DEMO_DATA__;

const pricing = parsePricing(fs.readFileSync(path.join(__dirname, 'pricing.md'), 'utf8'));
const events = (demo.usage?.events || []).map((raw) => normalize(raw, pricing)).filter(Boolean);
const findings = buildInsights({ events, ratesFor: (modelRaw) => matchPricing(modelRaw, pricing) });

// What each story session has to show for the narration to be true.
const EXPECTED = {
  conv_authnight: ['context-blowup', 'compaction-undone', 'stale-resume'],
  conv_cleanrun: ['compaction-worked'],
};

let failed = false;

for (const [sessionId, wanted] of Object.entries(EXPECTED)) {
  const mine = dedupeFindings(findingsForSession(findings, sessionId));
  const rules = mine.map((f) => f.rule || f.title);
  const shown = rules.slice(0, FINDING_CARD_LIMIT);

  console.log(`\n${sessionId} — ${events.filter((e) => e.conversationId === sessionId).length} requests`);
  mine.forEach((f, i) => {
    const place = i < FINDING_CARD_LIMIT ? ' ' : ' (folded away)';
    console.log(`  ${i < FINDING_CARD_LIMIT ? '*' : '-'} [${f.severity}] ${f.rule || f.title}${place}`);
    console.log(`      ${f.title}`);
  });
  if (!mine.length) console.log('  (no findings)');

  for (const rule of wanted) {
    if (!rules.includes(rule)) {
      console.error(`  FAIL: "${rule}" did not fire`);
      failed = true;
    } else if (!shown.includes(rule)) {
      // Firing is not enough: a surface renders only the first three cards, so
      // a finding the narration names has to be inside that cut, not behind
      // the "show more" button where the camera will never see it.
      console.error(`  FAIL: "${rule}" fired but sits below the ${FINDING_CARD_LIMIT}-card limit`);
      failed = true;
    }
  }
}

// Claims the narration makes about specific numbers on screen. A spoken figure
// that the picture contradicts is worse than no figure at all, so the few the
// script does quote are pinned here rather than trusted to stay put.
const CLAIMS = [
  {
    what: 'the blowup is spoken as "six times more context"',
    rule: 'context-blowup',
    session: 'conv_authnight',
    test: (f) => /\b6×/.test(f.title),
  },
  {
    what: 'the stale resume is spoken as "after three and a half hours"',
    rule: 'stale-resume',
    session: 'conv_authnight',
    test: (f) => /3\.5h/.test(f.title),
  },
];

console.log('\nNarration claims:');
for (const claim of CLAIMS) {
  const f = findingsForSession(findings, claim.session).find((x) => x.rule === claim.rule);
  const ok = f && claim.test(f);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${claim.what}`);
  if (!ok) {
    console.error(`        got: ${f ? f.title : '(finding did not fire)'}`);
    failed = true;
  }
}

// The session the video opens on has to be worth opening — if another
// conversation outspends it, the Sessions list will not lead with it.
const spend = new Map();
for (const e of events) {
  if (!e.conversationId) continue;
  spend.set(e.conversationId, (spend.get(e.conversationId) || 0) + (e.cost ?? 0));
}
const ranked = [...spend.entries()].sort((a, b) => b[1] - a[1]);
console.log('\nTop sessions by cost:');
ranked.slice(0, 4).forEach(([id, cost], i) => console.log(`  ${i + 1}. ${id} — $${cost.toFixed(2)}`));
if (ranked[0]?.[0] !== 'conv_authnight') {
  console.error(`  FAIL: conv_authnight is not the costliest session (${ranked[0]?.[0]} is)`);
  failed = true;
}

console.log(failed ? '\nFAILED' : '\nAll expected findings fire.');
process.exit(failed ? 1 : 0);
