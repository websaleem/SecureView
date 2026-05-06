// SecureView Popup Script

const LOG = "POPUP";

// ─── Utilities ────────────────────────────────────────────────────────────────

// Escape strings before interpolating into innerHTML. Page titles, AI-returned
// category names, and user-typed exclusion domains are all attacker-controlled.
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Validate a color before letting it into a style="..." attribute. Today the
// values come from hardcoded hex constants, but interpolating raw into CSS
// without a guard is the wrong default — one upstream change to "from AI" and
// it becomes a CSS-injection vector. Falls back to the neutral grey used
// elsewhere if the input doesn't look like a 6-digit hex.
function safeColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(String(c)) ? c : "#7F8C8D";
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  return `${m}m`;
}

function formatDurationShort(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getTodayLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

function getWeekRangeLabel() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function getTodayKey() {
  const now = new Date();
  return `data_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}_${String(now.getDate()).padStart(2, "0")}`;
}

function getFaviconUrl(hostname) {
  return `https://www.google.com/s2/favicons?sz=32&domain=${hostname}`;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadTodayData() {
  const key = getTodayKey();
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || { domains: {}, categories: {}, totalSeconds: 0 });
    });
  });
}

async function loadAllKeys() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const keys = Object.keys(items).filter((k) => k.startsWith("data_")).sort().reverse();
      resolve(keys.map((k) => ({ key: k, data: items[k] })));
    });
  });
}

