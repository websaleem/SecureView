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
// When the system went idle while the window still had focus — the "probably
// reading" window. null whenever input is recent or the user is known away.
let unattendedSince = null;
let stateLoaded = false;

const SESSION_KEY = "sv_session";

// How long with no keyboard/mouse input before Chrome calls the system idle.
//
// This was 60s, which undercounted every reading session. chrome.idle measures
// from the user's LAST INPUT, not from when the page opened, so the countdown
// is already part-spent by the time a page finishes loading: a page that took
// 5s to load froze its timer at 55s and never moved again, however long the
// user kept reading. Reading produces no input at all, so a threshold this
// short treats the most ordinary use of a browser as absence.
const IDLE_THRESHOLD_SECONDS = 180;

// Reading is not absence, but an abandoned laptop is. When the system goes idle
// while the window still has focus, time keeps accruing for at most this long
// before the session is closed anyway.
//
// So the error is bounded in both directions: a reader loses nothing, and a
// walked-away machine over-credits by at most this much instead of by however
// long it sat there. A locked screen stops immediately and never uses this.
const MAX_UNATTENDED_MS = 10 * 60 * 1000;
// Upper bound on what a single flush may credit, so a suspended worker or a
// slept machine cannot dump hours onto whatever page was open.
//
// Derived from the idle threshold rather than hardcoded, because it must be
// larger than it: until the idle event arrives the user is presumed present, so
// one legitimate uninterrupted span can be as long as the whole threshold plus
// however late the tick is. Hardcoded at two minutes against a three-minute
// threshold, this silently truncated a minute off exactly the reading sessions
// the threshold was raised to protect — caught by test/verify-time-accounting.mjs.
const MAX_FLUSH_MS = (IDLE_THRESHOLD_SECONDS + 120) * 1000;
const EXCLUDED_DOMAINS_KEY = "excluded_domains";
const RETENTION_DAYS = 7;

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
// Bumped whenever the user destroys today's record (clear, or excluding a
// domain). flushTime captures it before its slow categorization await and
// abandons the write if it changed, because withStorageLock cannot help here:
// the lock serialises the two write sections, but a flush that started BEFORE
// a clear still carries a stale intent and would apply it afterwards, putting
// the domain straight back into the day the user just emptied.
let _dataGeneration = 0;

let _writeChain = Promise.resolve();
function withStorageLock(fn) {
  const next = _writeChain.then(fn, fn);
  _writeChain = next.catch(() => { });
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
// An allowlist, not a denylist. The previous version named six schemes to
// refuse and tracked everything else, which admitted `data:`, `blob:`,
// `devtools://`, `chrome-untrusted://` and every other browser's internal
// scheme (brave://, opera://, vivaldi://, arc://) by omission — a list of
// exceptions can only ever be as complete as the day it was written.
//
// Ordinary browsing is http and https. Anything else is not a web page the user
// chose to spend time on, so it is not tracked. An unparseable URL is refused
// here rather than later: flushTime would have had to discard the span after
// sessionStart had already advanced.
function shouldTrack(url) {
  if (!url) return false;
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return protocol === "http:" || protocol === "https:";
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
        unattendedSince = s.unattendedSince ?? null;
      }
      stateLoaded = true;
      Logger.debug(LOG, "State loaded", { currentUrl, isWindowFocused, isUserIdle });
      resolve();
    });
  });
}

function persistState() {
  chrome.storage.session.set({
    [SESSION_KEY]: { currentUrl, activeTabId, currentTabTitle, sessionStart, isWindowFocused, isUserIdle, unattendedSince }
  });
}

// ─── Browsing data storage ────────────────────────────────────────────────────

function dayKeyFor(ts) {
  const d = new Date(ts);
  return `data_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getDate()).padStart(2, "0")}`;
}

function getTodayKey() {
  return dayKeyFor(Date.now());
}

