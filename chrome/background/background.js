// SecureView Background Service Worker
// Tracks active browsing time per URL/domain

importScripts("../shared/config.js");
importScripts("../shared/categories.js");
importScripts("../shared/categorizer.js");
importScripts("../shared/logger.js");

const LOG = "BACKGROUND";

// Load debug config immediately so logs work before the first alarm/event fires
Logger.init();

// ─── In-memory state (re-hydrated from storage.session on every SW wake) ──────
let currentUrl = null;
let activeTabId = null;
let currentTabTitle = null;
let sessionStart = null;
let isWindowFocused = true;
let isUserIdle = false;
let stateLoaded = false;

const SESSION_KEY          = "sv_session";
const IDLE_THRESHOLD_SECONDS = 60;
const EXCLUDED_DOMAINS_KEY = "excluded_domains";
const RETENTION_DAYS       = 7;

// ─── Excluded domains (in-memory, synced from storage) ───────────────────────
let _excludedDomains = new Set();
const _exclusionsReady = new Promise((resolve) => {
  chrome.storage.local.get([EXCLUDED_DOMAINS_KEY], (result) => {
    _excludedDomains = new Set(result[EXCLUDED_DOMAINS_KEY] || []);
    resolve();
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && EXCLUDED_DOMAINS_KEY in changes) {
    _excludedDomains = new Set(changes[EXCLUDED_DOMAINS_KEY].newValue || []);
    Logger.info(LOG, `Excluded domains updated: ${[..._excludedDomains].join(", ") || "none"}`);
  }
  if (area === "local" && "emailReportFreq" in changes) {
    const freq = changes.emailReportFreq.newValue || "daily";
    if (freq === "none") {
      chrome.alarms.clear("email-report");
      Logger.info(LOG, `Email report frequency changed to none (alarm cleared)`);
    } else {
      const mins = freq === "daily" ? 1440 : 10080;
      chrome.alarms.create("email-report", { periodInMinutes: mins });
      Logger.info(LOG, `Email report frequency changed to ${freq} (${mins} mins)`);
    }
  }
});

// ─── Storage write serialization ──────────────────────────────────────────────
// flushTime, triggerEagerCategorization, and syncTabTitle all read-modify-write
// the same data_YYYY_MM_DD key. Without serialization, a slow categorization
// network call interleaved with a fast tick can clobber accumulated seconds.
let _writeChain = Promise.resolve();
function withStorageLock(fn) {
  const next = _writeChain.then(fn, fn);
  _writeChain = next.catch(() => {});
  return next;
}

function isExcluded(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return _excludedDomains.has(hostname);
  } catch { return false; }
}

// Tracking-eligibility filter. Browser-internal URLs and local-file paths are
// not user-meaningful "browsing" and may carry sensitive context (file paths,
// chrome:// settings) that shouldn't land in storage or be sent for
// categorization.
function shouldTrack(url) {
  if (!url) return false;
  if (url.startsWith("chrome://"))           return false;
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("file://"))             return false;
  if (url.startsWith("about:"))              return false;
  if (url.startsWith("edge://"))             return false;
  if (url.startsWith("view-source:"))        return false;
  return true;
}

// ─── Session state persistence (survives SW restarts within browser session) ──

async function loadState() {
  if (stateLoaded) return;
  return new Promise((resolve) => {
    chrome.storage.session.get([SESSION_KEY], (result) => {
      const s = result[SESSION_KEY];
      if (s) {
        currentUrl = s.currentUrl ?? null;
        activeTabId = s.activeTabId ?? null;
        currentTabTitle = s.currentTabTitle ?? null;
        sessionStart = s.sessionStart ?? null;
        isWindowFocused = s.isWindowFocused ?? true;
        isUserIdle = s.isUserIdle ?? false;
      }
      stateLoaded = true;
      Logger.debug(LOG, "State loaded", { currentUrl, isWindowFocused, isUserIdle });
      resolve();
    });
  });
}

function persistState() {
  chrome.storage.session.set({
    [SESSION_KEY]: { currentUrl, activeTabId, currentTabTitle, sessionStart, isWindowFocused, isUserIdle }
  });
}

// ─── Browsing data storage ────────────────────────────────────────────────────

function getTodayKey() {
  const now = new Date();
  return `data_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}_${String(now.getDate()).padStart(2, "0")}`;
}

