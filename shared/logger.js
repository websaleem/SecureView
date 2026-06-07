// SecureView Debug Logger
// Default: enabled in beta builds (manifest name contains "beta"), disabled in prod.
// Override via DevTools console on any extension context:
//   Enable:  chrome.storage.local.set({ debug_config: { enabled: true } })
//   Disable: chrome.storage.local.set({ debug_config: { enabled: false } })
// Changes take effect immediately without reloading the extension.

const Logger = (() => {
  const CONFIG_KEY = "debug_config";
  const _isBeta = chrome.runtime.getManifest().name.toLowerCase().includes("beta");
  let _enabled = _isBeta;  // on by default for beta, off for prod

  function timestamp() {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return (
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
    );
  }

  function prefix(level, module) {
    return `[${timestamp()}] [${level.padEnd(5)}] [${module}]`;
  }

  return {
    CONFIG_KEY,

    // Load enabled state from storage. Call once at startup in each context.
    async init() {
      return new Promise((resolve) => {
        chrome.storage.local.get([CONFIG_KEY], (result) => {
          if (CONFIG_KEY in result) {
            _enabled = result[CONFIG_KEY]?.enabled === true;
          }
          // else keep the env-based default (_isBeta)
          resolve();
        });
      });
    },

    setEnabled(value) {
      _enabled = !!value;
    },

    isEnabled() {
      return _enabled;
    },

    debug(module, message, ...args) {
      if (!_enabled) return;
      console.debug(prefix("DEBUG", module), message, ...args);
    },

    info(module, message, ...args) {
      if (!_enabled) return;
      console.info(prefix("INFO", module), message, ...args);
    },

    warn(module, message, ...args) {
      if (!_enabled) return;
      console.warn(prefix("WARN", module), message, ...args);
    },

    // Errors always log regardless of the enabled flag
    error(module, message, ...args) {
      console.error(prefix("ERROR", module), message, ...args);
    }
  };
})();

// Live reload — reacts to storage changes without extension restart.
// Works in service worker, content script, and popup contexts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[Logger.CONFIG_KEY]) {
    const enabled = changes[Logger.CONFIG_KEY].newValue?.enabled === true;
    Logger.setEnabled(enabled);
    // Always print this so the user gets confirmation in the console
    console.info(`[SecureView] Debug logging ${enabled ? "enabled" : "disabled"}`);
  }
});