// Split [startMs, endMs) into one segment per local calendar day, so a session
// running across midnight is credited to the days it actually happened on
// rather than landing entirely on whichever day the flush ran in.
function splitByDay(startMs, endMs) {
  const segments = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const segmentEnd = Math.min(nextMidnight, endMs);
    // `lastInstant` is the final millisecond INSIDE this segment's day, used to
    // stamp lastVisit. Using the flush time for every segment would date a
    // yesterday segment as today, and loadWeekData picks the winning category
    // label by highest lastVisit. segmentEnd itself is exclusive — at a midnight
    // boundary it is the next day's first instant — hence the -1.
    segments.push({ key: dayKeyFor(cursor), ms: segmentEnd - cursor, lastInstant: segmentEnd - 1 });
    cursor = segmentEnd;
  }
  return segments;
}

// chrome.storage.local reports failures through chrome.runtime.lastError, NOT
// by throwing or withholding the callback — so an unchecked write resolves
// exactly like a successful one. The extension has no `unlimitedStorage`
// permission, so it lives inside the ~10MB quota; once that fills, every write
// silently no-ops and tracking stops recording with nothing in the logs.
// These wrappers turn that into a rejection so callers can at least say so.
function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || "storage.set failed"));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || "storage.remove failed"));
      else resolve();
    });
  });
}

async function getStorageData(key = getTodayKey()) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || { domains: {}, categories: {}, totalSeconds: 0 });
    });
  });
}

async function saveStorageData(data, key = getTodayKey()) {
  return storageSet({ [key]: data });
}

// Rebuild `categories` and `totalSeconds` from the domain entries. Derived
// state, never mutated independently — so a re-categorized domain cannot leave
// stale seconds behind in the category it used to belong to.
function recomputeTotals(data) {
  data.categories = {};
  data.totalSeconds = 0;
  for (const d of Object.values(data.domains)) {
    const cat = d.category || "Other";
    if (!data.categories[cat]) {
      data.categories[cat] = {
        name: cat, icon: d.categoryIcon || "\u{1F310}",
        color: d.categoryColor || "#7F8C8D", seconds: 0
      };
    }
    data.categories[cat].seconds += d.seconds;
    data.totalSeconds += d.seconds;
  }
}

// ─── Time accumulation ────────────────────────────────────────────────────────

// `until` credits time only up to a given instant instead of to now. The
// unattended cap needs that: when the deadline has passed, the seconds before
// it were genuinely watched and the seconds after it were not, and the two must
// not be credited together.
async function flushTime(url, until = Date.now()) {
  if (!url || !sessionStart || isUserIdle || !isWindowFocused || isExcluded(url)) {
    Logger.debug(LOG, "Flush skipped", { url: url || "none", sessionStart, isUserIdle, isWindowFocused });
    return;
  }

  // Never credit the future, whatever the caller passed.
  const now = Math.min(until, Date.now());
  const spanMs = now - sessionStart;
  if (spanMs <= 0) return;

  // Resolve the hostname BEFORE advancing sessionStart. These two checks used
  // to sit after it, so an unparseable URL discarded the elapsed time instead
  // of leaving it to accrue into the next flush.
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return;
  }
  // Refuses __proto__ and friends — see isSafeHostKey in categories.js.
  if (!isSafeHostKey(hostname)) return;

  // A gap far longer than the tick interval means the worker was suspended or
  // the machine slept — the user was not browsing for most of it. Credit at
  // most MAX_FLUSH_MS and drop the rest, so a closed laptop lid can no longer
  // dump hours onto whatever page happened to be open.
  let from = sessionStart;
  if (spanMs > MAX_FLUSH_MS) {
    Logger.info(LOG, `Gap of ${Math.round(spanMs / 1000)}s exceeds cap — crediting ${MAX_FLUSH_MS / 1000}s`);
    from = now - MAX_FLUSH_MS;
  }

  // Advance the session start so the next flush doesn't double-count. Every
  // millisecond of the span is accounted for below, either as whole seconds or
  // as the sub-second remainder carried on the domain entry.
  sessionStart = now;
  persistState();

  // Snapshot the generation before the slow call below; see _dataGeneration.
  const generation = _dataGeneration;

  // Categorize outside the lock — slow, network-bound, internally cached.
  const category = await categorizeUrlEnhanced(url, currentTabTitle || "");

  for (const segment of splitByDay(from, now)) {
    await withStorageLock(async () => {
      if (_dataGeneration !== generation) {
        Logger.info(LOG, `Discarding ${Math.round(segment.ms / 1000)}s for ${hostname} — today's data was cleared mid-flush`);
        return;
      }
      const data = await getStorageData(segment.key);

      if (!data.domains[hostname]) {
        const initialTitle = currentTabTitle || "";
        Logger.debug(LOG, `New domain entry: ${hostname}, title: "${initialTitle}"`);
        data.domains[hostname] = {
          url, hostname, title: initialTitle, seconds: 0, ms: 0,
          category: category.name, categoryIcon: category.icon,
          categoryColor: category.color, lastVisit: segment.lastInstant
        };
      }
      const entry = data.domains[hostname];

      // Accumulate in milliseconds and only spill whole seconds into `seconds`.
      // Rounding each flush independently used to bake the error in permanently,
      // which showed up as a systematic over- or under-count whenever sessions
      // were short (rapid tab switching).
      const carried = (entry.ms || 0) + segment.ms;
      const wholeSeconds = Math.floor(carried / 1000);
      entry.seconds += wholeSeconds;
      entry.ms = carried - wholeSeconds * 1000;

      Logger.info(LOG, `Flush: ${hostname} → +${wholeSeconds}s (${category.name}) [${segment.key}]`);

      entry.lastVisit = segment.lastInstant;
      entry.category = category.name;
      entry.categoryIcon = category.icon;
      entry.categoryColor = category.color;

      recomputeTotals(data);

      await saveStorageData(data, segment.key);
    }).catch((e) => {
      // sessionStart has already advanced, so this span cannot be replayed —
      // say so loudly rather than losing time silently. Logger.error prints
      // regardless of the debug flag.
      Logger.error(LOG, `Failed to persist ${Math.round(segment.ms / 1000)}s for ${hostname} [${segment.key}]`, e?.message);
    });
  }
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
  unattendedSince = null;
  persistState();
}

