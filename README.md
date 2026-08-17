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
| Production | `SecureView` | push to `main` (chrome/** changes) | `.github/workflows/release.yml` |
| Beta | `SecureView Beta` | push to `dev` (chrome/** changes) | `.github/workflows/release.yml` |

The workflow can also be run on demand via **Actions → Run workflow**.

### Local build

`scripts/build-zip.sh` reads the version from `manifest.json` and produces a Chrome-Web-Store-ready zip. The beta channel rewrites `manifest.name` to `SecureView Beta` in a staged copy — your source tree is never mutated.

```bash
./scripts/build-zip.sh                     # → SecureView-<version>.zip
CHANNEL=beta ./scripts/build-zip.sh        # → SecureView-Beta-<version>.zip
```

There is no bundler or `npm install` step — the extension is plain JS loaded via
`<script>` and `importScripts`. For the production channel, set `PROD_CLOUDFRONT_URL` to the
production distribution's bare origin (e.g. `https://dxxxx.cloudfront.net`); the script
rewrites **both** `shared/config.js` and the `host_permissions` entry in `manifest.json`.
They have to move together — the service worker's `fetch` is blocked if `host_permissions`
doesn't cover the host it calls, so patching only the config silently breaks categorization
in the built zip.

### Shipping a release

Two conditions must BOTH hold for a push to reach the store — miss either one and
the run either never starts or builds a zip and quietly skips the upload:

1. **The commit touches `chrome/**`.** The workflow's `paths:` filter ignores
   everything else, so a docs- or workflow-only commit triggers no run at all.
2. **The commit message contains `[deploy]`.** Without it the job builds and
   archives the zip but skips the publish step. This is the gate that makes an
   ordinary push safe: routine commits to `main` never ship to users by accident.

```bash
# 1. Bump version in chrome/manifest.json (a version already live on that
#    listing is rejected by the store; the two channels version independently).
# 2. Commit with the [deploy] marker, touching something under chrome/:
git commit -m "release: 1.0.10 [deploy]"

# 3. Push to the channel's branch:
git push origin dev      # beta       -> CWS_EXTENSION_ID_BETA
git push origin main     # production -> CWS_EXTENSION_ID

# 4. Watch the workflow in GitHub Actions; it will:
#    - build the zip with the right channel (beta for dev, production for main)
#    - upload + auto-publish via chrome-webstore-upload-cli
#    - archive the zip as a workflow artifact for 90 days (even if upload fails)
```

To publish without a code change — re-running a release whose upload failed on
credentials, for instance — use **Actions → Deploy Chrome Extension → Run
workflow**, pick the branch, and tick **Publish to Chrome Web Store**. That path
bypasses both conditions above.

Chrome Web Store review usually clears within a few hours for an established item.

#### When the upload step fails

The error at `Fetching token...` tells you which of the three CWS secrets is wrong:

| Error | Meaning | Fix |
|---|---|---|
| `invalid_grant` | refresh token expired or revoked | regenerate it; check the consent screen is "In production" (see below) |
| `unauthorized_client` | token is valid but was minted by a *different* OAuth client than `CWS_CLIENT_ID`/`CWS_CLIENT_SECRET` | regenerate the token with ⚙️ **Use your own OAuth credentials** ticked, pasting the same id/secret held in the GitHub secrets |
| `invalid_client` | client id or secret itself is wrong | re-copy both from the Cloud Console credentials page |

A refresh token is bound to the client that minted it, so rotating the client
secret or creating a new OAuth client invalidates the token — update all three
secrets together, in one pass. The zip is archived as an artifact regardless, so
a failed upload can always be finished by hand from the developer dashboard
instead of re-running the build.

### One-time setup — Chrome Web Store API credentials

Required GitHub Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Used by | Notes |
|---|---|---|
| `CWS_CLIENT_ID` | both | OAuth client id from Google Cloud |
| `CWS_CLIENT_SECRET` | both | OAuth client secret |
| `CWS_REFRESH_TOKEN` | both | OAuth refresh token (long-lived) |
| `CWS_EXTENSION_ID` | production | id of the production listing |
| `CWS_EXTENSION_ID_BETA` | beta | id of the separate beta listing |
| `PROD_CLOUDFRONT_URL` | production | optional; defaults to `https://secureview.websaleem.com` |

The first three CWS values are tied to your Google account and shared across channels; the extension ids differ because the two listings are independent items in the store.

#### Generating client_id, client_secret, refresh_token

1. **Google Cloud Console** → create or pick a project → **APIs & Services → Library** → enable **Chrome Web Store API**.
2. **APIs & Services → OAuth consent screen** → user type **External**, add yourself as a Test User, then **set Publishing status to "In production"**.

   > **Do not leave it in "Testing".** Google expires refresh tokens for apps in
   > Testing status after **7 days**, after which every release fails with
   > `invalid_grant: Token has been expired or revoked` at the `Fetching token...`
   > step — before the zip is ever uploaded. Publishing the consent screen removes
   > that expiry. You will see an "unverified app" warning during the one-off
   > authorization; that is expected and safe to continue past, since you are the
   > only user of your own OAuth client.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Set application type to **Web application**.
   - Under **Authorized redirect URIs**, add exactly: `https://developers.google.com/oauthplayground`
   - Save the JSON. The `client_id` and `client_secret` from this file are your first two GitHub secrets.
4. Generate the refresh token via the OAuth Playground (one-off — keep the result safe):
   - Open <https://developers.google.com/oauthplayground>
   - **CRITICAL FIRST STEP**: Click the gear icon ⚙️ (top right) → check **Use your own OAuth credentials** → paste your `client_id` + `client_secret`. Close the settings panel. If you skip this, Google uses its default Client ID and your uploads will fail with `unauthorized_client`.
   - In **Step 1**, scroll down to "Input your own scopes" and paste exactly: `https://www.googleapis.com/auth/chromewebstore`
   - Click **Authorize APIs**. Sign in with the Google account that owns the Chrome Web Store listings and grant consent.
   - In **Step 2**, click **Exchange authorization code for tokens**. The `Refresh token` displayed is your `CWS_REFRESH_TOKEN`.

5. Copy the extension ids from the Chrome Web Store dashboard (URL: `https://chrome.google.com/webstore/devconsole/<account>/<extension-id>`) and put them in `CWS_EXTENSION_ID` (production) and `CWS_EXTENSION_ID_BETA`.

If `auto-publish` ever fails with `ITEM_PENDING_REVIEW` or similar, the upload still landed — you can finish the publish manually from the developer dashboard.

<details>
<summary>Alternative: get the refresh token without the Playground</summary>

Create the OAuth client as a **Desktop app** instead of a Web application, then
authorise it directly. Open this URL in a browser signed in as the account that
owns the listings:

```text
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
```

Approve, copy the authorization code it shows, and exchange it:

```bash
curl "https://accounts.google.com/o/oauth2/token" -d "client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&code=YOUR_AUTHORIZATION_CODE&grant_type=authorization_code&redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

The `refresh_token` in the JSON response is `CWS_REFRESH_TOKEN`.

</details>

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
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │   CloudFront    │
                                             │  Distribution   │
                                             │ (WAF Rate Limit)│
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │  Lambda@Edge    │
                                             │ origin-request  │
                                             │                 │
                                             │ • Signs Request │
                                             │   with AWS IAM  │
                                             │   (SigV4)       │
                                             └────────┬────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │   API Gateway   │
                                             │   (IAM Auth)    │
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

The AI pipeline is only invoked for domains that fall through rule-based matching as "Other" (or for all domains when `force_cloudfront` is enabled). Results are cached in `chrome.storage.local` under `br_cat_cache` so each domain is classified at most once. The backend is protected by a global AWS WAF rate limit on CloudFront, and Lambda@Edge securely signs the request using AWS IAM (SigV4) before forwarding it to API Gateway.

Categorization is triggered **immediately** when the content script sends `PAGE_READY` (on `document` load complete, and again whenever `<title>` changes for SPAs). The result is written to the domain entry in `chrome.storage.local` right away, and the open popup re-renders via `storage.onChanged`.

### Extension Components

The extension has four runtime components that communicate via Chrome APIs:

**`background/background.js` (Service Worker)** — The core tracking engine. Maintains session state in `chrome.storage.session` (key: `sv_session`) so it survives service worker restarts. Tracks active tab, window focus, and idle state. On every tab switch or `PAGE_READY` message it calls `triggerEagerCategorization()`, which immediately classifies the URL+title and writes the result to the domain entry — no waiting for the alarm. Flushes accumulated dwell time to `chrome.storage.local` every 60 seconds via an alarm, and also on every tab switch. On first install (`onInstalled` reason `"install"`) opens `https://secureview.websaleem.com/installsuccess.html` in a new tab. `setUninstallURL` points to `https://secureview.websaleem.com/uninstall.html` so Chrome opens it automatically when the extension is removed.

**`content/content_script.js`** — Injected into all pages. Sends `PAGE_READY` (`{ title, url }`) to the background as soon as `document` load fires; re-sends whenever the `<title>` element changes (MutationObserver) to catch SPA navigation; re-sends on `visibilitychange` when the tab becomes visible again. Also detects user activity (mouse, keyboard, scroll) and sends `USER_ACTIVE` every 10 seconds while active.

**`popup/popup.html` + `popup.js` + `popup.css`** — The extension popup UI. Two render modes selected by the **Today / Last 7 days** toggle: today reads `data_YYYY_MM_DD` directly, while the 7-day view runs `loadWeekData()` which aggregates the last 7 daily records into the same `{ domains, categories, totalSeconds, byDay }` shape (per-domain seconds summed; category fields taken from the most-recent visit so re-categorized domains show their latest label). In week mode the popup renders an extra `#day-breakdown` strip — 7 mini-bars sized proportionally to the busiest day — so you can see when you actually spent the time. The "Now:" indicator and exclude/clear flow always operate on today's data regardless of which period is on screen, so toggling to week mode never accidentally wipes history. Subscribes to `chrome.storage.onChanged` for any `data_*` key so today and week views both update live the moment the background writes a categorization result — without reopening the popup.

**`shared/logger.js`** — Loaded in all four contexts (background SW, content script, popup, categorizer). Provides `Logger.debug/info/warn/error(module, message, ...args)`. Every log line is prefixed with a timestamp (`YYYY-MM-DD HH:MM:SS.mmm`), level, and module name. Errors always print; all other levels are gated by the `debug_config` flag (see Runtime Settings Flags below).

**`shared/categories.js`** — Shared module imported by both `background.js` (via `importScripts`) and `popup.html` (via `<script>`). Defines categories with domain lists, keyword patterns, icons, and colors. Matching order: exact domain → subdomain → path-scoped rules (`google.com/travel`) → keyword scan. Host and path are matched as separate components, so a lookalike like `amazon.com.attacker.net` does **not** inherit the real domain's category. Note the keyword scan still matches a leading hostname label, so `paypal.com.phish.example` is keyword-matched as Finance — categorization is a labelling heuristic, not a phishing defence, and should never be treated as a trust signal.

**`shared/categorizer.js`** — Imported by `background.js` via `importScripts`. Provides `categorizeUrlEnhanced(url, title)`, an async drop-in for `categorizeUrl()`. Rule-based first; for "Other" domains it calls a CloudFront distribution. Flow: `CloudFront (WAF) → Lambda@Edge (origin-request signs request) → API Gateway → Lambda → Bedrock`. Before the request leaves the device, `_safeUrlForApi(url)` strips the query string and fragment so only `protocol://host/path` is sent — query params and hashes are where session tokens, search terms, and PII tend to sit. Retries up to 2× with exponential backoff to handle Lambda@Edge cold starts. Results cached under `br_cat_cache`. Fails silently if unreachable.

### Backend deployment

The backend is **two CloudFormation stacks per environment**. The split is forced
by AWS, not preference: Lambda@Edge functions and `CLOUDFRONT`-scoped WAF WebACLs
exist only in `us-east-1`, and CloudFormation cannot import values across regions.

| Stack | Region | Contents |
|---|---|---|
| `secureview-api-<env>` | ap-southeast-2 | Classifier Lambda, API Gateway (`AWS_IAM`), stage, log group |
| `secureview-edge-cdn-<env>` | us-east-1 | Lambda@Edge signer, WAF rate limit, CloudFront distribution |

Deploy either environment with one command — it packages both Lambdas, deploys
both stacks in order, and feeds the API stack's outputs into the CDN stack:

```bash
./scripts/deploy-backend.sh dev
```

Lambda code is uploaded under a **content-hashed S3 key**. A code change changes
the key, which replaces the `Lambda::Version`, which repoints the CloudFront
association — all in one deploy. This is deliberate: the previous process ran
`update-function-code` alone, which never reached live traffic because the
distribution stayed pinned to an older version.

Three settings in `secureview-edge-cdn.yml` are load-bearing, and each was broken
in the setup this replaced:

1. **`CacheBehaviors` order** — CloudFront takes the first matching pattern, so
   `/categorize` must precede the `*` site catch-all. A `*` behaviour allowing
   only GET/HEAD was shadowing the API and returning 403 to every POST.
2. **`IncludeBody: true`** — the signer reads `request.body`; without it the body
   never arrives and the function rejects its own traffic.
3. **`OriginPath: /<stage>`** — CloudFront prepends this *after* the function
   runs, so the function signs `OriginPath + uri`. Both are derived from the
   event, so template and code cannot drift.

`scripts/teardown-legacy.sh` (dry-run by default) removes the superseded stacks
and the hand-made resources they drifted away from. Every target is named
explicitly, since the account hosts unrelated projects.

### Runtime Settings Flags

Both flags are toggled live via `chrome.storage.local` — no extension reload required. Open DevTools on any extension page (background SW, popup) and run:

| Flag | Storage key | Effect |
|---|---|---|
| Debug logging | `debug_config` | Enables/disables all `Logger.debug/info/warn` output across every context. Errors always print. On by default in beta builds; off in prod. |
| Force AI classification | `force_cloudfront` | Bypasses rule-based matching for all sites and sends every URL straight to the AWS pipeline. Useful for testing Bedrock responses against known domains. Browser-internal pages (`chrome://`, `about:`) are always classified locally regardless of this flag. |
| Report address | `reportEmail` | Email address entered in Settings. Stored locally and never transmitted — see "Email reports" below. |
| Report frequency | `emailReportFreq` | `daily` or `weekly`. Stored locally alongside `reportEmail`. |

```js
// Debug logging
chrome.storage.local.set({ debug_config: { enabled: true } })   // enable
chrome.storage.local.set({ debug_config: { enabled: false } })  // disable

// Force AI classification (skip rule-based matching)
chrome.storage.local.set({ force_cloudfront: true })   // enable
chrome.storage.local.set({ force_cloudfront: false })  // disable
```

Both flags are watched via `chrome.storage.onChanged`, so changes take effect immediately in all active contexts.

### Email reports

There is **no account system**. The extension previously required a Cognito sign-in to
receive emailed reports; the login flow, the `/report` endpoint, the email Lambda, and the
Cognito user pool have all been removed.

Settings still collects an email address and a `daily` / `weekly` frequency, but those are
preferences held in `chrome.storage.local` only — no request is made and no report is sent.
An empty address is the "off" state. Re-enabling delivery means standing up an endpoint
again, and that endpoint must not be an unauthenticated mailer: without a sign-in, anything
that accepts an address and sends to it can be used to send mail to strangers from the
project's SES domain. Settle that design before wiring the UI back to a backend.

On upgrade, `clearLegacyAuthStorage()` deletes any `accessToken`, `idToken`, `refreshToken`,
and `customProfileName` left behind by the old login flow.

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
