#!/usr/bin/env node
/**
 * Privacy guards, driven through the real worker, categorizer and report code.
 *
 * Each scenario here was a confirmed leak or cost bug found in audit:
 *   - navigating to an EXCLUDED site sent its title (and sometimes its
 *     hostname) for classification and stored it;
 *   - a site the backend answered "Other" for was re-sent every minute;
 *   - a report carried every site, which production's WAF refuses over 8 KB.
 *
 * Usage:  node test/verify-privacy-guards.mjs
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function harness({ backendCategory = 'Other', excluded = [] } = {}) {
  let now = 1_700_000_000_000;
  const store = { excluded_domains: excluded };
  const session = {};
  const listeners = {};
  const on = (name) => (fn) => (listeners[name] ||= []).push(fn);
  const fire = async (name, ...args) => { for (const fn of listeners[name] || []) await fn(...args); };
  const sent = [];
  let tab = { id: 1, url: 'about:blank', title: '', active: true };
  const ctx = createContext({
    console, JSON, Object, Array, String, Number, Boolean, Math, RegExp, Promise, Error, URL, Set, Map,
    isNaN, parseInt, parseFloat, Uint8Array, crypto: globalThis.crypto,
    AbortSignal: { timeout: () => undefined },
    fetch: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ category: backendCategory }) }; },
    Date: new Proxy(Date, {
      construct: (T, a) => (a.length ? new T(...a) : new T(now)),
      apply: () => new Date(now).toString(),
      get: (T, prop, recv) => (prop === 'now' ? () => now : Reflect.get(T, prop, recv)),
    }),
    setTimeout: (fn) => fn(),
    importScripts: () => {},
    Logger: { init: async () => {}, info() {}, warn() {}, error() {}, debug() {} },
    chrome: {
      runtime: { id: 'test', lastError: null, getManifest: () => ({ name: 'SecureView' }), onMessage: { addListener: on('msg') }, onInstalled: { addListener: on('installed') }, onStartup: { addListener: on('startup') }, setUninstallURL() {}, OnInstalledReason: { INSTALL: 'install' } },
      storage: {
        local: {
          get: (keys, cb) => { const r = keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]])); return cb ? cb(r) : Promise.resolve(r); },
          set: (items, cb) => { Object.assign(store, JSON.parse(JSON.stringify(items))); cb && cb(); return Promise.resolve(); },
          remove: (keys, cb) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]); cb && cb(); },
        },
        session: { get: (keys, cb) => cb({}), set: (i, cb) => { cb && cb(); } },
        onChanged: { addListener: on('storage') },
      },
      tabs: { query: async () => [tab], get: async () => tab, create() {}, onActivated: { addListener: on('activated') }, onUpdated: { addListener: on('updated') }, onRemoved: { addListener: on('removed') } },
      windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: on('focus') } },
      idle: { setDetectionInterval() {}, onStateChanged: { addListener: on('idle') } },
      alarms: { get: (n, cb) => cb(null), create() {}, clear() {}, onAlarm: { addListener: on('alarm') } },
    },
  });
  for (const f of ['shared/config.js', 'shared/categories.js', 'shared/categorizer.js', 'shared/report.js', 'shared/reporter.js', 'background/background.js'])
    runInContext(readFileSync('chrome/' + f, 'utf8'), ctx, { filename: f });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return {
    sent, store, settle,
    advance: (s) => { now += s * 1000; },
    load: async (url, title) => { tab = { ...tab, url, title }; await fire('updated', tab.id, { status: 'complete' }, tab); await settle(); },
    // Chrome's real order for a same-tab navigation: commit (url), then title, then complete.
    commit: async (url) => { tab = { ...tab, url, title: url }; await fire('updated', tab.id, { status: 'loading', url }, tab); await settle(); },
    title: async (title) => { tab = { ...tab, title }; await fire('updated', tab.id, { title }, tab); await settle(); },
    pageReady: async (title) => { for (const fn of listeners.msg) fn({ type: 'PAGE_READY', title }, { id: 'test', tab }, () => {}); await settle(); },
    complete: async () => { await fire('updated', tab.id, { status: 'complete' }, tab); await settle(); },
    tick: async () => { await fire('alarm', { name: 'tick' }); await settle(); },
    build: (...a) => ctx.buildReportData(...a),
    today: () => store[Object.keys(store).find(k => /^data_/.test(k))] || { domains: {} },
  };
}


const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${JSON.stringify(got)})`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log('--- leaving a tracked site for an excluded one, same tab ---');
{
  const h = harness({ excluded: ['intranet.corp.example'] });
  await h.load('https://plain-blog.example/?q=secret#frag', 'A plain blog');
  const before = h.sent.length;
  h.advance(20);
  // Chrome's order: commit, then the new page's title, then "complete". The
  // content script's PAGE_READY can land anywhere after commit.
  await h.commit('https://intranet.corp.example/payroll');
  await h.title('Payroll - salary review');
  await h.pageReady('Payroll - salary review');
  await h.complete();
  check('nothing is sent for classification', h.sent.slice(before), []);
  const entries = Object.values(h.today().domains);
  check('the excluded site is not stored', entries.map(d => d.hostname), ['plain-blog.example']);
  check('its title is not stored against the previous site', entries[0].title, 'A plain blog');
  check('only the origin of a URL is stored', entries[0].url, 'https://plain-blog.example/');
  check('requests carry hostname and title only', Object.keys(h.sent[0]).sort(), ['hostname', 'title']);
}

console.log('\n--- between two tracked sites, the title follows the page ---');
{
  const h = harness({ backendCategory: 'Technology' });
  await h.load('https://first.example/', 'First');
  await h.commit('https://second.example/');
  await h.title('Second');
  await h.complete();
  const d = h.today().domains;
  check('first keeps its own title', d['first.example'].title, 'First');
  check('second gets its own', d['second.example'].title, 'Second');
}

console.log('\n--- a site the backend cannot place is not re-sent every minute ---');
{
  const h = harness({ backendCategory: 'Other' });
  await h.load('https://unknown-site.example/', 'Some page');
  for (let i = 0; i < 10; i++) { h.advance(60); await h.tick(); }
  check('one request in ten minutes', h.sent.length, 1);
  h.advance(25 * 3600); await h.tick();
  check('asked again after a day', h.sent.length, 2);
}

console.log('\n--- a report payload stays under the WAF body limit ---');
{
  const h = harness();
  const day = { domains: {} };
  for (let i = 0; i < 600; i++) {
    const hostname = `a-fairly-long-subdomain-${i}.some-site-with-a-long-name.example.com`;
    day.domains[hostname] = { hostname, seconds: 600 - i, category: 'Technology', lastVisit: i };
  }
  day.domains['zero.example'] = { hostname: 'zero.example', seconds: 0, category: 'Other', lastVisit: 1 };
  day.domains['hidden.example'] = { hostname: 'hidden.example', seconds: 99999, category: 'Shopping', lastVisit: 1 };
  const now = new Date(2026, 10, 9, 9, 0, 0);
  const report = h.build('daily', { data_2026_11_08: day }, now, ['hidden.example']);
  const size = JSON.stringify({ email: 'x'.repeat(254), clientId: 'c'.repeat(48), report }).length;
  check('body is under 8 KB', size < 8192, true);
  check('the site count still covers every counted site', report.siteCount, 600);
  check('totals cover every counted site', report.totalSeconds, (600 * 601) / 2);
  check('an excluded site is not in it', JSON.stringify(report).includes('hidden.example'), false);
  check('a zero-second site is not in it', JSON.stringify(report).includes('zero.example'), false);
  check('top sites come first', report.domains[0].seconds, 600);
}

if (failures.length) { console.log(`\n${failures.length} FAILURE(S)`); failures.forEach(f => console.log('  ' + f)); process.exit(1); }
console.log('\nALL CHECKS PASS');
