// SecureView Background Service Worker
// Tracks active browsing time per URL/domain

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

    if (!data.categories[category.name]) {
      data.categories[category.name] = {
        name: category.name, icon: category.icon,
        color: category.color, seconds: 0
      };
    }
    data.categories[category.name].seconds += elapsed;
    data.totalSeconds = (data.totalSeconds || 0) + elapsed;

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
    isWindowFocused = false;
    await flushTime(currentUrl);
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
    isUserIdle = true;
    await flushTime(currentUrl);
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
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;
  await ready();
  Logger.debug(LOG, "Alarm tick");
  await ensureTracking();      // Re-establish tracking if SW was restarted
  await flushTime(currentUrl); // Flush accumulated time to storage
  await pruneOldData();        // Drop data_* keys past the retention window
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

chrome.runtime.setUninstallURL("https://www.websaleem.com/secureview/uninstall.html");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://www.websaleem.com/secureview/success.html" });
  }
  init();
});
chrome.runtime.onStartup.addListener(init);