async function getStorageData() {
  const key = getTodayKey();
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || { domains: {}, categories: {}, totalSeconds: 0 });
    });
  });
}

async function saveStorageData(data) {
  const key = getTodayKey();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: data }, resolve);
  });
}

// ─── Time accumulation ────────────────────────────────────────────────────────

async function flushTime(url) {
  if (!url || !sessionStart || isUserIdle || !isWindowFocused || isExcluded(url)) {
    Logger.debug(LOG, "Flush skipped", { url: url || "none", sessionStart, isUserIdle, isWindowFocused });
    return;
  }

  const now = Date.now();
  const elapsed = Math.round((now - sessionStart) / 1000);
  if (elapsed <= 0) return;

  // Advance the session start so the next flush doesn't double-count
  sessionStart = now;
  persistState();

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return;
  }
  if (!hostname) return;

  // Categorize outside the lock — slow, network-bound, internally cached.
  const category = await categorizeUrlEnhanced(url, currentTabTitle || "");

  await withStorageLock(async () => {
    const data = await getStorageData();
    Logger.info(LOG, `Flush: ${hostname} → ${elapsed}s (${category.name})`);

    if (!data.domains[hostname]) {
      const initialTitle = currentTabTitle || "";
      Logger.debug(LOG, `New domain entry: ${hostname}, title: "${initialTitle}"`);
      data.domains[hostname] = {
        url, hostname, title: initialTitle, seconds: 0,
        category: category.name, categoryIcon: category.icon,
        categoryColor: category.color, lastVisit: now
      };
    }
    data.domains[hostname].seconds += elapsed;
    data.domains[hostname].lastVisit = now;
    data.domains[hostname].category = category.name;
    data.domains[hostname].categoryIcon = category.icon;
    data.domains[hostname].categoryColor = category.color;

    // Recompute categories and totalSeconds from domain entries so that
    // category changes (e.g. "Other" → "Technology" after ML classification)
    // don't leave stale seconds in the old category.
    data.categories = {};
    data.totalSeconds = 0;
    for (const d of Object.values(data.domains)) {
      const cat = d.category || "Other";
      if (!data.categories[cat]) {
        data.categories[cat] = {
          name: cat, icon: d.categoryIcon || "🌐",
          color: d.categoryColor || "#7F8C8D", seconds: 0
        };
      }
      data.categories[cat].seconds += d.seconds;
      data.totalSeconds += d.seconds;
    }

    await saveStorageData(data);
  });
}

// ─── Session management ───────────────────────────────────────────────────────

async function endSession() {
  if (currentUrl && sessionStart) {
    Logger.info(LOG, `Session ended: ${currentUrl}`);
    await flushTime(currentUrl);
  }
  currentUrl = null;
  activeTabId = null;
  currentTabTitle = null;
  sessionStart = null;
  persistState();
}

// Categorize url+title immediately and persist the result to the domain entry.
// Called on tab switch AND on title updates so CloudFront always gets the real title.
// Hits the category cache if the domain was already classified; makes a fresh call otherwise.
function triggerEagerCategorization(url, title) {
  (async () => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      const category = await categorizeUrlEnhanced(url, title || "");
      await withStorageLock(async () => {
        const data = await getStorageData();
        if (!data.domains[hostname]) {
          Logger.info(LOG, `Eager category set (new): ${hostname} → ${category.name}`);
          data.domains[hostname] = {
            url, hostname, title: title || currentTabTitle || "", seconds: 0,
            category: category.name, categoryIcon: category.icon,
            categoryColor: category.color, lastVisit: Date.now()
          };
          await saveStorageData(data);
        } else if (!data.domains[hostname].category || data.domains[hostname].category === "Other") {
          Logger.info(LOG, `Eager category upgraded: ${hostname} → ${category.name}`);
          data.domains[hostname].category      = category.name;
          data.domains[hostname].categoryIcon  = category.icon;
          data.domains[hostname].categoryColor = category.color;
          await saveStorageData(data);
        }
      });
    } catch (e) {}
  })();
}

