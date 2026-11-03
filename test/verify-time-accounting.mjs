#!/usr/bin/env node
/**
 * Drives the real background service worker through timed scenarios.
 *
 * The bug this guards: chrome.idle measures from the user's last INPUT, not
 * from when a page opened, so with a 60s threshold a page that took 5s to load
 * froze its timer at 55s and never moved again however long the user read.
 * Reading generates no input, so the most ordinary use of a browser was being
 * recorded as absence.
 *
 * Everything here runs against chrome/background/background.js itself with a
 * fake clock and stubbed chrome APIs, so it measures the shipped accounting
 * rather than a restatement of it.
 *
 * Usage:  node test/verify-time-accounting.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${JSON.stringify(got)})`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function harness() {
  let now = 1_700_000_000_000;
  const store = {};
  const session = {};
  const listeners = {};
  const on = (name) => (fn) => (listeners[name] ||= []).push(fn);
  const fire = async (name, ...args) => {
    for (const fn of listeners[name] || []) await fn(...args);
  };

  let tab = { id: 1, url: 'https://google.com/', title: 'Google', active: true };

  const ctx = createContext({
    console, JSON, Object, Array, String, Number, Boolean, Math, RegExp, Promise, Error, URL, Set, Map,
    isNaN, parseInt, parseFloat,
    // Date.now() is what the accounting reads, and it is a static property —
    // intercepting only construct() leaves it returning the real wall clock,
    // which made every scenario measure a span of roughly minus 26 years.
    Date: new Proxy(Date, {
      construct: (T, a) => (a.length ? new T(...a) : new T(now)),
      apply: () => new Date(now).toString(),
      get: (T, prop, recv) => (prop === 'now' ? () => now : Reflect.get(T, prop, recv)),
    }),
    setTimeout: (fn) => fn(),
    importScripts: () => {},
    // Minimal stand-ins for the modules background.js importScripts().
    Logger: { init: async () => {}, info() {}, warn() {}, error() {}, debug() {} },
    isSafeHostKey: (h) => typeof h === 'string' && h.length > 0 && !['__proto__', 'constructor', 'prototype'].includes(h),
    categorizeUrlEnhanced: async () => ({ name: 'Technology', icon: '💻', color: '#2ECC71' }),
    getCFConfig: () => ({ url: 'https://example.invalid/categorize' }),
    chrome: {
      runtime: { id: 'test', lastError: null, onMessage: { addListener: on('msg') }, onInstalled: { addListener: on('installed') }, onStartup: { addListener: on('startup') }, setUninstallURL() {}, OnInstalledReason: { INSTALL: 'install' } },
      storage: {
        local: {
          get: (keys, cb) => cb(keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]))),
          set: (items, cb) => { Object.assign(store, items); cb && cb(); },
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); cb && cb(); },
        },
        session: {
          get: (keys, cb) => cb(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in session).map(k => [k, session[k]]))),
          set: (items, cb) => { Object.assign(session, items); cb && cb(); },
        },
        onChanged: { addListener: on('storage') },
      },
      tabs: {
        query: async () => [tab],
        get: async () => tab,
        create() {},
        onActivated: { addListener: on('activated') },
        onUpdated: { addListener: on('updated') },
        onRemoved: { addListener: on('removed') },
      },
      windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: on('focus') } },
      idle: { setDetectionInterval() {}, onStateChanged: { addListener: on('idle') } },
      alarms: { get: (n, cb) => cb(null), create() {}, clear() {}, onAlarm: { addListener: on('alarm') } },
    },
  });

  runInContext(readFileSync('chrome/background/background.js', 'utf8'), ctx);

  const api = {
    advance: (sec) => { now += sec * 1000; },
    navigate: async (url) => { tab = { ...tab, url }; await fire('updated', tab.id, { status: 'complete' }, tab); },
    idle: (state) => fire('idle', state),
    blur: () => fire('focus', -1),
    tick: () => fire('alarm', { name: 'tick' }),
    seconds: (host) => {
      const key = Object.keys(store).find(k => /^data_\d{4}_\d{2}_\d{2}$/.test(k));
      const d = key && store[key].domains[host];
      return d ? d.seconds : 0;
    },
  };
  return api;
}

// ── 1. The reported bug: read a page for 5 minutes, touching nothing. ────────
// Old behaviour: idle at 60s (minus load delay) froze the timer at ~55s.
{
  console.log('\n--- reading for 5 min with no input (the reported bug) ---');
  const h = harness();
  await h.navigate('https://google.com/');
  h.advance(180); await h.idle('idle');     // threshold is now 180s
  for (let i = 0; i < 4; i++) { h.advance(30); await h.tick(); }
  check('counts the full 5 min, not ~55s', h.seconds('google.com'), 300);
}

// ── 1b. The exact reported test: google.com, >1 min, timer showed 55s. ──────
// The page became tracked ~5s after the keystroke that navigated to it, so the
// idle countdown was already 5s spent; at 60s the old build froze the timer at
// 55s. The session clock and the idle clock starting at different instants is
// the whole defect, so assert on real presence, not on the threshold.
{
  console.log('\n--- google.com: loads 5s after the keystroke, user stays 90s ---');
  const h = harness();
  h.advance(5);                               // DNS + load, before tracking starts
  await h.navigate('https://google.com/');
  h.advance(55); await h.idle('idle');        // idle arrives 60s after the keystroke
  h.advance(35); await h.tick();              // user is still reading
  check('credits the 90s actually spent, not 55', h.seconds('google.com'), 90);
}

// ── 2. Walked away: the over-count must be bounded, not unlimited. ───────────
{
  console.log('\n--- idle with window focused for 60 min (walked away) ---');
  const h = harness();
  await h.navigate('https://google.com/');
  h.advance(180); await h.idle('idle');
  for (let i = 0; i < 60; i++) { h.advance(60); await h.tick(); }
  // 180s attended + a 10 min unattended grace, then the session closes.
  check('capped at threshold + 10 min grace', h.seconds('google.com'), 180 + 600);
}

// ── 3. A locked screen is unambiguous absence — stop immediately. ────────────
{
  console.log('\n--- screen locked ---');
  const h = harness();
  await h.navigate('https://google.com/');
  h.advance(120); await h.idle('locked');
  h.advance(600); await h.tick();
  check('stops at the lock, no grace', h.seconds('google.com'), 120);
}

// ── 4. Losing window focus is absence too. ──────────────────────────────────
{
  console.log('\n--- window blurred ---');
  const h = harness();
  await h.navigate('https://google.com/');
  h.advance(90); await h.blur();
  h.advance(600); await h.tick();
  check('stops at the blur', h.seconds('google.com'), 90);
}

// ── 5. Returning to the keyboard resumes, and does not back-credit. ─────────
{
  console.log('\n--- idle, then real input 20 min later ---');
  const h = harness();
  await h.navigate('https://google.com/');
  h.advance(180); await h.idle('idle');
  for (let i = 0; i < 20; i++) { h.advance(60); await h.tick(); }  // session closes at the cap
  await h.idle('active');                                          // user returns
  h.advance(60); await h.tick();
  check('grace counted once, then the new span', h.seconds('google.com'), 180 + 600 + 60);
}

// ── 6. Active input must never reset a running clock (would drop a span). ────
{
  console.log('\n--- continuous activity ---');
  const h = harness();
  await h.navigate('https://google.com/');
  for (let i = 0; i < 5; i++) { h.advance(60); await h.idle('active'); await h.tick(); }
  check('no seconds lost to active events', h.seconds('google.com'), 300);
}

// ── 8. shouldTrack is an allowlist: only http/https is browsing. ───────────
{
  console.log('\n--- non-web schemes are not tracked ---');
  for (const [url, tracked] of [
    ['https://google.com/', true],
    ['http://example.com/', true],
    ['chrome://settings/', false],
    ['chrome-untrusted://whatever/', false],
    ['devtools://devtools/bundled/x.html', false],
    ['data:text/html,<h1>hi</h1>', false],
    ['blob:https://example.com/abc-123', false],
    ['brave://settings/', false],
    ['view-source:https://example.com/', false],
    ['file:///Users/x/secret.html', false],
    ['not a url at all', false],
  ]) {
    const h = harness();
    await h.navigate(url);
    h.advance(120); await h.tick();
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const got = host ? h.seconds(host) : 0;
    check(`${tracked ? 'tracks' : 'ignores'} ${url.slice(0, 38)}`, got > 0, tracked);
  }
}

// ── 9. Category icons: no backend category falls through to the globe. ──────
{
  console.log('\n--- icon lookup for every category the backend can return ---');
  const { readFileSync: rf } = await import('node:fs');
  const vm = await import('node:vm');
  const ictx = vm.createContext({
    console, Object, Array, String, Number, Math, RegExp, JSON,
    chrome: { storage: { local: { get: (k, cb) => cb({}) }, onChanged: { addListener() {} } }, runtime: {} },
    Logger: { info() {}, warn() {}, debug() {}, error() {} },
    getCFConfig: () => ({ url: '' }), AbortSignal: { timeout() {} }, fetch: async () => ({}),
  });
  vm.runInContext(rf('chrome/shared/categories.js', 'utf8'), ictx);
  vm.runInContext(rf('chrome/shared/categorizer.js', 'utf8'), ictx);

  const backend = [...rf('backend/lambda/bedrock/lambda_function.py', 'utf8')
    .match(/CATEGORIES = \[(.*?)\]/s)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const generic = backend.filter(c => {
    const r = vm.runInContext(`getIconForCategory(${JSON.stringify(c)})`, ictx);
    return c !== 'Other' && r.icon === '🌐';
  });
  check('every category except "Other" has a real icon', generic, []);
  const sports = vm.runInContext('getIconForCategory("Sports")', ictx);
  check('Sports gets the trophy, not Entertainment\'s film', sports.icon, '🏆');
  const esports = vm.runInContext('getIconForCategory("Esports")', ictx);
  check('Esports still lands on Gaming', esports.icon, '🎮');
}

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