// Categorize url+title immediately and persist the result to the domain entry.
// Called on tab switch AND on title updates so CloudFront always gets the real title.
// Hits the category cache if the domain was already classified; makes a fresh call otherwise.
function triggerEagerCategorization(url, title) {
  (async () => {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      if (!isSafeHostKey(hostname)) return;
      const category = await categorizeUrlEnhanced(url, title || "");
      await withStorageLock(async () => {
        const data = await getStorageData();
        if (!data.domains[hostname]) {
          Logger.info(LOG, `Eager category set (new): ${hostname} → ${category.name}`);
          data.domains[hostname] = {
            url, hostname, title: title || currentTabTitle || "", seconds: 0, ms: 0,
            category: category.name, categoryIcon: category.icon,
            categoryColor: category.color, lastVisit: Date.now()
          };
          await saveStorageData(data);
        } else if (!data.domains[hostname].category || data.domains[hostname].category === "Other") {
          Logger.info(LOG, `Eager category upgraded: ${hostname} → ${category.name}`);
          data.domains[hostname].category = category.name;
          data.domains[hostname].categoryIcon = category.icon;
          data.domains[hostname].categoryColor = category.color;
          await saveStorageData(data);
        }
      });
    } catch (e) { }
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
    unattendedSince = null;
    persistState();
    return;
  }

  Logger.info(LOG, `Switch to: ${new URL(url).hostname} (tab ${tabId})`);

  currentUrl = url;
  activeTabId = tabId;
  currentTabTitle = title || null;
  sessionStart = isUserIdle || !isWindowFocused ? null : Date.now();
  // A new page is attended by definition — navigating to it was input.
  unattendedSince = null;
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
  if (!isSafeHostKey(hostname)) return;
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
  } catch (e) { }
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
  } catch (e) { }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready();
  // Accept updates from the tracked tab, or — when there is no tracked tab yet,
  // as after a browser restart clears storage.session — from a tab that is
  // genuinely the active one. Without the `tab.active` test, a background tab
  // finishing its load first would capture tracking and accrue time the user
  // never spent looking at it.
  if (tabId !== activeTabId) {
    if (activeTabId !== null) return;
    if (!tab?.active) return;
  }
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
    unattendedSince = null;
    persistState();
  } else {
    Logger.info(LOG, "Window gained focus — resuming");
    isWindowFocused = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab?.url) await switchTo(tab.url, tab.id, tab.title);
    } catch (e) { }
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

  // A locked screen is unambiguous: nobody is reading it. Stop at once.
  if (state === "locked") {
    await flushTime(currentUrl);
    isUserIdle = true;
    sessionStart = null;
    unattendedSince = null;
    persistState();
    return;
  }

  if (state === "idle") {
    // No input for IDLE_THRESHOLD_SECONDS. That is not the same as absence —
    // reading generates no input — so if the window still has focus, keep
    // counting and start the unattended clock instead. The alarm tick closes
    // the session once MAX_UNATTENDED_MS has passed, which is what stops an
    // abandoned machine from accruing all day.
    //
    // Flush first either way, so the time up to this point is banked even if
    // the worker is torn down before the next tick.
    await flushTime(currentUrl);
    if (isWindowFocused && currentUrl) {
      if (unattendedSince === null) {
        unattendedSince = Date.now();
        Logger.info(LOG, "System idle but window focused — still counting, unattended clock started");
        persistState();
      }
      return;
    }
    isUserIdle = true;
    sessionStart = null;
    unattendedSince = null;
    persistState();
    return;
  }

  if (state === "active") {
    // Real input: whatever we assumed, the user is here.
    const wasIdle = isUserIdle;
    isUserIdle = false;
    unattendedSince = null;
    if (currentUrl && isWindowFocused && (wasIdle || !sessionStart)) {
      // Only restart the clock if it had actually stopped. Resetting it while
      // it was still running would discard the span since the last flush.
      sessionStart = Date.now();
    }
    persistState();
  }
});