async function switchTo(url, tabId, title) {
  // Flush time on the previous URL before switching
  if (currentUrl && sessionStart) {
    await flushTime(currentUrl);
  }

  if (!shouldTrack(url) || isExcluded(url)) {
    currentUrl = null;
    activeTabId = null;
    currentTabTitle = null;
    sessionStart = null;
    persistState();
    return;
  }

  Logger.info(LOG, `Switch to: ${new URL(url).hostname} (tab ${tabId})`);

  currentUrl = url;
  activeTabId = tabId;
  currentTabTitle = title || null;
  sessionStart = isUserIdle || !isWindowFocused ? null : Date.now();
  persistState();

  if (title) await syncTabTitle(url, title);

  // Eagerly categorize and persist so the popup shows the correct category immediately,
  // before the first flushTime (which only runs after elapsed time > 0).
  triggerEagerCategorization(url, title || "");
}

// ─── Tab title sync ───────────────────────────────────────────────────────────

async function syncTabTitle(url, title) {
  if (!url || !title) return;
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch { return; }
  await withStorageLock(async () => {
    const data = await getStorageData();
    if (!data.domains[hostname]) return; // No entry yet — title is preserved in currentTabTitle until first flush
    if (data.domains[hostname].title === title) return; // No change
    Logger.debug(LOG, `Title synced: ${hostname} → "${title}"`);
    data.domains[hostname].title = title;
    await saveStorageData(data);
  });
}

// ─── Re-establish tracking after SW restart ───────────────────────────────────
// Called on every alarm tick. If SW was killed and restarted, in-memory state
// is gone — this re-queries the active tab and resumes from persisted state.

async function ensureTracking() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    const url = tab.url;
    if (!shouldTrack(url)) return;

    if (url !== currentUrl) {
      Logger.info(LOG, `Tracking re-established: ${new URL(url).hostname}`);
      await switchTo(url, tab.id, tab.title);
    } else if (!sessionStart && !isUserIdle && isWindowFocused) {
      // Same URL but sessionStart was lost — resume
      Logger.debug(LOG, `Session start restored for: ${new URL(url).hostname}`);
      sessionStart = Date.now();
      persistState();
    }
  } catch (e) {}
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

// Helper: load both session state and exclusion list before processing any
// event. _exclusionsReady is awaited to close the boot-time race where the
// exclusion set is briefly empty.
async function ready() {
  await Promise.all([loadState(), _exclusionsReady]);
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await ready();
  Logger.debug(LOG, `Tab activated: ${activeInfo.tabId}`);
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) await switchTo(tab.url, tab.id, tab.title);
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready();
  // Accept updates from the tracked tab OR if we have no tracked tab (after SW restart)
  if (tabId !== activeTabId && activeTabId !== null) return;
  if (changeInfo.status === "complete" && tab.url) {
    Logger.debug(LOG, `Tab updated: ${tab.url} (tab ${tabId})`);
    await switchTo(tab.url, tabId, tab.title);
  } else if (changeInfo.title && tabId === activeTabId) {
    // Title arrived (often after status=complete) — update state and re-trigger
    // categorization with the real title so CloudFront gets accurate context.
    Logger.debug(LOG, `Title update for active tab: "${changeInfo.title}"`);
    currentTabTitle = changeInfo.title;
    persistState();
    await syncTabTitle(currentUrl, changeInfo.title);
    triggerEagerCategorization(currentUrl, changeInfo.title);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await ready();
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    Logger.info(LOG, "Window lost focus — flushing and pausing");
    await flushTime(currentUrl);
    isWindowFocused = false;
    sessionStart = null;
    persistState();
  } else {
    Logger.info(LOG, "Window gained focus — resuming");
    isWindowFocused = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.url) await switchTo(tab.url, tab.id, tab.title);
    } catch (e) {}
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready();
  if (tabId === activeTabId) {
    Logger.info(LOG, `Tracked tab removed: ${tabId}`);
    await endSession();
  }
});

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  await ready();
  Logger.info(LOG, `Idle state: ${state}`);
  if (state === "idle" || state === "locked") {
    await flushTime(currentUrl);
    isUserIdle = true;
    sessionStart = null;
    persistState();
  } else if (state === "active") {
    isUserIdle = false;
    if (currentUrl && isWindowFocused) {
      sessionStart = Date.now();
      persistState();
    }
  }
});