// Aggregate the most recent up-to-7 days of data into a single { domains,
// categories, totalSeconds, byDay } shape that the existing renderers can
// consume without modification.
//
// - domains: union; seconds summed; category fields taken from the most-recent
//   visit (highest lastVisit) so a re-categorized domain shows its latest label.
// - categories: derived from the aggregated domains (so the totals stay
//   internally consistent).
// - totalSeconds: sum across days.
// - byDay: ordered oldest → newest, filled with zero-time placeholders for any
//   day in the 7-day window that has no stored data, so the UI strip is
//   always 7 rows.
async function loadWeekData() {
  const all = await loadAllKeys();
  const byKey = Object.fromEntries(all.map((e) => [e.key, e.data || {}]));

  // Build last-7-days window (oldest first), filling gaps with empty entries.
  const byDay = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `data_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getDate()).padStart(2, "0")}`;
    const data = byKey[key] || { domains: {}, categories: {}, totalSeconds: 0 };
    byDay.push({ key, date: d, totalSeconds: data.totalSeconds || 0 });
  }

  const aggregated = { domains: {}, categories: {}, totalSeconds: 0, byDay };

  for (const { key } of byDay) {
    const data = byKey[key];
    if (!data) continue;
    for (const d of Object.values(data.domains || {})) {
      const acc = aggregated.domains[d.hostname] || {
        url: d.url, hostname: d.hostname, title: "", seconds: 0,
        category: d.category, categoryIcon: d.categoryIcon, categoryColor: d.categoryColor,
        lastVisit: 0,
      };
      acc.seconds += d.seconds || 0;
      if ((d.lastVisit || 0) >= (acc.lastVisit || 0)) {
        acc.category      = d.category;
        acc.categoryIcon  = d.categoryIcon;
        acc.categoryColor = d.categoryColor;
        acc.title         = d.title || acc.title;
        acc.url           = d.url || acc.url;
        acc.lastVisit     = d.lastVisit;
      }
      aggregated.domains[d.hostname] = acc;
    }
  }

  // Recompute categories + totals from the aggregated domains so the numbers
  // stay consistent (avoids double-counting if a domain's category changed
  // mid-week).
  for (const d of Object.values(aggregated.domains)) {
    if (!aggregated.categories[d.category]) {
      aggregated.categories[d.category] = {
        name: d.category, icon: d.categoryIcon,
        color: d.categoryColor, seconds: 0,
      };
    }
    aggregated.categories[d.category].seconds += d.seconds;
    aggregated.totalSeconds += d.seconds;
  }

  return aggregated;
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderCategories(data) {
  const container = document.getElementById("category-list");
  const cats = Object.values(data.categories).sort((a, b) => b.seconds - a.seconds);
  const total = data.totalSeconds || 1;

  if (cats.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <div class="empty-text">No browsing data yet</div>
        <div class="empty-sub">Start browsing to see your stats</div>
      </div>`;
    return;
  }

  container.innerHTML = cats.map((cat) => {
    const pct        = Math.round((cat.seconds / total) * 100);
    const sitesInCat = Object.values(data.domains)
      .filter((d) => d.category === cat.name)
      .sort((a, b) => b.seconds - a.seconds);
    const topSites   = sitesInCat.slice(0, 5);

    const topSitesHtml = topSites.map((site) => `
      <div class="cat-top-site">
        <img class="cat-top-favicon"
          src="https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(site.hostname)}"
          alt="" />
        <span class="cat-top-hostname">${escapeHtml(site.hostname)}</span>
        <span class="cat-top-time">${formatDuration(site.seconds)}</span>
      </div>`).join("");

    return `
      <div class="category-card">
        <div class="category-header">
          <div class="category-name">
            <span class="category-icon">${escapeHtml(cat.icon)}</span>
            <span>${escapeHtml(cat.name)}</span>
          </div>
          <span class="category-time">${formatDuration(cat.seconds)}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%; background:${safeColor(cat.color)};"></div>
        </div>
        <div class="category-meta">
          <span>${pct}% of browsing time</span>
          <span>${sitesInCat.length} site${sitesInCat.length !== 1 ? "s" : ""}</span>
        </div>
        ${topSites.length ? `<div class="cat-top-sites">${topSitesHtml}</div>` : ""}
      </div>`;
  }).join("");
}

function renderSites(data, filter = "") {
  const container = document.getElementById("site-list");
  let sites = Object.values(data.domains).sort((a, b) => b.seconds - a.seconds);

  if (filter) {
    const q = filter.toLowerCase();
    sites = sites.filter(
      (s) => s.hostname.includes(q) || (s.title && s.title.toLowerCase().includes(q)) || s.category.toLowerCase().includes(q)
    );
  }

  if (sites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌐</div>
        <div class="empty-text">${filter ? "No matching sites" : "No sites visited yet"}</div>
      </div>`;
    return;
  }

  container.innerHTML = sites.map((site) => {
    const favicon = getFaviconUrl(site.hostname);
    return `
      <div class="site-row">
        <img class="site-favicon" src="${favicon}" alt="" />
        <div class="site-favicon-placeholder" style="display:none;">${escapeHtml(site.categoryIcon || "🌐")}</div>
        <div class="site-info">
          <div class="site-hostname">${escapeHtml(site.hostname)}</div>
          ${site.title ? `<div class="site-title">${escapeHtml(site.title)}</div>` : ""}
        </div>
        <div class="site-right">
          <span class="site-time">${formatDuration(site.seconds)}</span>
          <span class="site-category-badge" style="background:${safeColor(site.categoryColor)};">
            ${escapeHtml(site.categoryIcon || "🌐")} ${escapeHtml(site.category)}
          </span>
        </div>
      </div>`;
  }).join("");
}

function renderByDay(byDay) {
  const container = document.getElementById("day-breakdown");
  if (!byDay || !byDay.length) { container.innerHTML = ""; return; }

  const max = Math.max(...byDay.map((d) => d.totalSeconds), 1);
  const todayLocal = new Date();
  todayLocal.setHours(0, 0, 0, 0);

  container.innerHTML = byDay.map((d) => {
    const date = d.date;
    const isToday = date.getFullYear() === todayLocal.getFullYear()
      && date.getMonth()    === todayLocal.getMonth()
      && date.getDate()     === todayLocal.getDate();
    const label = isToday ? "Today" : date.toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
    const pct = Math.round((d.totalSeconds / max) * 100);
    return `
      <div class="day-row${isToday ? " is-today" : ""}">
        <span class="day-label">${escapeHtml(label)}</span>
        <div class="day-bar"><div class="day-bar-fill" style="width:${pct}%;"></div></div>
        <span class="day-time">${formatDurationShort(d.totalSeconds)}</span>
      </div>`;
  }).join("");
}

