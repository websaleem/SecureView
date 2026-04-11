# SecureView

## Overview

SecureView is a Chrome Extension (Manifest V3) that gives you a clear picture of how you spend your time online. It tracks active browsing time per site, automatically categorizes every domain into one of 11 categories (Technology, Entertainment, Productivity, etc.), and surfaces the data through a clean popup UI with daily history and search. For sites it cannot classify by rule, it falls back to Amazon Bedrock via a serverless AWS pipeline — keeping your API key out of the extension entirely. Built with pure vanilla JavaScript; no build step, no dependencies.

## Loading the Extension for Testing

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory
4. After code changes, click the reload button on the extension card

## Architecture

The extension has four runtime components that communicate via Chrome APIs:

**`background/background.js` (Service Worker)** — The core tracking engine. Maintains session state in `chrome.storage.session` (key: `sv_session`) so it survives service worker restarts. Tracks active tab, window focus, and idle state. Flushes accumulated time to `chrome.storage.local` every 60 seconds via an alarm, and also on every tab switch.

**`content/content_script.js`** — Injected into all pages. Detects user activity (mouse, keyboard, scroll) and sends `USER_ACTIVE` messages to the background SW every 10 seconds while active. Also uses Page Visibility API to resume tracking when a tab regains focus.

**`popup/popup.html` + `popup.js` + `popup.css`** — The extension popup UI. Reads today's data directly from `chrome.storage.local`, renders category/site views, supports search, and shows a history overlay for past days. Never writes to storage.

**`shared/logger.js`** — Loaded in all four contexts (background SW, content script, popup, categorizer). Provides `Logger.debug/info/warn/error(module, message, ...args)`. Every log line is prefixed with a timestamp (`YYYY-MM-DD HH:MM:SS.mmm`), level, and module name. Errors always print; all other levels are gated by the `enabled` flag. Toggle without reloading the extension:
```js
chrome.storage.local.set({ debug_config: { enabled: true } })  // enable
chrome.storage.local.set({ debug_config: { enabled: false } }) // disable
```

**`shared/categories.js`** — Shared module imported by both `background.js` (via `importScripts`) and `popup.html` (via `<script>`). Defines 11 categories with domain lists, keyword patterns, icons, and colors. Matching order: exact domain → root domain → keyword scan.

**`shared/categorizer.js`** — Imported by `background.js` via `importScripts`. Provides `categorizeUrlEnhanced(url, title)`, an async drop-in for `categorizeUrl()`. Rule-based first; for "Other" domains it calls a CloudFront distribution. Flow: `CloudFront → Lambda@Edge (viewer-request validates x-origin-token, injects real x-api-key) → API Gateway → Lambda → Bedrock`. The real API key never leaves Lambda@Edge — the extension only holds a lightweight shared secret (`x-origin-token`). Beta and prod CloudFront URLs + origin tokens are hardcoded in `CF_CONFIGS`; active env is derived from the extension name at runtime. Retries up to 2× with exponential backoff to handle Lambda@Edge cold starts. Results cached under `br_cat_cache`. Fails silently if unreachable.

AWS setup required (per env): CloudFront distribution pointing to API Gateway as origin; Lambda@Edge viewer-request function that validates `x-origin-token` and injects `x-api-key`; API Gateway with API key authorization; Lambda function that calls Amazon Bedrock for classification.


## Storage Schema

**Session state** (`chrome.storage.session`, key: `sv_session`):
```json
{ "currentUrl": "...", "activeTabId": 123, "sessionStart": 1712520000000, "isWindowFocused": true, "isUserIdle": false }
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
| Activity debounce | 10s | Content script reporting interval |
| Flush cycle | 60s | Background alarm tick |

## Important Design Constraints

- **MV3 service worker lifecycle**: The SW can be killed at any time. All mutable state must be written to `chrome.storage.session` before being read back. `ensureTracking()` re-establishes context after restarts.
- **No double-counting**: `flushTime()` advances `sessionStart` to `Date.now()` after each flush, so the same time interval is never counted twice.
- **Date partitioning**: Daily data resets automatically because storage keys use `data_YYYY_MM_DD` format — no explicit reset logic needed.
- **`shared/categories.js` is shared**: Changes to categorization logic affect both tracking (what gets saved) and display (how it's shown). Test both popup views after any change.
