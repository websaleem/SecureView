# SecureView

## Overview

SecureView is a Chrome Extension (Manifest V3) that gives you a clear picture of how you spend your time online. It tracks active browsing time per site, automatically categorizes every domain into one of many categories (Technology, Entertainment, Productivity, and more), and surfaces the data through a clean popup UI. The popup has a **Today / Last 7 days** toggle: today gives you the live picture, while the 7-day view aggregates the last week and shows a per-day breakdown so you can see how your time shifted across days. For sites it cannot classify by rule, it falls back to Amazon Bedrock via a serverless AWS pipeline — keeping your API key out of the extension entirely. Only the URL's protocol/host/path is sent for categorization; query strings and fragments are stripped client-side so search terms, auth tokens, and session ids never leave the device. Categorization happens immediately when a page loads, driven by the content script. The popup updates live as soon as a category is written to storage. Built with pure vanilla JavaScript; no build step, no dependencies.

## Installation

Install SecureView from the [Chrome Web Store](https://chromewebstore.google.com/detail/secureview/ojhmodiiehcingcnhlglenenoemmegim).

## Loading the Extension for Testing

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After code changes, click the reload button on the extension card

## Releasing

SecureView ships through two Chrome Web Store entries:

| Channel | Store entry name | Trigger | Workflow |
|---|---|---|---|
| Production | `SecureView` | tag `v1.2.3` | `.github/workflows/release.yml` |
| Beta | `SecureView Beta` | tag `v1.2.3-beta` | `.github/workflows/release-beta.yml` |

Both workflows can also be run on demand via **Actions → Run workflow**.

### Local build

`scripts/build-zip.sh` reads the version from `manifest.json` and produces a Chrome-Web-Store-ready zip. The beta channel rewrites `manifest.name` to `SecureView Beta` in a staged copy — your source tree is never mutated.

```bash
./scripts/build-zip.sh                     # SecureView-<version>.zip
CHANNEL=beta ./scripts/build-zip.sh        # SecureView-Beta-<version>.zip
```

### Shipping a release

```bash
# 1. Bump version in manifest.json and commit.
# 2. Tag and push:
git tag v1.0.5         # production
# or
git tag v1.0.5-beta    # beta
git push origin v1.0.5

# 3. Watch the workflow in GitHub Actions; it will:
#    - re-validate the tag matches manifest.version
#    - build the zip with the right channel
#    - upload + auto-publish via chrome-webstore-upload-cli
#    - archive the zip as a workflow artifact for 90 days
```

Chrome Web Store review usually clears within a few hours for an established item.

### One-time setup — Chrome Web Store API credentials

Required GitHub Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Used by | Notes |
|---|---|---|
| `CWS_CLIENT_ID` | both | OAuth client id from Google Cloud |
| `CWS_CLIENT_SECRET` | both | OAuth client secret |
| `CWS_REFRESH_TOKEN` | both | OAuth refresh token (long-lived) |
| `CWS_EXTENSION_ID` | production | id of the production listing |
| `CWS_EXTENSION_ID_BETA` | beta | id of the separate beta listing |
| `MAIL_USERNAME` | both (notify) | sender Gmail address (e.g. `you@gmail.com`) |
| `MAIL_APP_PASSWORD` | both (notify) | Google **App Password** (16 chars), not your account password |
| `MAIL_TO` | both (notify) | recipient address for deployment notifications |

The first three CWS values are tied to your Google account and shared across channels; the extension ids differ because the two listings are independent items in the store. The mail secrets feed a `notify` job at the end of each workflow that emails the result (success or failure) with a link to the run.

#### Generating client_id, client_secret, refresh_token

1. **Google Cloud Console** → create or pick a project → **APIs & Services → Library** → enable **Chrome Web Store API**.
2. **APIs & Services → OAuth consent screen** → user type **External** is fine; add yourself as a Test User. No need to publish.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type **Desktop app**. Save the JSON. The `client_id` and `client_secret` from this file are your first two GitHub secrets.
4. Generate the refresh token via the OAuth Playground (one-off — keep the result safe):
   - Open <https://developers.google.com/oauthplayground>
   - Click the gear icon → check **Use your own OAuth credentials** → paste your `client_id` + `client_secret`.
   - In **Step 1**, scroll to **Chrome Web Store API**, select scope `https://www.googleapis.com/auth/chromewebstore`, then **Authorize APIs**. Sign in with the Google account that owns the listings; consent.
   - In **Step 2**, click **Exchange authorization code for tokens**. The `Refresh token` displayed is your `CWS_REFRESH_TOKEN`. It does not expire on its own.
5. Copy the extension ids from the Chrome Web Store dashboard (URL: `https://chrome.google.com/webstore/devconsole/<account>/<extension-id>`) and put them in `CWS_EXTENSION_ID` (production) and `CWS_EXTENSION_ID_BETA`.

If `auto-publish` ever fails with `ITEM_PENDING_REVIEW` or similar, the upload still landed — you can finish the publish manually from the developer dashboard.

#### Generating the Gmail App Password (for deployment notifications)

Gmail no longer accepts plain account passwords for SMTP — you need an App Password (16-character one-time string scoped to a single use).

1. Make sure 2-Step Verification is on for the Google account: <https://myaccount.google.com/security> → **2-Step Verification** → enable.
2. Go to <https://myaccount.google.com/apppasswords>.
3. **App name** → enter `SecureView CI` (any label is fine) → **Create**.
4. Copy the 16-character password Google shows (with or without spaces — both work). It's only shown once.
5. Paste into the GitHub secret `MAIL_APP_PASSWORD`. Set `MAIL_USERNAME` to the same Gmail address you generated it from, and `MAIL_TO` to whichever address should receive the alerts (often the same one).

If the Gmail account doesn't have 2-Step Verification, the **App passwords** page won't appear at all. Enable 2SV first.

The notify job runs `if: always()` after the publish step, so you'll get a "success" email when a release ships and a "failed" email when something breaks. The subject line carries the channel and outcome, e.g. `[SecureView · production · success] v1.0.5` — easy to filter in your inbox.

## Architecture

### End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                          │
│                                                                  │
│  ┌─────────────────┐  PAGE_READY      ┌──────────────────────┐  │
│  │ content_        │  (title+url)     │ background.js        │  │
│  │ script.js       │ ───────────────▶ │ (Service Worker)     │  │
│  │                 │  USER_ACTIVE     │                      │  │
│  │ • Sends title   │ ───────────────▶ │ • Tracks active tab  │  │
│  │   on doc ready  │                  │ • Measures dwell time│  │
│  │ • Watches <title│                  │ • Eager categorize   │  │
│  │   > for SPA     │                  │   on PAGE_READY      │  │
│  │   changes       │                  │ • Flushes every 60s  │  │
│  └─────────────────┘                  └──────────┬───────────┘  │
│                                                  │              │
│  ┌──────────────────────────────────────┐        │ categorize   │
│  │ popup.html / popup.js / popup.css    │        ▼              │
│  │                                      │  ┌─────────────────┐  │
│  │ • Category + site views              │  │ categorizer.js  │  │
│  │ • Today / 7-day + per-day breakdown  │  │                 │  │
│  │ • Live-updates via                   │  │ 1. Rule-based   │  │
│  │   storage.onChanged                  │  │    (categories  │  │
│  └──────────────────────────────────────┘  │    .js)         │  │
│           ▲  storage update                │ 2. AI fallback  │  │
│           └────────────────────────────────│    for "Other"  │  │
│                                            └────────┬────────┘  │
│  ┌──────────────────────────────────────┐           │           │
│  │ shared/logger.js                     │           │           │
│  │ shared/categories.js                 │           │           │
│  └──────────────────────────────────────┘           │           │
└────────────────────────────────────────────────────┼────────────┘
                                                      │ HTTPS
                                                      │ x-origin-token
                                                      ▼
                                             ┌─────────────────┐
                                             │   CloudFront    │
                                             │  Distribution   │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │  Lambda@Edge    │
                                             │ viewer-request  │
                                             │                 │
                                             │ • Validates     │
                                             │   x-origin-token│
                                             │ • Injects real  │
                                             │   x-api-key     │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │   API Gateway   │
                                             │  (API key auth) │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │     Lambda      │
                                             │  (classifier)   │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │  Amazon Bedrock │
                                             │ (AI category    │
                                             │  inference)     │
                                             └─────────────────┘
```

The AI pipeline is only invoked for domains that fall through rule-based matching as "Other" (or for all domains when `force_cloudfront` is enabled). Results are cached in `chrome.storage.local` under `br_cat_cache` so each domain is classified at most once. The real AWS API key never leaves Lambda@Edge — the extension holds only a lightweight shared secret (`x-origin-token`).

Categorization is triggered **immediately** when the content script sends `PAGE_READY` (on `document` load complete, and again whenever `<title>` changes for SPAs). The result is written to the domain entry in `chrome.storage.local` right away, and the open popup re-renders via `storage.onChanged`.

### Extension Components

The extension has four runtime components that communicate via Chrome APIs:

**`background/background.js` (Service Worker)** — The core tracking engine. Maintains session state in `chrome.storage.session` (key: `sv_session`) so it survives service worker restarts. Tracks active tab, window focus, and idle state. On every tab switch or `PAGE_READY` message it calls `triggerEagerCategorization()`, which immediately classifies the URL+title and writes the result to the domain entry — no waiting for the alarm. Flushes accumulated dwell time to `chrome.storage.local` every 60 seconds via an alarm, and also on every tab switch. On first install (`onInstalled` reason `"install"`) opens `https://www.websaleem.com/secureview/success.html` in a new tab. `setUninstallURL` points to `https://www.websaleem.com/secureview/uninstall.html` so Chrome opens it automatically when the extension is removed.

**`content/content_script.js`** — Injected into all pages. Sends `PAGE_READY` (`{ title, url }`) to the background as soon as `document` load fires; re-sends whenever the `<title>` element changes (MutationObserver) to catch SPA navigation; re-sends on `visibilitychange` when the tab becomes visible again. Also detects user activity (mouse, keyboard, scroll) and sends `USER_ACTIVE` every 10 seconds while active.

**`popup/popup.html` + `popup.js` + `popup.css`** — The extension popup UI. Two render modes selected by the **Today / Last 7 days** toggle: today reads `data_YYYY_MM_DD` directly, while the 7-day view runs `loadWeekData()` which aggregates the last 7 daily records into the same `{ domains, categories, totalSeconds, byDay }` shape (per-domain seconds summed; category fields taken from the most-recent visit so re-categorized domains show their latest label). In week mode the popup renders an extra `#day-breakdown` strip — 7 mini-bars sized proportionally to the busiest day — so you can see when you actually spent the time. The "Now:" indicator and exclude/clear flow always operate on today's data regardless of which period is on screen, so toggling to week mode never accidentally wipes history. Subscribes to `chrome.storage.onChanged` for any `data_*` key so today and week views both update live the moment the background writes a categorization result — without reopening the popup.

**`shared/logger.js`** — Loaded in all four contexts (background SW, content script, popup, categorizer). Provides `Logger.debug/info/warn/error(module, message, ...args)`. Every log line is prefixed with a timestamp (`YYYY-MM-DD HH:MM:SS.mmm`), level, and module name. Errors always print; all other levels are gated by the `debug_config` flag (see Runtime Settings Flags below).

**`shared/categories.js`** — Shared module imported by both `background.js` (via `importScripts`) and `popup.html` (via `<script>`). Defines categories with domain lists, keyword patterns, icons, and colors. Matching order: exact domain → root domain → keyword scan.

**`shared/categorizer.js`** — Imported by `background.js` via `importScripts`. Provides `categorizeUrlEnhanced(url, title)`, an async drop-in for `categorizeUrl()`. Rule-based first; for "Other" domains it calls a CloudFront distribution. Flow: `CloudFront → Lambda@Edge (viewer-request validates x-origin-token, injects real x-api-key) → API Gateway → Lambda → Bedrock`. The real API key never leaves Lambda@Edge — the extension only holds a lightweight shared secret (`x-origin-token`). The single hardcoded `CF_CONFIG` is shared by both build channels today; if/when the origin token is rotated per channel, restore a beta/prod split in this constant and update the Lambda@Edge validator. Before the request leaves the device, `_safeUrlForApi(url)` strips the query string and fragment so only `protocol://host/path` is sent — query params and hashes are where session tokens, search terms, and PII tend to sit. Retries up to 2× with exponential backoff to handle Lambda@Edge cold starts. Results cached under `br_cat_cache`. Fails silently if unreachable.

AWS setup required (per env): CloudFront distribution pointing to API Gateway as origin; Lambda@Edge viewer-request function that validates `x-origin-token` and injects `x-api-key`; API Gateway with API key authorization; Lambda function that calls Amazon Bedrock for classification.

### Runtime Settings Flags

Both flags are toggled live via `chrome.storage.local` — no extension reload required. Open DevTools on any extension page (background SW, popup) and run:

| Flag | Storage key | Effect |
|---|---|---|
| Debug logging | `debug_config` | Enables/disables all `Logger.debug/info/warn` output across every context. Errors always print. On by default in beta builds; off in prod. |
| Force AI classification | `force_cloudfront` | Bypasses rule-based matching for all sites and sends every URL straight to the AWS pipeline. Useful for testing Bedrock responses against known domains. Browser-internal pages (`chrome://`, `about:`) are always classified locally regardless of this flag. |

```js
// Debug logging
chrome.storage.local.set({ debug_config: { enabled: true } })   // enable
chrome.storage.local.set({ debug_config: { enabled: false } })  // disable

// Force AI classification (skip rule-based matching)
chrome.storage.local.set({ force_cloudfront: true })   // enable
chrome.storage.local.set({ force_cloudfront: false })  // disable
```

Both flags are watched via `chrome.storage.onChanged`, so changes take effect immediately in all active contexts.

## Storage Schema

**Session state** (`chrome.storage.session`, key: `sv_session`):
```json
{ "currentUrl": "...", "activeTabId": 123, "currentTabTitle": "Page Title", "sessionStart": 1712520000000, "isWindowFocused": true, "isUserIdle": false }
```

**Daily data** (`chrome.storage.local`, key: `data_YYYY_MM_DD`):
```json
{
  "domains": { "github.com": { "seconds": 3600, "category": "Technology", ... } },
  "categories": { "Technology": { "seconds": 3600, ... } },
  "totalSeconds": 3600
}
```

## Key Timings & Thresholds

| Constant | Value | Purpose |
|---|---|---|
| Idle threshold | 60s | Chrome idle API + content script silence |
| Activity debounce | 10s | Content script `USER_ACTIVE` reporting interval |
| Flush cycle | 60s | Background alarm tick — accumulates dwell time |
| Categorization | Immediate | Triggered by `PAGE_READY` from content script on document load and `<title>` mutation |
| CloudFront timeout | 10s | Per attempt; up to 2 retries with exponential backoff |

## Important Design Constraints

- **MV3 service worker lifecycle**: The SW can be killed at any time. All mutable state must be written to `chrome.storage.session` before being read back. `ensureTracking()` re-establishes context after restarts.
- **No double-counting**: `flushTime()` advances `sessionStart` to `Date.now()` after each flush, so the same time interval is never counted twice.
- **Date partitioning**: Daily data resets automatically because storage keys use `data_YYYY_MM_DD` format — no explicit reset logic needed.
- **`shared/categories.js` is shared**: Changes to categorization logic affect both tracking (what gets saved) and display (how it's shown). Test both popup views after any change.
- **Today-anchored mutations**: `popup.js` keeps two refs — `todayData` (always today) and `displayData` (today or 7-day aggregate). Any code path that *writes* — exclude/clear, the "Now:" indicator's button, etc. — must use `todayData`, never `displayData`, otherwise toggling to week mode and excluding a site would persist a week-aggregated snapshot back into today's storage key and corrupt the daily history.