function renderSummary(data) {
  document.getElementById("total-time").textContent = formatDurationShort(data.totalSeconds || 0);
  document.getElementById("site-count").textContent = Object.keys(data.domains).length;

  const cats = Object.values(data.categories).sort((a, b) => b.seconds - a.seconds);
  if (cats.length > 0) {
    document.getElementById("top-category").textContent = cats[0].icon + " " + cats[0].name;
  } else {
    document.getElementById("top-category").textContent = "—";
  }
}

async function excludeAndClearDomain(hostname, data) {
  // Add to exclusion list
  const settings = await loadSettings();
  if (!settings.excludedDomains.includes(hostname)) {
    await saveExcludedDomains([...settings.excludedDomains, hostname]);
  }

  // Remove domain and rebuild categories + totalSeconds from remaining entries
  delete data.domains[hostname];
  data.categories = {};
  data.totalSeconds = 0;
  for (const d of Object.values(data.domains)) {
    if (!data.categories[d.category]) {
      data.categories[d.category] = { name: d.category, icon: d.categoryIcon, color: d.categoryColor, seconds: 0 };
    }
    data.categories[d.category].seconds += d.seconds;
    data.totalSeconds += d.seconds;
  }

  // Persist the cleaned data
  const key = getTodayKey();
  await new Promise((resolve) => chrome.storage.local.set({ [key]: data }, resolve));
  Logger.info(LOG, `Excluded and cleared tracking for: ${hostname}`);
}

// `refresh` is an optional callback (typically applyPeriod) the exclude
// button calls after mutating today's data, so the categories/sites views
// re-render against the currently selected period (today vs 7 days) instead
// of always dumping today-only data into a week-mode UI.
async function renderCurrentPage(data, refresh) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || tab.url.startsWith("chrome-extension://")) return;

    const hostname   = new URL(tab.url).hostname.replace(/^www\./, "");
    const settings   = await loadSettings();
    const isExcluded = settings.excludedDomains.includes(hostname);

    const stored   = data.domains[hostname];
    const category = stored
      ? { name: stored.category, icon: stored.categoryIcon, color: stored.categoryColor }
      : categorizeUrl(tab.url);

    const el  = document.getElementById("current-page");
    const btn = document.getElementById("block-current-btn");

    document.getElementById("current-url-text").textContent          = hostname;
    document.getElementById("current-category-badge").textContent    = `${category.icon || "🌐"} ${category.name}`;
    el.style.display = "flex";

    function applyExcludedState() {
      el.classList.add("is-excluded");
      document.querySelector(".current-label").textContent = "Excluded:";
      btn.textContent = "🔓";
      btn.title       = "Remove from exclusion list";
      btn.onclick     = async () => {
        const s       = await loadSettings();
        const updated = s.excludedDomains.filter((d) => d !== hostname);
        await saveExcludedDomains(updated);
        renderExclusionList(updated, data);
        applyActiveState();
        Logger.info(LOG, `Removed ${hostname} from exclusion list`);
      };
    }

    function applyActiveState() {
      el.classList.remove("is-excluded");
      document.querySelector(".current-label").textContent = "Now:";
      btn.textContent = "🚫";
      btn.title       = "Exclude this site and clear its tracking data";
      btn.onclick     = async () => {
        await excludeAndClearDomain(hostname, data);
        // Re-render against whichever period is on screen rather than dumping
        // today-only data into the views (which would briefly mismatch the
        // 7-day toggle state until storage.onChanged caught up).
        if (refresh) await refresh();
        const s = await loadSettings();
        renderExclusionList(s.excludedDomains, data);
        applyExcludedState();
      };
    }

    isExcluded ? applyExcludedState() : applyActiveState();
  } catch (e) {}
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const EXCLUDED_DOMAINS_KEY = "excluded_domains";

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([Logger.CONFIG_KEY, "force_cloudfront", EXCLUDED_DOMAINS_KEY], (result) => {
      resolve({
        debugLog:        result[Logger.CONFIG_KEY]?.enabled === true,
        forceCloudFront: result["force_cloudfront"] === true,
        excludedDomains: result[EXCLUDED_DOMAINS_KEY] || []
      });
    });
  });
}

