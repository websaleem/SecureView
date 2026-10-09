#!/usr/bin/env node
/**
 * Checks that the history panel always presents a fixed 7-day window.
 *
 * The panel used to render only the days chrome.storage happened to hold, so a
 * day with no activity was not drawn at all. A fresh install — which
 * legitimately has one day of data — was therefore indistinguishable from
 * history having been deleted, and that is exactly how it was reported.
 *
 * This runs the real chrome/popup/popup.js inside a VM with chrome.storage and
 * the DOM stubbed, so it tests the shipped code rather than a copy of its
 * logic. Only one top-level side effect exists in that file (an addEventListener
 * for DOMContentLoaded), which the stub absorbs; init() is never called.
 *
 * Usage:  node test/verify-history-window.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const failures = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function dayKey(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `data_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`;
}

function day(totalSeconds, sites = 1) {
  const domains = {};
  for (let i = 0; i < sites; i++) {
    domains[`site${i}.example`] = {
      hostname: `site${i}.example`, seconds: totalSeconds, category: 'Technology',
      categoryColor: '#2ECC71', categoryIcon: '💻', lastVisit: Date.now(),
    };
  }
  return { domains, categories: { Technology: { name: 'Technology', seconds: totalSeconds, color: '#2ECC71', icon: '💻' } }, totalSeconds };
}

/** Load popup.js with chrome/DOM stubbed, and return its context plus the DOM sinks. */
function loadPopup(store) {
  const els = {};
  const makeEl = (id) => (els[id] = {
    id, innerHTML: '', textContent: '', checked: false, value: '', style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, setAttribute() {},
    querySelectorAll: () => [], querySelector: () => null,
  });

  const ctx = createContext({
    console,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Error, isNaN, parseInt, parseFloat,
    setTimeout, clearTimeout,
    Logger: { init: async () => {}, info() {}, warn() {}, error() {}, debug() {}, CONFIG_KEY: 'debug_logging' },
    chrome: {
      runtime: { id: 'test', getManifest: () => ({ version: '0.0.0' }), lastError: null, sendMessage: () => {} },
      storage: {
        local: {
          get: (keys, cb) => cb(keys === null ? { ...store } : Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]))),
          set: (items, cb) => { Object.assign(store, items); cb && cb(); },
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); cb && cb(); },
        },
        onChanged: { addListener() {} },
      },
      tabs: { query: (_q, cb) => cb([]) },
    },
    document: {
      getElementById: (id) => els[id] || makeEl(id),
      addEventListener() {},
      body: { addEventListener() {} },
      querySelectorAll: () => [],
    },
  });

  runInContext(readFileSync('chrome/popup/popup.js', 'utf8'), ctx);
  return { ctx, els };
}

async function scenario(name, store, expect) {
  console.log(`\n--- ${name} ---`);
  const { ctx, els } = loadPopup(store);
  await runInContext('renderHistory()', ctx);

  const list = els['history-list'].innerHTML;
  const graph = els['history-graph-container'].innerHTML;

  // Anchor on the row container: a bare /class="history-day/ also matches the
  // child spans (history-day-date, history-day-stats) and counts each row 3x.
  const rows = (list.match(/<div class="history-day[ "]/g) || []).length;
  const emptyRows = (list.match(/<div class="history-day is-empty"/g) || []).length;
  const cols = (graph.match(/class="graph-col/g) || []).length;
  const emptyCols = (graph.match(/class="graph-col is-empty"/g) || []).length;

  check(`${name}: list always has 7 rows`, rows, 7);
  check(`${name}: graph always has 7 columns`, cols, 7);
  check(`${name}: rows marked empty`, emptyRows, expect.empty);
  check(`${name}: columns marked empty`, emptyCols, expect.empty);
  check(`${name}: today is labelled "Today"`, list.includes('>Today<'), true);
  check(`${name}: absent days say so`, list.includes('No activity recorded'), expect.empty > 0);
  check(`${name}: no NaN leaked into the markup`, /NaN/.test(list + graph), false);
  check(`${name}: no Invalid Date leaked`, /Invalid Date/.test(list + graph), false);
}

// The reported case: a fresh install with only today's data.
await scenario('only today', { [dayKey(0)]: day(3600, 4) }, { empty: 6 });

// A partially-populated week: gaps must still be drawn.
await scenario('three of seven days', {
  [dayKey(0)]: day(1800, 2), [dayKey(2)]: day(600, 1), [dayKey(5)]: day(7200, 9),
}, { empty: 4 });

// Nothing at all — must not render "-Infinity"/NaN heights or claim lost data.
await scenario('empty storage', {}, { empty: 7 });

// A day that was recorded but genuinely had zero tracked time is NOT a gap.
await scenario('present but zero seconds', {
  [dayKey(0)]: day(1200, 1), [dayKey(1)]: { domains: {}, categories: {}, totalSeconds: 0 },
}, { empty: 5 });

// A full week, plus an out-of-window day that pruning has not yet removed:
// the window must stay at 7 and must not show the older day.
await scenario('full week ignores out-of-window data', {
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(i => [dayKey(i), day(100 * (i + 1), 1)])),
  [dayKey(9)]: day(999999, 50),
}, { empty: 0 });

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