// Alarm: minimum 1 minute in Chrome MV3.
//
// Only create the alarm if it doesn't already exist. chrome.alarms.create
// REPLACES a same-named alarm and restarts its period, and this file's top
// level re-runs on every service-worker cold start. Because the content script
// pings USER_ACTIVE every 10s and the worker is torn down after ~30s idle,
// unconditionally re-creating the alarm meant a browsing user reset the
// 1-minute timer before it ever fired — so the tick never ran, and MAX_FLUSH_MS
// then capped the eventual flush at two minutes no matter how long the page had
// actually been open.
chrome.alarms.get("tick", (alarm) => {
  if (!alarm) chrome.alarms.create("tick", { periodInMinutes: 1 });
});

// Alarms left behind by earlier versions that mailed reports from the backend.
// Clearing them stops upgraded installs waking the worker for work that no
// longer exists.
chrome.alarms.clear("daily-report");
chrome.alarms.clear("weekly-report");
chrome.alarms.clear("email-report");

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tick") return;
  await ready();
  Logger.debug(LOG, "Alarm tick");
  await ensureTracking();      // Re-establish tracking if SW was restarted

  // Close out a session the user has stopped attending. The deadline is
  // credited exactly — seconds before it were watched, seconds after it were
  // not — rather than crediting the whole span or discarding it.
  const deadline = unattendedSince === null ? null : unattendedSince + MAX_UNATTENDED_MS;
  if (deadline !== null && Date.now() >= deadline) {
    Logger.info(LOG, `Unattended for ${MAX_UNATTENDED_MS / 60000} min — closing session`);
    await flushTime(currentUrl, deadline);
    isUserIdle = true;
    sessionStart = null;
    unattendedSince = null;
    persistState();
  } else {
    await flushTime(currentUrl); // Flush accumulated time to storage
  }

  await pruneOldData();        // Drop data_* keys past the retention window
});