async function saveExcludedDomains(domains) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [EXCLUDED_DOMAINS_KEY]: domains }, resolve);
  });
}

function renderExclusionList(domains, data) {
  const container = document.getElementById("exclusion-list");
  if (domains.length === 0) {
    container.innerHTML = `<div class="exclusion-empty">No domains excluded yet</div>`;
    return;
  }
  container.innerHTML = domains.map((domain, i) => `
    <div class="exclusion-item" data-index="${i}">
      <span class="exclusion-item-domain">${escapeHtml(domain)}</span>
      <button class="exclusion-remove-btn" data-index="${i}" title="Remove">✕</button>
    </div>
  `).join("");

  container.querySelectorAll(".exclusion-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx     = parseInt(btn.dataset.index, 10);
      const settings = await loadSettings();
      const updated  = settings.excludedDomains.filter((_, i) => i !== idx);
      await saveExcludedDomains(updated);
      renderExclusionList(updated, data);
      await renderCurrentPage(data);
      Logger.info(LOG, `Removed excluded domain: ${settings.excludedDomains[idx]}`);
    });
  });
}

async function renderSettings(data) {
  const settings = await loadSettings();
  document.getElementById("setting-debug-log").checked = settings.debugLog;
  document.getElementById("setting-force-cf").checked  = settings.forceCloudFront;
  renderExclusionList(settings.excludedDomains, data);
}

