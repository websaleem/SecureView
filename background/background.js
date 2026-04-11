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
let sessionStart = null;
let isWindowFocused = true;
let isUserIdle = false;
let stateLoaded = false;

const SESSION_KEY          = "sv_session";
const IDLE_THRESHOLD_SECONDS = 60;
const EXCLUDED_DOMAINS_KEY = "excluded_domains";

// ─── Excluded domains (in-memory, synced from storage) ───────────────────────
let _excludedDomains = new Set();
chrome.storage.local.get([EXCLUDED_DOMAINS_KEY], (result) => {
  _excludedDomains = new Set(result[EXCLUDED_DOMAINS_KEY] || []);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && EXCLUDED_DOMAINS_KEY in changes) {
    _excludedDomains = new Set(changes[EXCLUDED_DOMAINS_KEY].newValue || []);
    Logger.info(LOG, `Excluded domains updated: ${[..._excludedDomains].join(", ") || "none"}`);
  }
});

function isExcluded(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return _excludedDomains.has(hostname);
  } catch { return false; }
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
    [SESSION_KEY]: { currentUrl, activeTabId, sessionStart, isWindowFocused, isUserIdle }
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

  const data = await getStorageData();
  const existingTitle = data.domains[hostname]?.title || "";
  const category = await categorizeUrlEnhanced(url, existingTitle);

  Logger.info(LOG, `Flush: ${hostname} → ${elapsed}s (${category.name})`);

  if (!data.domains[hostname]) {
    data.domains[hostname] = {
      url, hostname, title: "", seconds: 0,
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
}

// ─── Session management ───────────────────────────────────────────────────────

async function endSession() {
  if (currentUrl && sessionStart) {
    Logger.info(LOG, `Session ended: ${currentUrl}`);
    await flushTime(currentUrl);
  }
  currentUrl = null;
  activeTabId = null;
  sessionStart = null;
  persistState();
}

async function switchTo(url, tabId, title) {
  // Flush time on the previous URL before switching
  if (currentUrl && sessionStart) {
    await flushTime(currentUrl);
  }

  if (!url || url.startsWith("chrome-extension://") || url === "about:blank" || isExcluded(url)) {
    currentUrl = null;
    activeTabId = null;
    sessionStart = null;
    persistState();
    return;
  }

  Logger.info(LOG, `Switch to: ${new URL(url).hostname} (tab ${tabId})`);

  currentUrl = url;
  activeTabId = tabId;
  sessionStart = isUserIdle || !isWindowFocused ? null : Date.now();
  persistState();

  if (title) await syncTabTitle(url, title);
}

// ─── Tab title sync ───────────────────────────────────────────────────────────

async function syncTabTitle(url, title) {
  if (!url || !title) return;
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch { return; }
  const data = await getStorageData();
  if (data.domains[hostname]) {
    Logger.debug(LOG, `Title synced: ${hostname} → "${title}"`);
    data.domains[hostname].title = title;
    await saveStorageData(data);
  }
}

// ─── Re-establish tracking after SW restart ───────────────────────────────────
// Called on every alarm tick. If SW was killed and restarted, in-memory state
// is gone — this re-queries the active tab and resumes from persisted state.

async function ensureTracking() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;

    const url = tab.url;
    if (url.startsWith("chrome-extension://") || url === "about:blank") return;

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

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await loadState();
  Logger.debug(LOG, `Tab activated: ${activeInfo.tabId}`);
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) await switchTo(tab.url, tab.id, tab.title);
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await loadState();
  // Accept updates from the tracked tab OR if we have no tracked tab (after SW restart)
  if (tabId !== activeTabId && activeTabId !== null) return;
  if (changeInfo.status === "complete" && tab.url) {
    Logger.debug(LOG, `Tab updated: ${tab.url} (tab ${tabId})`);
    await switchTo(tab.url, tabId, tab.title);
  } else if (changeInfo.title && tabId === activeTabId) {
    await syncTabTitle(currentUrl, changeInfo.title);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await loadState();
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
  await loadState();
  if (tabId === activeTabId) {
    Logger.info(LOG, `Tracked tab removed: ${tabId}`);
    await endSession();
  }
});

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
chrome.idle.onStateChanged.addListener(async (state) => {
  await loadState();
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
  await loadState();
  Logger.debug(LOG, "Alarm tick");
  await ensureTracking();      // Re-establish tracking if SW was restarted
  await flushTime(currentUrl); // Flush accumulated time to storage
});

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.type === "USER_ACTIVE") {
    loadState().then(() => {
      Logger.debug(LOG, "USER_ACTIVE received from content script");
      if (isUserIdle) {
        isUserIdle = false;
        if (currentUrl && isWindowFocused) {
          sessionStart = Date.now();
          persistState();
        }
      }
    });
  }
  return false;
});

// Initial setup on install/startup
async function init() {
  await loadState();
  await ensureTracking();
  Logger.info(LOG, "Extension initialized");
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
