// SecureView Content Script
// Detects user activity on the page and notifies background service worker

(async function () {
  const LOG = "CONTENT";
  await Logger.init();

  Logger.debug(LOG, `Loaded content script: ${location.hostname}`);

  // ─── Title reporting ────────────────────────────────────────────────────────
  // Push the page title to the background immediately so categorization fires
  // as soon as the document is ready — no waiting for the 1-minute alarm.

  let _lastReportedTitle = "";

  function reportTitle(reason) {
    const title = document.title;
    if (!title || title === _lastReportedTitle) return;
    _lastReportedTitle = title;
    Logger.debug(LOG, `Reporting title (${reason}): "${title}"`);
    chrome.runtime.sendMessage({ type: "PAGE_READY", title, url: location.href }).catch(() => {});
  }

  // Fire immediately if document already finished loading, otherwise wait for load
  if (document.readyState === "complete") {
    reportTitle("immediate");
  } else {
    window.addEventListener("load", () => reportTitle("load"), { once: true });
  }

  // Watch for SPA title changes (Gmail, Twitter, etc.). Observe documentElement
  // rather than the current <title> node so we still fire when the title element
  // itself is removed and replaced (react-helmet, Vue head libs, etc.).
  // reportTitle dedupes via _lastReportedTitle, so spurious fires are no-ops.
  new MutationObserver(() => reportTitle("mutation"))
    .observe(document.documentElement, { childList: true, characterData: true, subtree: true });

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
