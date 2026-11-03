#!/usr/bin/env node
/**
 * Drives the real chrome/shared/reporter.js through report mornings.
 *
 * The behaviours that matter are the ones a user would notice going wrong:
 * a report arriving twice, a report arriving for a window the browser slept
 * through, or a report going to an address nobody confirmed. Each is a case
 * below, run against the shipped code with a fake clock and a stubbed endpoint
 * — no network, no email.
 *
 * Skip-if-missed is the chosen policy: a window the browser was closed through
 * is never sent later and never retried.
 *
 * Usage:  node test/verify-report-scheduling.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : `(got ${JSON.stringify(got)})`}`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const at = (y, m, d, h = 9, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime();
const dayKey = (y, m, d) => `data_${y}_${String(m).padStart(2, '0')}_${String(d).padStart(2, '0')}`;

function harness({ status = 'verified', email = 'owner@example.com', freq = 'daily',
                   serverStatus = 'sent', statusResponse = null, days = {} } = {}) {
  let now = at(2026, 11, 9, 9);
  const store = {
    reportEmail: email,
    emailReportFreq: freq,
    report_state: { clientId: 'c'.repeat(48), subscribedEmail: email, status, sent: {} },
    ...days,
  };
  const calls = [];

  const ctx = createContext({
    console, JSON, Object, Array, String, Number, Boolean, Math, RegExp, Promise, Error, Uint8Array,
    Date: new Proxy(Date, {
      construct: (T, a) => (a.length ? new T(...a) : new T(now)),
      apply: () => new Date(now).toString(),
      get: (T, p, r) => (p === 'now' ? () => now : Reflect.get(T, p, r)),
    }),
    crypto: { getRandomValues: (arr) => { arr.fill(7); return arr; } },
    AbortSignal: { timeout: () => undefined },
    Logger: { info() {}, warn() {}, debug() {}, error() {} },
    getCFConfig: () => ({ reportBase: 'https://example.invalid/report' }),
    fetch: async (url, opts) => {
      const payload = JSON.parse(opts.body);
      calls.push({ url, payload });
      const path = url.split('/report')[1];
      if (path === '/status') return { ok: true, json: async () => ({ status: statusResponse ?? status }) };
      if (path === '/subscribe') return { ok: true, json: async () => ({ status: 'pending' }) };
      if (path === '/send') return { ok: true, json: async () => ({ status: serverStatus }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          get: (keys) => Promise.resolve(
            keys === null ? { ...store }
              : Object.fromEntries((Array.isArray(keys) ? keys : [keys])
                  .filter(k => k in store).map(k => [k, store[k]]))),
          set: (items) => { Object.assign(store, items); return Promise.resolve(); },
        },
      },
    },
  });

  runInContext(readFileSync('chrome/shared/report.js', 'utf8'), ctx);
  runInContext(readFileSync('chrome/shared/reporter.js', 'utf8'), ctx);

  return {
    setNow: (ts) => { now = ts; },
    send: () => runInContext('maybeSendReport()', ctx),
    subscribe: (e) => runInContext(`subscribeReportEmail(${JSON.stringify(e)})`, ctx),
    prune: (sent, ts, keep) =>
      runInContext(`pruneSentHistory(${JSON.stringify(sent)}, new Date(${ts}), ${keep})`, ctx),
    state: () => store.report_state,
    calls,
    store,
  };
}

const oneDay = (key, seconds, host = 'github.com') => ({
  [key]: { domains: { [host]: { hostname: host, seconds, category: 'Technology', lastVisit: 1 } },
           totalSeconds: seconds },
});

// ── 1. the happy path ───────────────────────────────────────────────────────
console.log('\n--- daily report on a normal morning ---');
{
  const h = harness({ days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('sends', await h.send(), 'sent');
  const sendCall = h.calls.find(c => c.url.endsWith('/send'));
  check('posts the window the user asked for', sendCall.payload.report.windowId,
    `daily:${dayKey(2026, 11, 8)}`);
  check('reports yesterday only', sendCall.payload.report.daysCovered, 1);
  check('carries the aggregated total', sendCall.payload.report.totalSeconds, 3600);
  check('sends the address and this install id',
    [sendCall.payload.email, sendCall.payload.clientId.length], ['owner@example.com', 48]);
}

// ── 2. send-once ────────────────────────────────────────────────────────────
console.log('\n--- the same morning, twice ---');
{
  const h = harness({ days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('first attempt sends', await h.send(), 'sent');
  h.setNow(at(2026, 11, 9, 10, 30));
  check('second attempt the same morning does not', await h.send(), 'already_sent');
  check('only one /send call was made', h.calls.filter(c => c.url.endsWith('/send')).length, 1);
}

// ── 3. outside the morning window ───────────────────────────────────────────
console.log('\n--- outside the send window ---');
for (const [label, ts] of [
  ['before 08:00', at(2026, 11, 9, 7, 59)],
  ['after the grace period', at(2026, 11, 9, 11, 1)],
  ['late evening', at(2026, 11, 9, 22)],
]) {
  const h = harness({ days: oneDay(dayKey(2026, 11, 8), 3600) });
  h.setNow(ts);
  check(`no send ${label}`, await h.send(), 'outside_window');
  check(`and no request ${label}`, h.calls.length, 0);
}

// ── 4. skip-if-missed: a slept-through morning is never made up ─────────────
console.log('\n--- browser closed all morning (skip, do not catch up) ---');
{
  const h = harness({ days: { ...oneDay(dayKey(2026, 11, 8), 3600),
                              ...oneDay(dayKey(2026, 11, 9), 1800, 'bbc.co.uk') } });
  h.setNow(at(2026, 11, 9, 15));           // opened in the afternoon
  check('nothing sent that afternoon', await h.send(), 'outside_window');
  h.setNow(at(2026, 11, 10, 9));           // next morning
  check('next morning sends', await h.send(), 'sent');
  const sent = h.calls.filter(c => c.url.endsWith('/send'));
  check('exactly one report, not two', sent.length, 1);
  check('and it covers the new window only', sent[0].payload.report.windowId,
    `daily:${dayKey(2026, 11, 9)}`);
}

// ── 5. weekly only on Mondays ───────────────────────────────────────────────
console.log('\n--- weekly cadence ---');
{
  const week = {};
  for (let d = 2; d <= 8; d++) Object.assign(week, oneDay(dayKey(2026, 11, d), 600));
  const h = harness({ freq: 'weekly', days: week });
  check('Monday morning sends', await h.send(), 'sent');
  const call = h.calls.find(c => c.url.endsWith('/send'));
  check('covers seven days', call.payload.report.daysCovered, 7);
  check('starts the previous Monday', call.payload.report.startDay, dayKey(2026, 11, 2));
  check('ends the previous Sunday', call.payload.report.endDay, dayKey(2026, 11, 8));
  check('sums the whole week', call.payload.report.totalSeconds, 4200);

  const tue = harness({ freq: 'weekly', days: week });
  tue.setNow(at(2026, 11, 10, 9));
  check('Tuesday morning does not send a weekly', await tue.send(), 'outside_window');
}

// ── 6. consent ──────────────────────────────────────────────────────────────
console.log('\n--- an unconfirmed address is never mailed ---');
{
  const h = harness({ status: 'pending', days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('does not send', await h.send(), 'not_verified');
  check('no /send request issued', h.calls.filter(c => c.url.endsWith('/send')).length, 0);
}
{
  const h = harness({ email: '', days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('no address configured -> nothing happens', await h.send(), 'no_email');
  check('and no request', h.calls.length, 0);
}
{
  // Address changed after confirming. Consent is per-address and does not
  // transfer, so the backend will not recognise the new one — and the extension
  // must re-check rather than reuse the old verdict.
  const h = harness({ statusResponse: 'unknown', days: oneDay(dayKey(2026, 11, 8), 3600) });
  h.store.reportEmail = 'someone-else@example.com';
  h.store.report_state = { ...h.store.report_state, status: 'verified',
                           subscribedEmail: 'owner@example.com' };
  check('a changed, unconfirmed address is not mailed', await h.send(), 'not_verified');
  check('no /send request issued for it',
    h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  check('it did re-check instead of trusting the stale verdict',
    h.calls.filter(c => c.url.endsWith('/status')).length, 1);
}

// ── 7. nothing tracked ──────────────────────────────────────────────────────
console.log('\n--- an empty window ---');
{
  const h = harness();                      // no day data at all
  check('no email for an empty window', await h.send(), 'empty');
  check('no /send request', h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  check('window recorded so it is not reconsidered',
    Object.keys(h.state().sent), [`daily:${dayKey(2026, 11, 8)}`]);
}

// ── 8. failures must not mark the window sent ───────────────────────────────
console.log('\n--- a failed send is retried within the same morning ---');
{
  const h = harness({ serverStatus: 'send_failed', days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('reports failure', await h.send(), 'failed');
  check('window NOT recorded as sent', Object.keys(h.state().sent), []);
  h.setNow(at(2026, 11, 9, 10));
  check('retries later the same morning', (await h.send()) !== 'already_sent', true);
}
{
  const h = harness({ serverStatus: 'duplicate', days: oneDay(dayKey(2026, 11, 8), 3600) });
  check('backend already had it -> treated as sent', await h.send(), 'already_sent');
  check('recorded locally so the two agree',
    Object.keys(h.state().sent), [`daily:${dayKey(2026, 11, 8)}`]);
}

// ── 9. subscribing resets consent state ─────────────────────────────────────
console.log('\n--- subscribing a new address ---');
{
  const h = harness();
  h.state().sent = { 'daily:data_2026_11_01': 'sent' };
  check('returns pending', await h.subscribe('new@example.com'), 'pending');
  check('status is pending, not verified', h.state().status, 'pending');
  check('subscribed address recorded', h.state().subscribedEmail, 'new@example.com');
  check('send history cleared for the new address', h.state().sent, {});
}

// ── 10. send history does not grow forever ──────────────────────────────────
console.log('\n--- pruning send history ---');
{
  const h = harness();
  const pruned = await h.prune({
    [`daily:${dayKey(2026, 11, 8)}`]: 'sent',      // recent
    [`weekly:${dayKey(2026, 11, 2)}`]: 'sent',     // recent
    [`daily:${dayKey(2026, 1, 5)}`]: 'sent',       // long past
    'nonsense-key': 'sent',
  }, at(2026, 11, 9, 9), 40);
  check('keeps recent windows, drops old and malformed', Object.keys(pruned).sort(),
    [`daily:${dayKey(2026, 11, 8)}`, `weekly:${dayKey(2026, 11, 2)}`].sort());
}

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