// Alarm: minimum 1 minute in Chrome MV3
chrome.alarms.create("tick", { periodInMinutes: 1 });
chrome.alarms.clear("daily-report");
chrome.alarms.clear("weekly-report");
chrome.alarms.get("email-report", (alarm) => {
  chrome.storage.local.get(["emailReportFreq"], (res) => {
    const freq = res.emailReportFreq || "daily";
    if (freq === "none") {
      if (alarm) chrome.alarms.clear("email-report");
    } else if (!alarm) {
      const mins = freq === "daily" ? 1440 : 10080;
      chrome.alarms.create("email-report", { periodInMinutes: mins });
    }
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tick") {
    await ready();
    Logger.debug(LOG, "Alarm tick");
    await ensureTracking();      // Re-establish tracking if SW was restarted
    await flushTime(currentUrl); // Flush accumulated time to storage
    await pruneOldData();        // Drop data_* keys past the retention window
  } else if (alarm.name === "email-report") {
    await ready();
    Logger.info(LOG, "Running email report");
    await sendEmailReport();
  }
});

chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  if (message.type === "USER_ACTIVE") {
    ready().then(() => {
      Logger.debug(LOG, "USER_ACTIVE received from content script");
      if (isUserIdle) {
        isUserIdle = false;
        if (currentUrl && isWindowFocused) {
          sessionStart = Date.now();
          persistState();
        }
      }
    });
  } else if (message.type === "PAGE_READY") {
    // Trust the URL Chrome attached to sender.tab, NOT the one the content
    // script chose to send. Title is page-controlled and only used as a
    // categorization hint, so we accept it from the message after type-checking.
    const senderUrl = sender.tab?.url;
    const title = typeof message.title === "string" ? message.title : "";
    if (!senderUrl || !title || !shouldTrack(senderUrl)) return false;
    ready().then(async () => {
      if (sender.tab?.id !== activeTabId) return;
      Logger.info(LOG, `PAGE_READY: "${title}" (${new URL(senderUrl).hostname})`);
      if (title !== currentTabTitle) {
        currentTabTitle = title;
        persistState();
        await syncTabTitle(senderUrl, title);
      }
      triggerEagerCategorization(senderUrl, title);
    });
  } else if (message.type === "SIGNUP_SUCCESS") {
    Logger.info(LOG, "SIGNUP_SUCCESS received, sending welcome email");
    sendWelcomeEmail();
  }
  return false;
});

