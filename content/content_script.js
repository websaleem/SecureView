// SecureView Content Script
// Detects user activity on the page and notifies background service worker

(async function () {
  const LOG = "CONTENT";
  await Logger.init();

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
    }
  });
})();
