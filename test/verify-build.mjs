#!/usr/bin/env node
/**
 * Checks that a built zip points where its channel says it does.
 *
 * The production build rewrites two files: `shared/config.js`, which the
 * service worker fetches from, and `manifest.json`, whose `host_permissions`
 * decides whether that fetch is allowed at all. Rewriting only one of them
 * produces a build that looks fine and silently fails to categorise anything —
 * which has happened once already. build-zip.sh checks it made each edit;
 * nothing until now checked the result.
 *
 * Usage:  node test/verify-build.mjs     (builds both channels, then checks)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROD = 'https://secureview.websaleem.com';
const DEV = 'https://dev.secureview.websaleem.com';

const failures = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/**
 * The host config.js actually resolves to at runtime.
 *
 * It cannot be matched as a literal: the source builds it from a split array
 * to keep it out of naive scrapers, and only the production build replaces
 * that with a plain string. Evaluating the assignment covers both shapes.
 */
function resolveHost(configPath) {
  const src = readFileSync(configPath, 'utf8');
  const line = src.match(/const _CF_HOST\s*=\s*(.+?);/s);
  if (!line) return null;
  return eval(line[1]);   // our own build output, not third-party input
}

/** Every shipped text file, so a stray host cannot hide in one we forgot. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|html|json)$/.test(full)) out.push(full);
  }
  return out;
}

function containsHost(dir, host) {
  // The dev host contains the prod host's domain, so strip dev occurrences
  // before looking for prod ones or every beta build reports a prod leak.
  const text = walk(dir).map(f => readFileSync(f, 'utf8')).join('\n');
  return host === PROD ? text.replaceAll(DEV, '').includes(PROD) : text.includes(DEV);
}

function verify(channel, expected, forbidden) {
  console.log(`\n--- ${channel} ---`);
  execFileSync('./scripts/build-zip.sh', {
    env: { ...process.env, CHANNEL: channel },
    stdio: 'ignore',
  });

  const dir = `build/${channel}`;
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
  const host = resolveHost(`${dir}/shared/config.js`);

  check(`${channel}: config resolves to the right host`, host, expected);
  check(`${channel}: host_permissions`, manifest.host_permissions, [`${expected}/*`]);
  // The one that actually bites: a fetch is blocked unless these agree.
  check(`${channel}: manifest covers the host config fetches`,
    manifest.host_permissions, [`${host}/*`]);
  check(`${channel}: no ${forbidden} left in the build`,
    containsHost(dir, forbidden), false);
}

/**
 * The dev-only test-report control must be inert in a production build.
 *
 * Its markup ships in both channels; what gates it is the resolved report
 * endpoint. So the check that matters is not "is the button absent" but "does
 * the gate evaluate false" — asserted by resolving the shipped config exactly
 * as the popup does.
 */
function verifyTestReportGate(channel, expectVisible) {
  const dir = `build/${channel}`;
  const host = resolveHost(`${dir}/shared/config.js`);
  const reportBase = `${host}/report`;
  const isDev = /^https:\/\/dev\./.test(reportBase);
  check(`${channel}: test-report control ${expectVisible ? 'enabled' : 'inert'}`, isDev, expectVisible);

  // And the gate in the shipped code must be the same test, not a copy that
  // could drift — both the popup and the worker check the dev host.
  const popup = readFileSync(`${dir}/popup/popup.js`, 'utf8');
  const reporter = readFileSync(`${dir}/shared/reporter.js`, 'utf8');
  check(`${channel}: popup gates on the dev host`,
    /\/\^https:\\\/\\\/dev\\\./.test(popup), true);
  check(`${channel}: worker gates on the dev host`,
    /\/\^https:\\\/\\\/dev\\\./.test(reporter), true);
  // A production build must not be able to reach the send path at all.
  if (!expectVisible) {
    check(`${channel}: config resolves to production, so sendTestReport refuses`,
      reportBase.startsWith('https://secureview.websaleem.com'), true);
  }
}

verify('production', PROD, DEV);
verifyTestReportGate('production', false);
verify('beta', DEV, PROD);
verifyTestReportGate('beta', true);

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
