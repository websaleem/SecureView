// SecureView Content Script
// Detects user activity on the page and notifies background service worker

(function () {
  const LOG = "CONTENT";

  // Listeners are registered synchronously below, BEFORE the logger's config is
  // read. This used to be an async IIFE that awaited Logger.init() first, so a
  // storage read that threw — which is what happens to a content script left
  // orphaned by an extension update — rejected before a single listener was
  // attached, and the script silently did nothing for that tab. Whether debug
  // logging is on has no business gating whether the extension works.
  Logger.init()
    .then(() => Logger.debug(LOG, `Loaded content script: ${location.hostname}`))
    .catch(() => { /* logging config unavailable; tracking continues regardless */ });

  // ─── Title reporting ────────────────────────────────────────────────────────
  // Push the page title to the background immediately so categorization fires
  // as soon as the document is ready — no waiting for the 1-minute alarm.

  let _lastReportedTitle = "";

  function reportTitle(reason) {
    const title = document.title;
    if (!title || title === _lastReportedTitle) return;
    _lastReportedTitle = title;
    Logger.debug(LOG, `Reporting title (${reason}): "${title}"`);
    // No url field: the background reads sender.tab.url instead, because a page
    // controls what its content script can claim. Sending location.href anyway
    // meant the full URL — query string and fragment included — travelled in a
    // message nothing reads, one refactor away from being trusted.
    chrome.runtime.sendMessage({ type: "PAGE_READY", title }).catch(() => {});
  }

  // Fire immediately if document already finished loading, otherwise wait for load
  if (document.readyState === "complete") {
    reportTitle("immediate");
  } else {
    window.addEventListener("load", () => reportTitle("load"), { once: true });
  }

  // Watch for SPA title changes (Gmail, Twitter, etc.). Observe only <head>
  // rather than the entire DOM tree — the <title> element lives in <head>, so
  // this covers re-renders while avoiding the performance cost of firing on
  // every body mutation (heavy SPAs can trigger thousands per second).
  // reportTitle dedupes via _lastReportedTitle, so spurious fires are no-ops.
  const headEl = document.head || document.querySelector('head');
  if (headEl) {
    new MutationObserver(() => reportTitle("mutation"))
      .observe(headEl, { childList: true, characterData: true, subtree: true });
  }

  // ─── Activity reporting ──────────────────────────────────────────────────────

  let activityTimeout = null;
  const ACTIVITY_DEBOUNCE_MS = 10000; // Report activity every 10s max

  function reportActivity() {
    if (activityTimeout) return; // Already scheduled
    Logger.debug(LOG, `User activity detected on: ${location.hostname}`);
    chrome.runtime.sendMessage({ type: "USER_ACTIVE" }).catch(() => {});
    activityTimeout = setTimeout(() => {
      activityTimeout = null;
    }, ACTIVITY_DEBOUNCE_MS);
  }

  // Events that indicate user is actively using the page
  const ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "scroll", "touchstart", "wheel"];
  ACTIVITY_EVENTS.forEach((event) => {
    document.addEventListener(event, reportActivity, { passive: true });
  });

  // Visibility change (tab switching via keyboard or mobile)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      Logger.debug(LOG, `Tab became visible: ${location.hostname}`);
      reportActivity();
      reportTitle("visible"); // Re-report title in case it changed while tab was hidden
    }
  });
})();
