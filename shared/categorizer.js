// URL categorization via CloudFront + Lambda@Edge + API Gateway + Lambda + Bedrock.
// Uses rule-based matching first; for unrecognized ("Other") domains it calls the
// CloudFront distribution, which sits in front of API Gateway.
//
// Request flow:
//   Extension → CloudFront → Lambda@Edge (viewer-request)
//                          → validates x-origin-token, strips it, injects real x-api-key
//                          → API Gateway → Lambda → Bedrock
//
// The real API Gateway key never leaves the Lambda@Edge function — the extension
// only holds a lightweight shared secret (x-origin-token) scoped per environment.
//
// CloudFront endpoint input:  { "url": "...", "hostname": "...", "title": "..." }
// CloudFront endpoint output: { "category": "Technology" }

const BR_CACHE_KEY   = "br_cat_cache";
const FORCE_CF_KEY   = "force_cloudfront";
const BR_TIMEOUT_MS  = 10000;  // slightly higher than API Gateway direct to absorb Lambda@Edge cold starts
const LOG_CAT        = "CATEGORIZER";

// In-memory cache of the flag; kept in sync via storage listener.
let _forceCloudFront = false;
chrome.storage.local.get([FORCE_CF_KEY], (result) => {
  _forceCloudFront = result[FORCE_CF_KEY] === true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && FORCE_CF_KEY in changes) {
    _forceCloudFront = changes[FORCE_CF_KEY].newValue === true;
    Logger.info(LOG_CAT, `force_cloudfront ${_forceCloudFront ? "enabled" : "disabled"}`);
  }
});

const MAX_RETRIES      = 2;
const RETRY_BASE_MS    = 500;  // exponential backoff: 500 ms, 1000 ms

// ─── Environment config ───────────────────────────────────────────────────────
// Environment is derived from the extension name in manifest.json at runtime.
// Names containing "beta" (case-insensitive) → beta env, otherwise → prod env.

const ACTIVE_ENV = chrome.runtime.getManifest().name.toLowerCase().includes("beta") ? "beta" : "prod";

// Replace the placeholder CloudFront domains with your actual distributions.
// originToken: shared secret that Lambda@Edge viewer-request validates.
const CF_CONFIGS = {
  beta: {
    url:         "https://d3dxj0v65ds4s6.cloudfront.net/categorize",
    originToken: ""   // set your beta origin token here
  },
  prod: {
    url:         "https://d3dxj0v65ds4s6.cloudfront.net/categorize",
    originToken: ""   // set your prod origin token here
  }
};

function getCFConfig() {
  return CF_CONFIGS[ACTIVE_ENV];
}

// ─── Category cache ───────────────────────────────────────────────────────────

async function getBRCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([BR_CACHE_KEY], (result) => {
      resolve(result[BR_CACHE_KEY] || {});
    });
  });
}

async function setCachedCategory(hostname, categoryName) {
  const cache = await getBRCache();
  cache[hostname] = categoryName;
  chrome.storage.local.set({ [BR_CACHE_KEY]: cache });
}

// ─── CloudFront call (with retry) ────────────────────────────────────────────

async function fetchWithRetry(url, options, attempt = 0) {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (attempt >= MAX_RETRIES) throw e;
    const delay = RETRY_BASE_MS * Math.pow(2, attempt);
    Logger.debug(LOG_CAT, `Retrying after ${delay} ms (attempt ${attempt + 1})`);
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, options, attempt + 1);
  }
}

async function classifyWithCloudFront(url, hostname, title) {
  const cache = await getBRCache();
  if (cache[hostname]) {
    Logger.debug(LOG_CAT, `Cache hit: ${hostname} → ${cache[hostname]}`);
    return cache[hostname];
  }

  const config = getCFConfig();
  if (!config?.url || config.url.includes("<")) {
    Logger.debug(LOG_CAT, `CloudFront not configured — skipping ML classification for: ${hostname}`);
    return null;
  }

  Logger.info(LOG_CAT, `Calling CloudFront for: ${JSON.stringify({ url, hostname, title: title || "" })}`);

  const headers = { "Content-Type": "application/json" };
  if (config.originToken) headers["x-origin-token"] = config.originToken;

  try {
    const response = await fetchWithRetry(config.url, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ url, hostname, title: title || "" }),
      signal:  AbortSignal.timeout(BR_TIMEOUT_MS)
    });

    if (!response.ok) {
      Logger.warn(LOG_CAT, `CloudFront returned HTTP ${response.status} for: ${hostname}`);
      return null;
    }

    const data     = await response.json();
    const category = (data.category || "").trim();

    const validNames = CATEGORY_RULES.map(c => c.name);
    if (validNames.includes(category)) {
      Logger.info(LOG_CAT, `Classified: ${hostname} → ${category}`);
      await setCachedCategory(hostname, category);
      return category;
    }

    Logger.warn(LOG_CAT, `Unrecognised category "${category}" returned for: ${hostname}`);
  } catch (e) {
    Logger.warn(LOG_CAT, `CloudFront call failed for: ${hostname}`, e?.message);
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Drop-in async replacement for categorizeUrl().
// Rule-based first; CloudFront only for unrecognized ("Other") domains.
// When force_cloudfront is enabled, skips rule-based matching for all sites.
async function categorizeUrlEnhanced(url, title) {
  // Browser-internal pages always use local rules regardless of force_cloudfront.
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    return categorizeUrl(url);
  }

  const ruleResult = categorizeUrl(url);
  if (!_forceCloudFront && ruleResult.name !== "Other") return ruleResult;

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return ruleResult;
  }

  Logger.info(LOG_CAT, `categorizeUrlEnhanced: ${url} ${hostname} ${title}`);
  const apiCategory = await classifyWithCloudFront(url, hostname, title);
  if (!apiCategory) return ruleResult;

  const rule = CATEGORY_RULES.find(c => c.name === apiCategory);
  return rule
    ? { name: rule.name, icon: rule.icon, color: rule.color }
    : ruleResult;
}
