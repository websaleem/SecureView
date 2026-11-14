#!/usr/bin/env node
/**
 * Checks the website's Chrome Web Store links against the rewrite that
 * environment-switches them.
 *
 * The dev site must point at the BETA listing, not production. It does that by
 * sed-replacing one exact literal in deploy-website.yml:
 *
 *     chromewebstore.google.com/detail/<prod id>
 *
 * which means a link written in any other shape is silently missed and ships a
 * production install button on the dev site. That is how it went unnoticed in
 * the first place: five links across three pages, all hardcoded, and a deploy
 * that rewrote only the site hostname.
 *
 * So this asserts the two halves agree — every store link in the source is in
 * the exact form the rewrite handles, and the workflow still performs the
 * rewrite with its fail-fast guard intact.
 *
 * Usage:  node test/verify-website-links.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';

const PROD_ID = 'ojhmodiiehcingcnhlglenenoemmegim';
const BETA_ID = 'hiopfkjjakmgoodhldhppaokdaceilbd';
const CANONICAL = /^https:\/\/chromewebstore\.google\.com\/detail\/[a-p]{32}$/;

const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const pages = readdirSync('website').filter(f => f.endsWith('.html'));
console.log(`--- store links across ${pages.length} pages ---`);

// Any URL that looks like it points at the Web Store, in ANY form.
const anyStore = /https?:\/\/[^"'\s)]*(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)[^"'\s)]*/g;

const found = [];
for (const page of pages) {
  const html = readFileSync(`website/${page}`, 'utf8');
  for (const url of html.match(anyStore) || []) found.push({ page, url });
}

check('the site has store links at all', found.length > 0, true);

// The source is the production site; the dev deploy rewrites the host. A dev
// host written into the source would ship to production as-is.
check('no page names the dev site in source',
  pages.filter(p => readFileSync(`website/${p}`, 'utf8').includes('dev.secureview.websaleem.com')), []);

// Every link must be in the one shape the rewrite can see. A trailing path, a
// query string, or the older chrome.google.com/webstore host would all survive
// the sed untouched and ship production on dev.
const offShape = found.filter(f => !CANONICAL.test(f.url));
check('every store link is in the exact form the rewrite matches', offShape.map(f => `${f.page}: ${f.url}`), []);

// Source is production. The dev value comes from a secret at deploy time, so it
// must never be hardcoded here.
const wrongId = found.filter(f => CANONICAL.test(f.url) && !f.url.endsWith(PROD_ID));
check('every store link uses the production id in source', wrongId.map(f => `${f.page}: ${f.url}`), []);

console.log(`\n--- the deploy workflow's half of the bargain ---`);
const wf = readFileSync('.github/workflows/deploy-website.yml', 'utf8');
check('the production id the rewrite looks for matches the source',
  new RegExp(`PROD_EXTENSION_ID:\\s*${PROD_ID}\\b`).test(wf), true);
check('the workflow carries the beta id',
  new RegExp(`BETA_EXTENSION_ID:\\s*${BETA_ID}\\b`).test(wf), true);
// Distinct and well-formed. Pasting the production id into the beta slot would
// otherwise rewrite every dev link to production and look like it had worked.
check('the two ids are different', PROD_ID === BETA_ID, false);
check('the beta id is a well-formed store id', /^[a-p]{32}$/.test(BETA_ID), true);
// A change to the deploy logic must actually deploy, or a fix to the rewrite
// sits pushed and inert — which is exactly what happened to it once.
check('the workflow redeploys when the workflow itself changes',
  /- '\.github\/workflows\/deploy-website\.yml'/.test(wf), true);
check('the dev branch rewrites the store links',
  /sed -i .*chromewebstore\.google\.com\/detail\/\$PROD_EXTENSION_ID/.test(wf), true);
// An empty secret would rewrite these to ".../detail/" on every page, which is
// worse than not deploying — so the workflow must refuse rather than proceed.
check('a missing beta secret aborts the deploy',
  /if \[ -z "\$BETA_EXTENSION_ID" \]/.test(wf) && /exit 1/.test(wf), true);
check('and it verifies the production id is gone afterwards',
  /grep -rl "detail\/\$PROD_EXTENSION_ID" website\//.test(wf), true);

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`ALL CHECKS PASS (${found.length} store links checked)`);