// True only for messages from one of this extension's own pages (the popup).
//
// onMessage also receives from the content script, which is injected into
// <all_urls> — so without this test any page's content-script context could
// invoke the destructive handlers below and wipe the day's record or add a
// permanent exclusion. Extension pages have no `sender.tab`; content scripts
// always do. The id check is belt-and-braces: `externally_connectable` is
// absent, so third-party pages cannot reach this listener at all today, and
// this keeps that true if it is ever re-added.
function isFromExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && !sender.tab;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Popup-initiated mutations of today's record ───────────────────────────
  // These run HERE rather than in the popup because withStorageLock is a
  // promise chain inside this worker — it cannot serialise a write issued from
  // the popup's own context. Previously the popup wrote data_YYYY_MM_DD
  // directly, so a flush already in flight (it awaits categorization, which can
  // take seconds) would read before and write after, resurrecting data the user
  // had just cleared or re-adding a domain they had just excluded.
  if (message.type === "EXCLUDE_AND_CLEAR" && isSafeHostKey(message.hostname)) {
    if (!isFromExtensionPage(sender)) {
      Logger.warn(LOG, "Rejected EXCLUDE_AND_CLEAR from a non-extension sender");
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    const hostname = message.hostname;
    (async () => {
      try {
        await ready();
        const stored = await chrome.storage.local.get([EXCLUDED_DOMAINS_KEY]);
        const list = stored[EXCLUDED_DOMAINS_KEY] || [];
        if (!list.includes(hostname)) {
          await storageSet({ [EXCLUDED_DOMAINS_KEY]: [...list, hostname] });
        }
        await withStorageLock(async () => {
          _dataGeneration++;
          const key = getTodayKey();
          const data = await getStorageData(key);
          if (data.domains[hostname]) {
            delete data.domains[hostname];
            recomputeTotals(data);
            await saveStorageData(data, key);
          }
        });
        Logger.info(LOG, `Excluded and cleared: ${hostname}`);
        sendResponse({ ok: true });
      } catch (e) {
        Logger.error(LOG, `Failed to exclude ${hostname}`, e?.message);
        sendResponse({ ok: false, error: e?.message });
      }
    })();
    return true; // async sendResponse
  }

  if (message.type === "CLEAR_TODAY") {
    if (!isFromExtensionPage(sender)) {
      Logger.warn(LOG, "Rejected CLEAR_TODAY from a non-extension sender");
      sendResponse({ ok: false, error: "forbidden" });
      return true;
    }
    (async () => {
      try {
        await ready();
        await withStorageLock(async () => {
          _dataGeneration++;
          await storageRemove(getTodayKey());
          // Drop the in-flight span too, otherwise the seconds accumulated
          // since the last flush are written straight back after the clear.
          sessionStart = isUserIdle || !isWindowFocused ? null : Date.now();
          persistState();
        });
        Logger.info(LOG, "Cleared today's data");
        sendResponse({ ok: true });
      } catch (e) {
        Logger.error(LOG, "Failed to clear today's data", e?.message);
        sendResponse({ ok: false, error: e?.message });
      }
    })();
    return true;
  }

  if (message.type === "USER_ACTIVE") {
    // Only the tab the user is actually looking at may clear the idle flag.
    // The content script runs in every tab, and `scroll` fires on programmatic
    // scrolling, so without this check an auto-scrolling page in a background
    // tab could hold the session open indefinitely while the user was away —
    // crediting that time to whatever page was in the foreground.
    const senderTabId = sender.tab?.id;
    ready().then(() => {
      if (senderTabId == null || senderTabId !== activeTabId) {
        Logger.debug(LOG, `USER_ACTIVE ignored from non-active tab ${senderTabId}`);
        return;
      }
      Logger.debug(LOG, "USER_ACTIVE received from content script");
      // In-page activity (including scrolling, which chrome.idle does not
      // always see as system input) means the page is being attended, so the
      // unattended clock restarts from zero rather than running down.
      if (unattendedSince !== null) {
        unattendedSince = null;
        persistState();
      }
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

// Storage left behind by the Cognito login flow that this version removes.
// Access and refresh tokens are credentials — an install that upgrades into a
// build with no login has no use for them and should not keep them on disk.
const LEGACY_AUTH_KEYS = ["accessToken", "idToken", "refreshToken", "customProfileName"];

async function clearLegacyAuthStorage() {
  const stored = await chrome.storage.local.get(LEGACY_AUTH_KEYS);
  const present = LEGACY_AUTH_KEYS.filter((k) => k in stored);
  if (present.length === 0) return;
  await chrome.storage.local.remove(present);
  Logger.info(LOG, `Removed ${present.length} legacy auth key(s) from storage`);
}

chrome.runtime.setUninstallURL("https://secureview.websaleem.com/uninstall.html");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL || details.reason === "install") {
    // Open the external success page
    chrome.tabs.create({ url: "https://secureview.websaleem.com/installsuccess.html" });
  }
  clearLegacyAuthStorage();
  init();
});

chrome.runtime.onStartup.addListener(init);