// ─── Data retention ───────────────────────────────────────────────────────────
// Keep RETENTION_DAYS of daily data (today + RETENTION_DAYS-1 prior days);
// drop older data_YYYY_MM_DD keys. Runs at most once per UTC day per SW life.
let _lastPruneDay = null;
async function pruneOldData() {
  const todayKey = getTodayKey();
  if (_lastPruneDay === todayKey) return;
  _lastPruneDay = todayKey;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (RETENTION_DAYS - 1));
  const cutoffKey = `data_${cutoff.getFullYear()}_${String(cutoff.getMonth() + 1).padStart(2, "0")}_${String(cutoff.getDate()).padStart(2, "0")}`;

  const all = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
  const toDelete = Object.keys(all).filter((k) => /^data_\d{4}_\d{2}_\d{2}$/.test(k) && k < cutoffKey);
  if (toDelete.length === 0) return;

  await new Promise((resolve) => chrome.storage.local.remove(toDelete, resolve));
  Logger.info(LOG, `Pruned ${toDelete.length} day(s) older than ${cutoffKey}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
// Both onInstalled and onStartup can fire on install — guard against double-run.
let _initDone = false;
async function init() {
  if (_initDone) return;
  _initDone = true;
  await ready();
  await ensureTracking();
  await pruneOldData();
  Logger.info(LOG, "Extension initialized");
}

chrome.runtime.setUninstallURL("https://secureview.websaleem.com/uninstall.html");

const COGNITO_DOMAIN = SV_CONFIG.COGNITO_DOMAIN;
const CLIENT_ID = SV_CONFIG.COGNITO_CLIENT_ID;
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL || details.reason === "install") {
    // Open the external success page
    chrome.tabs.create({ url: "https://secureview.websaleem.com/installsuccess.html" });
  }
  init();
});

// Listen for messages from the external website (e.g. auth tokens)
const ALLOWED_AUTH_ORIGINS = [
  "https://www.websaleem.com",
  "https://websaleem.com"
];

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  // Validate sender origin before processing auth tokens
  const senderOrigin = sender.url ? new URL(sender.url).origin : "";
  if (!ALLOWED_AUTH_ORIGINS.includes(senderOrigin)) {
    Logger.warn(LOG, `Rejected external message from untrusted origin: ${senderOrigin}`);
    sendResponse({ success: false, error: "Untrusted origin" });
    return true;
  }

  if (request.type === "AUTH_SUCCESS" && request.tokens) {
    Logger.info(LOG, "Received auth tokens from external website");
    chrome.storage.local.set({
      accessToken: request.tokens.accessToken,
      idToken: request.tokens.idToken,
      refreshToken: request.tokens.refreshToken || ""
    }, () => {
      sendResponse({ success: true });
      // Send welcome email after tokens are saved
      sendWelcomeEmail();
    });
    return true; // Keep message channel open for async sendResponse
  }
});
chrome.runtime.onStartup.addListener(init);

// ─── Token refresh ────────────────────────────────────────────────────────────
// Cognito access tokens expire after ~1 hour. This function uses the stored
// refresh token to obtain a new access token transparently.

async function refreshAccessToken() {
  const stored = await chrome.storage.local.get(['refreshToken']);
  if (!stored.refreshToken) {
    Logger.warn(LOG, "No refresh token available — user must re-login");
    return null;
  }

  try {
    const res = await fetch(`https://cognito-idp.${SV_CONFIG.COGNITO_REGION}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth"
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: SV_CONFIG.COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: stored.refreshToken
        }
      })
    });

    if (!res.ok) {
      Logger.warn(LOG, `Token refresh failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const result = data.AuthenticationResult;
    if (result?.AccessToken) {
      await chrome.storage.local.set({
        accessToken: result.AccessToken,
        idToken: result.IdToken || (await chrome.storage.local.get(['idToken'])).idToken
      });
      Logger.info(LOG, "Access token refreshed successfully");
      return result.AccessToken;
    }
  } catch (e) {
    Logger.warn(LOG, "Token refresh error", e?.message);
  }
  return null;
}

async function getValidAccessToken() {
  const stored = await chrome.storage.local.get(['accessToken']);
  if (!stored.accessToken) return null;

  // Try using the current token first; if Cognito rejects it, refresh
  try {
    await fetch(`https://cognito-idp.${SV_CONFIG.COGNITO_REGION}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.GetUser"
      },
      body: JSON.stringify({ AccessToken: stored.accessToken })
    }).then(r => { if (!r.ok) throw new Error(r.status); });
    return stored.accessToken;
  } catch {
    Logger.info(LOG, "Access token expired, attempting refresh");
    return await refreshAccessToken();
  }
}

// ─── Email report ───────────────────────────────────────────────────────

async function sendEmailReport() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return;
  
  const config = getCFConfig();
  
  const { emailReportFreq } = await chrome.storage.local.get(["emailReportFreq"]);
  const freq = emailReportFreq || "daily";
  if (freq === "none") return;
  const numDays = freq === "daily" ? 1 : 7;

  // Gather last `numDays` of browsing data
  const data = await chrome.storage.local.get(null);
  const keys = Object.keys(data).filter(k => k.startsWith("data_")).sort().reverse();
  const days = keys.slice(0, numDays).map(k => {
    const [, year, month, day] = k.split("_");
    const d = new Date(year, month - 1, day);
    const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    return { label, totalSeconds: data[k].totalSeconds || 0, categories: data[k].categories || {} };
  });

  const apiUrl = config?.reportUrl;
  if (!apiUrl || _isPlaceholderUrl(apiUrl)) return;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ days, frequency: freq, action: "report" })
    });
    if (res.ok) {
      Logger.info("REPORT", "Email report sent successfully");
    } else {
      Logger.warn("REPORT", "Failed to send email report", res.status);
    }
  } catch(e) {
    Logger.warn("REPORT", "Error sending email report", e?.message);
  }
}

// ─── Welcome Email ────────────────────────────────────────────────────────────

async function sendWelcomeEmail() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return;

  const config = getCFConfig();
  const apiUrl = config?.reportUrl;
  if (!apiUrl || _isPlaceholderUrl(apiUrl)) return;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ action: 'welcome' })
    });
    if (res.ok) {
      Logger.info("REPORT", "Welcome email sent successfully");
    } else {
      Logger.warn("REPORT", "Failed to send welcome email", res.status);
    }
  } catch(e) {
    Logger.warn("REPORT", "Error sending welcome email", e?.message);
  }
}