async function renderHistory() {
  const all = await loadAllKeys();
  const container = document.getElementById("history-list");

  if (all.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-text">No history available</div></div>`;
    return;
  }

  const todayKey = getTodayKey();
  container.innerHTML = all.map(({ key, data }) => {
    const [, year, month, day] = key.split("_");
    const date = new Date(year, month - 1, day);
    const label = key === todayKey ? "Today" : date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const sitesCount = Object.keys(data.domains || {}).length;
    return `
      <div class="history-day">
        <span class="history-day-date">${label}</span>
        <span class="history-day-stats">${formatDurationShort(data.totalSeconds || 0)} · ${sitesCount} site${sitesCount !== 1 ? "s" : ""}</span>
      </div>`;
  }).join("");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function init() {
  await Logger.init();
  const manifest = chrome.runtime.getManifest();
  document.getElementById("header-title").textContent   = manifest.name;
  document.getElementById("header-version").textContent = `v${manifest.version}`;

  // Delegated favicon error handler. MV3 CSP blocks inline onerror handlers,
  // so we listen on the capture phase (error events don't bubble).
  document.body.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG") return;
    img.style.display = "none";
    if (img.classList.contains("site-favicon")) {
      const placeholder = img.nextElementSibling;
      if (placeholder && placeholder.classList.contains("site-favicon-placeholder")) {
        placeholder.style.display = "flex";
      }
    }
  }, true);

  // ── Period state ──────────────────────────────────────────────────────────
  // todayData is always today's storage record — it backs the "Now: …"
  // indicator and the exclude/clear flow, both of which must only mutate
  // today regardless of which period the user is viewing.
  // displayData is what the summary / categories / sites views render against.
  let period      = "today";
  let todayData   = await loadTodayData();
  let displayData = todayData;

  async function applyPeriod() {
    const dateLabel  = document.getElementById("today-date");
    const breakdown  = document.getElementById("day-breakdown");
    const searchVal  = document.getElementById("search-input").value.trim();

    if (period === "week") {
      displayData = await loadWeekData();
      dateLabel.textContent = getWeekRangeLabel();
      renderByDay(displayData.byDay);
      breakdown.classList.remove("hidden");
    } else {
      displayData = todayData;
      dateLabel.textContent = getTodayLabel();
      breakdown.classList.add("hidden");
    }

    renderSummary(displayData);
    renderCategories(displayData);
    renderSites(displayData, searchVal);
    await renderCurrentPage(todayData, applyPeriod);
  }

  Logger.info(LOG, `Popup opened: ${Object.keys(todayData.domains).length} sites, ${todayData.totalSeconds}s total`);
  await applyPeriod();

  // Period toggle wiring
  const periodToday = document.getElementById("period-today");
  const periodWeek  = document.getElementById("period-week");
  periodToday.addEventListener("click", async () => {
    if (period === "today") return;
    period = "today";
    periodToday.classList.add("active");
    periodWeek.classList.remove("active");
    await applyPeriod();
  });
  periodWeek.addEventListener("click", async () => {
    if (period === "week") return;
    period = "week";
    periodWeek.classList.add("active");
    periodToday.classList.remove("active");
    await applyPeriod();
  });

  // View toggle
  const btnCats = document.getElementById("btn-categories");
  const btnSites = document.getElementById("btn-sites");
  const viewCats = document.getElementById("view-categories");
  const viewSites = document.getElementById("view-sites");

  btnCats.addEventListener("click", () => {
    btnCats.classList.add("active");
    btnSites.classList.remove("active");
    viewCats.classList.remove("hidden");
    viewSites.classList.add("hidden");
  });

  btnSites.addEventListener("click", () => {
    btnSites.classList.add("active");
    btnCats.classList.remove("active");
    viewSites.classList.remove("hidden");
    viewCats.classList.add("hidden");
  });

  // Search
  document.getElementById("search-input").addEventListener("input", (e) => {
    renderSites(displayData, e.target.value.trim());
  });

  // Clear today
  document.getElementById("clear-btn").addEventListener("click", async () => {
    if (confirm("Clear today's browsing data?")) {
      Logger.info(LOG, "Clearing today's browsing data");
      const key = getTodayKey();
      await chrome.storage.local.remove(key);
      location.reload();
    }
  });

  // History
  document.getElementById("history-btn").addEventListener("click", async () => {
    Logger.debug(LOG, "History panel opened");
    await renderHistory();
    document.getElementById("history-overlay").classList.remove("hidden");
  });

  document.getElementById("close-history").addEventListener("click", () => {
    document.getElementById("history-overlay").classList.add("hidden");
  });

  // Settings
  document.getElementById("settings-btn").addEventListener("click", async () => {
    // Settings overlay's exclude-list mutators operate on today's data.
    await renderSettings(todayData);
    document.getElementById("settings-overlay").classList.remove("hidden");
  });

  document.getElementById("close-settings").addEventListener("click", () => {
    document.getElementById("settings-overlay").classList.add("hidden");
  });

  document.getElementById("setting-debug-log").addEventListener("change", (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ [Logger.CONFIG_KEY]: { enabled } });
    Logger.setEnabled(enabled);
    Logger.info(LOG, `Debug logging ${enabled ? "enabled" : "disabled"} via settings`);
  });

  document.getElementById("setting-force-cf").addEventListener("change", (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ force_cloudfront: enabled });
    Logger.info(LOG, `Force CloudFront ${enabled ? "enabled" : "disabled"} via settings`);
  });

  document.getElementById("exclusion-add-btn").addEventListener("click", async () => {
    const input = document.getElementById("exclusion-input");
    const raw = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!raw) return;
    const settings = await loadSettings();
    if (settings.excludedDomains.includes(raw)) {
      input.value = "";
      return;
    }
    const updated = [...settings.excludedDomains, raw];
    await saveExcludedDomains(updated);
    renderExclusionList(updated, todayData);
    await renderCurrentPage(todayData, applyPeriod);
    Logger.info(LOG, `Added excluded domain: ${raw}`);
    input.value = "";
  });

  document.getElementById("exclusion-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("exclusion-add-btn").click();
  });

  // Live-refresh: pick up category / title / time updates the background
  // writes to storage. Today-mode listens to today's key; week-mode listens to
  // every data_* key change (rare in practice — only today is mutated unless
  // pruning runs).
  const todayKey = getTodayKey();
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const dataKeysChanged = Object.keys(changes).some((k) => /^data_\d{4}_\d{2}_\d{2}$/.test(k));
    if (!dataKeysChanged) return;

    // Always refresh today's snapshot — it backs the "Now: …" indicator and
    // exclude/clear actions regardless of which period is on screen.
    if (todayKey in changes && changes[todayKey].newValue) {
      todayData = changes[todayKey].newValue;
    }

    Logger.debug(LOG, "Storage updated — refreshing display");
    await applyPeriod();
  });
}

document.addEventListener("DOMContentLoaded", init);
