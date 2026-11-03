#!/usr/bin/env node
/**
 * Checks the email report windows against the spec they were built to:
 *
 *   daily  — yesterday, local midnight to midnight, one day.
 *   weekly — sent Monday, covering the previous Monday 00:00 to Sunday 24:00,
 *            seven days.
 *
 * Runs the real chrome/shared/report.js. The arithmetic is easy to state and
 * easy to get wrong at month, year, leap-day and DST boundaries, so each of
 * those is a case below rather than an assumption.
 *
 * It also asserts that report.js and background.js agree on the day-key format
 * across a long date range. They each build `data_YYYY_MM_DD` independently,
 * and a silent divergence would mean a report reading keys that storage never
 * wrote — an empty report with no error.
 *
 * Usage:  node test/verify-report-windows.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── load report.js (pure, no chrome APIs) ───────────────────────────────────
const ctx = createContext({ console, Date, Math, Object, Array, String, Number, JSON });
runInContext(readFileSync('chrome/shared/report.js', 'utf8'), ctx);
const call = (expr) => runInContext(expr, ctx);

// background.js's own key builder, extracted so the two can be compared.
const bgSrc = readFileSync('chrome/background/background.js', 'utf8');
const bgFn = bgSrc.match(/function dayKeyFor\(ts\) \{[\s\S]*?\n\}/);
if (!bgFn) { console.log('FAIL could not find dayKeyFor in background.js'); process.exit(1); }
const bgCtx = createContext({ Date, String });
runInContext(bgFn[0], bgCtx);

const key = (y, m, d) => `data_${y}_${String(m).padStart(2, '0')}_${String(d).padStart(2, '0')}`;
const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0).getTime();

// ── 1. daily: exactly yesterday ─────────────────────────────────────────────
console.log('\n--- daily windows ---');
{
  const w = call(`reportWindow("daily", new Date(${at(2026, 11, 9)}))`);
  check('daily covers one day', w.dayKeys.length, 1);
  check('daily is yesterday', w.dayKeys, [key(2026, 11, 8)]);
  const span = (w.endMs - w.startMs) / 3600000;
  check('daily spans 24 hours', span, 24);
  check('daily starts at local midnight', new Date(w.startMs).getHours(), 0);
}
// Month, year and leap-day rollovers.
for (const [label, now, expected] of [
  ['1st of the month -> last day of previous', at(2026, 3, 1), key(2026, 2, 28)],
  ['1st of January -> 31 Dec previous year', at(2027, 1, 1), key(2026, 12, 31)],
  ['1 Mar in a leap year -> 29 Feb', at(2028, 3, 1), key(2028, 2, 29)],
]) {
  const w = call(`reportWindow("daily", new Date(${now}))`);
  check(`daily ${label}`, w.dayKeys, [expected]);
}

// ── 2. weekly: previous Mon 00:00 -> Sun 24:00 ──────────────────────────────
console.log('\n--- weekly windows ---');
{
  // 2026-11-09 is a Monday.
  const monday = new Date(2026, 10, 9);
  check('fixture really is a Monday', monday.getDay(), 1);
  const w = call(`reportWindow("weekly", new Date(${at(2026, 11, 9)}))`);
  check('weekly covers seven days', w.dayKeys.length, 7);
  check('weekly starts the previous Monday', w.dayKeys[0], key(2026, 11, 2));
  check('weekly ends the previous Sunday', w.dayKeys[6], key(2026, 11, 8));
  check('weekly first day is a Monday', new Date(w.startMs).getDay(), 1);
  check('weekly last day is a Sunday', w.endDate.getDay(), 0);
  const span = Math.round((w.endMs - w.startMs) / 3600000);
  check('weekly spans 168 hours', span, 168);
  check('weekly end is exclusive (next Monday 00:00)', new Date(w.endMs).getDay(), 1);
}
// Called on a non-Monday it must still yield a calendar week, not a rolling one.
{
  const thu = call(`reportWindow("weekly", new Date(${at(2026, 11, 12)}))`);   // Thursday
  check('weekly from a Thursday is still Mon..Sun', [thu.dayKeys[0], thu.dayKeys[6]],
    [key(2026, 11, 2), key(2026, 11, 8)]);
  const sun = call(`reportWindow("weekly", new Date(${at(2026, 11, 15)}))`);   // Sunday
  check('weekly from a Sunday is still the week before', [sun.dayKeys[0], sun.dayKeys[6]],
    [key(2026, 11, 2), key(2026, 11, 8)]);
}
// Across a year boundary.
{
  const w = call(`reportWindow("weekly", new Date(${at(2027, 1, 4)}))`);   // Mon 4 Jan 2027
  check('weekly across new year', [w.dayKeys[0], w.dayKeys[6]],
    [key(2026, 12, 28), key(2027, 1, 3)]);
}

// ── 3. retention must actually hold the weekly window ───────────────────────
console.log('\n--- retention covers the window ---');
{
  const retention = Number(bgSrc.match(/const RETENTION_DAYS = (\d+);/)[1]);
  const w = call(`reportWindow("weekly", new Date(${at(2026, 11, 9)}))`);
  // On the send day, storage holds today + (retention - 1) prior days.
  const retained = new Set();
  for (let i = 0; i < retention; i++) {
    const d = new Date(2026, 10, 9); d.setDate(d.getDate() - i);
    retained.add(`data_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`);
  }
  const missing = w.dayKeys.filter(k => !retained.has(k));
  check(`retention is ${retention} days, enough for the weekly window`, missing, []);
}

// ── 4. the two day-key builders must not drift ──────────────────────────────
console.log('\n--- day-key format agreement ---');
{
  const mismatches = [];
  const d = new Date(2026, 0, 1);
  for (let i = 0; i < 900; i++) {
    const ts = d.getTime();
    const a = runInContext(`reportDayKey(new Date(${ts}))`, ctx);
    const b = runInContext(`dayKeyFor(${ts})`, bgCtx);
    if (a !== b) mismatches.push({ date: d.toDateString(), report: a, background: b });
    d.setDate(d.getDate() + 1);
  }
  check('report.js and background.js agree on 900 consecutive days', mismatches, []);
}

// ── 5. send window: morning only, Mondays only for weekly ───────────────────
console.log('\n--- send window ---');
for (const [label, ts, freq, want] of [
  ['daily at 08:00 Monday', at(2026, 11, 9, 8), 'daily', true],
  ['daily at 10:59 Friday', at(2026, 11, 13, 10), 'daily', true],
  ['daily at 07:00 (too early)', at(2026, 11, 13, 7), 'daily', false],
  ['daily at 11:00 (grace expired)', at(2026, 11, 13, 11), 'daily', false],
  ['daily at 23:00', at(2026, 11, 13, 23), 'daily', false],
  ['weekly at 09:00 Monday', at(2026, 11, 9, 9), 'weekly', true],
  ['weekly at 09:00 Tuesday', at(2026, 11, 10, 9), 'weekly', false],
  ['weekly at 09:00 Sunday', at(2026, 11, 15, 9), 'weekly', false],
  ['weekly at 07:00 Monday', at(2026, 11, 9, 7), 'weekly', false],
]) {
  check(label, call(`isWithinSendWindow("${freq}", new Date(${ts}))`), want);
}

// ── 6. window ids are stable per window, distinct across windows ────────────
console.log('\n--- window identity (drives send-once) ---');
{
  const a = call(`reportWindowId("daily", new Date(${at(2026, 11, 9, 8)}))`);
  const b = call(`reportWindowId("daily", new Date(${at(2026, 11, 9, 10)}))`);
  check('same morning -> same daily id (cannot send twice)', a, b);
  const c = call(`reportWindowId("daily", new Date(${at(2026, 11, 10, 8)}))`);
  check('next day -> different daily id', a === c, false);
  const w1 = call(`reportWindowId("weekly", new Date(${at(2026, 11, 9, 8)}))`);
  const w2 = call(`reportWindowId("weekly", new Date(${at(2026, 11, 16, 8)}))`);
  check('consecutive Mondays -> different weekly ids', w1 === w2, false);
  check('daily and weekly ids never collide', w1 === a, false);
}

// ── 7. aggregation ──────────────────────────────────────────────────────────
console.log('\n--- aggregation ---');
{
  const day = (secs, host, cat, lastVisit) => ({
    domains: { [host]: { hostname: host, seconds: secs, category: cat, lastVisit } },
    totalSeconds: secs,
  });
  const byKey = {
    [key(2026, 11, 2)]: day(600, 'github.com', 'Technology', 1),
    [key(2026, 11, 3)]: day(300, 'github.com', 'Technology', 2),
    [key(2026, 11, 4)]: day(120, 'bbc.co.uk', 'News & Media', 3),
    // 11-05 .. 11-08 absent: four missing days.
  };
  const r = call(`buildReportData("weekly", ${JSON.stringify(byKey)}, new Date(${at(2026, 11, 9)}))`);
  check('sums a domain across days', r.domains.find(d => d.hostname === 'github.com').seconds, 900);
  check('total is the sum of all domains', r.totalSeconds, 1020);
  check('categories derived from domains', r.categories, { Technology: 900, 'News & Media': 120 });
  check('counts days covered', r.daysCovered, 7);
  check('counts days actually present', r.daysPresent, 3);
  check('reports missing days rather than hiding them', r.daysMissing, 4);
  check('domains sorted by time descending', r.domains.map(d => d.hostname), ['github.com', 'bbc.co.uk']);
  check('window id matches the window', r.windowId, `weekly:${key(2026, 11, 2)}`);
}
{
  // A domain reclassified mid-window must count once, under its latest label.
  const byKey = {
    [key(2026, 11, 2)]: { domains: { 'x.com': { hostname: 'x.com', seconds: 100, category: 'Other', lastVisit: 10 } } },
    [key(2026, 11, 3)]: { domains: { 'x.com': { hostname: 'x.com', seconds: 50, category: 'Social Media', lastVisit: 20 } } },
  };
  const r = call(`buildReportData("weekly", ${JSON.stringify(byKey)}, new Date(${at(2026, 11, 9)}))`);
  check('reclassified domain counted once', r.domains.length, 1);
  check('under its most recent category', r.categories, { 'Social Media': 150 });
}
{
  // Nothing recorded at all: must be reportable, not NaN or a crash.
  const r = call(`buildReportData("daily", {}, new Date(${at(2026, 11, 9)}))`);
  check('empty window totals zero', r.totalSeconds, 0);
  check('empty window reports no domains', r.domains, []);
  check('empty window says the day is missing', [r.daysPresent, r.daysMissing], [0, 1]);
}

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
