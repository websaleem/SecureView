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

const BR_CACHE_KEY    = "br_cat_cache";
const FORCE_CF_KEY    = "force_cloudfront";
const BR_TIMEOUT_MS   = 10000;  // slightly higher than API Gateway direct to absorb Lambda@Edge cold starts
const CACHE_VERSION   = 1;
const CACHE_TTL_MS    = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOG_CAT         = "CATEGORIZER";

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

// ─── CloudFront config ────────────────────────────────────────────────────────
// originToken: shared secret that Lambda@Edge viewer-request validates.
// Both build channels currently share one token — re-introduce a per-env split
// here (and update the validator) if you ever rotate one without the other.

const CF_CONFIG = {
  url:         "https://d3dxj0v65ds4s6.cloudfront.net/categorize",
  originToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IlRPS0VOIn0.eyJ1c2VySWQiOiJ3ZWJzYWxlZW0iLCJyb2xlIjoiYWRtaW4iLCJlbnYiOiJwcm9kIn0.qZHILrXoa4g2llBM5tFDrf2t03Ir2WrNbrhvaxW2ToE"
};

function getCFConfig() {
  return CF_CONFIG;
}

// Strip query and fragment before sending the URL to the categorize endpoint.
// Path is kept (it can carry useful categorization signal — e.g. /finance vs
// /sports), but ?query and #hash often carry auth tokens, search terms, and
// session ids that have no business leaving the device.
function _safeUrlForApi(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
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
  cache[hostname] = { category: categoryName, ts: Date.now(), v: CACHE_VERSION };
  chrome.storage.local.set({ [BR_CACHE_KEY]: cache });
}

// Returns the cached category name, or null if missing/expired/wrong version.
// Tolerates the legacy string-only entry shape from earlier versions.
function readCachedCategory(cache, hostname) {
  const entry = cache[hostname];
  if (!entry) return null;
  if (typeof entry === "string") return entry; // legacy shape — accept once, will be rewritten on next miss path
  if (entry.v !== CACHE_VERSION) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.category;
}

// ─── CloudFront call (with retry) ────────────────────────────────────────────

// Each attempt gets its own AbortSignal so a timeout on attempt N doesn't
// instantly fail attempts N+1, N+2 (the previous shared-signal approach made
// retries useless against Lambda@Edge cold starts).
async function fetchWithRetry(url, options, attempt = 0) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(BR_TIMEOUT_MS) });
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
  const cached = readCachedCategory(cache, hostname);
  if (cached) {
    Logger.debug(LOG_CAT, `Cache hit: ${hostname} → ${cached}`);
    return cached;
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
      body:    JSON.stringify({ url: _safeUrlForApi(url), hostname, title: title || "" })
    });

    if (!response.ok) {
      Logger.warn(LOG_CAT, `CloudFront returned HTTP ${response.status} for: ${hostname}`);
      return null;
    }

    const data     = await response.json();
    const category = (data.category || "").trim();

    if (category) {
      Logger.info(LOG_CAT, `Classified: ${hostname} → ${category}`);
      await setCachedCategory(hostname, category);
      return category;
    }

    Logger.warn(LOG_CAT, `Empty category returned for: ${hostname}`);
  } catch (e) {
    Logger.warn(LOG_CAT, `CloudFront call failed for: ${hostname}`, e?.message);
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Maps a Bedrock category name to an icon and color using keyword matching.
// Checks exact CATEGORY_RULES matches first, then falls back to keyword hints.
function getIconForCategory(categoryName) {
  const rule = CATEGORY_RULES.find(c => c.name === categoryName);
  if (rule) return { icon: rule.icon, color: rule.color };

  const lower = categoryName.toLowerCase();
  const ICON_MAP = [
    { keywords: ["finance", "bank", "invest", "crypto", "stock", "money", "insurance", "loan", "mortgage", "accounting"], icon: "💰", color: "#27AE60" },
    { keywords: ["news", "media", "press", "journal", "magazine", "blog", "report"],                                       icon: "📰", color: "#E74C3C" },
    { keywords: ["entertain", "movie", "film", "music", "stream", "video", "tv", "show", "sport", "theatre"],             icon: "🎬", color: "#9B59B6" },
    { keywords: ["social", "community", "forum", "chat", "message", "dating"],                                            icon: "💬", color: "#3498DB" },
    { keywords: ["travel", "hotel", "flight", "vacation", "trip", "tour", "airline", "airport", "cruise"],                icon: "✈️", color: "#1ABC9C" },
    { keywords: ["shop", "store", "retail", "ecommerce", "marketplace", "fashion", "clothing", "apparel"],                icon: "🛒", color: "#E67E22" },
    { keywords: ["tech", "software", "hardware", "developer", "code", "programming", "cloud", "ai", "saas", "cyber"],     icon: "💻", color: "#2ECC71" },
    { keywords: ["education", "learn", "school", "university", "course", "training", "academic", "research", "science"],  icon: "📚", color: "#F39C12" },
    { keywords: ["health", "fitness", "medical", "doctor", "hospital", "clinic", "pharma", "wellness", "diet"],           icon: "🏃", color: "#16A085" },
    { keywords: ["productiv", "tool", "workspace", "office", "collaborat", "project", "task", "email", "calendar"],       icon: "⚡", color: "#8E44AD" },
    { keywords: ["game", "gaming", "esport", "casino", "gambling"],                                                       icon: "🎮", color: "#C0392B" },
    { keywords: ["food", "restaurant", "recipe", "cook", "drink", "beverage", "delivery"],                                icon: "🍕", color: "#E74C3C" },
    { keywords: ["real estate", "property", "realt", "housing", "mortgage"],                                              icon: "🏠", color: "#795548" },
    { keywords: ["government", "public service", "politic", "legal", "law", "court"],                                     icon: "🏛️", color: "#607D8B" },
    { keywords: ["sport", "football", "soccer", "basketball", "tennis", "cricket", "gym", "athlet"],                      icon: "🏆", color: "#FF9800" },
    { keywords: ["art", "design", "creative", "photo", "graphic", "illustration", "museum"],                              icon: "🎨", color: "#AB47BC" },
    { keywords: ["automotive", "car", "vehicle", "truck", "motorcycle", "transport"],                                     icon: "🚗", color: "#546E7A" },
    { keywords: ["nature", "environment", "climate", "animal", "wildlife", "outdoor"],                                    icon: "🌿", color: "#43A047" },
    { keywords: ["religion", "spiritual", "church", "faith", "prayer"],                                                   icon: "🙏", color: "#8D6E63" },
    { keywords: ["adult", "18+", "explicit"],                                                                              icon: "🔞", color: "#B71C1C" },
  ];

  for (const entry of ICON_MAP) {
    if (entry.keywords.some(k => lower.includes(k))) {
      return { icon: entry.icon, color: entry.color };
    }
  }

  return { icon: "🌐", color: "#7F8C8D" };
}

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

  const { icon, color } = getIconForCategory(apiCategory);
  return { name: apiCategory, icon, color };
}
