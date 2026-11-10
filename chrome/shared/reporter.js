// SecureView report delivery — the extension half of email reports.
//
// Splits cleanly from report.js on purpose: that file is pure arithmetic with
// no chrome.* calls so the windows can be tested directly; this one talks to
// storage and the network.
//
// WHAT THIS SENDS. On a send, the aggregated window leaves the device: every
// hostname visited in the period with its seconds and category. That is a
// larger disclosure than classification, which sends one hostname at a time,
// and it only happens for an address the user entered and then confirmed by
// clicking a link mailed to it. Nothing is sent while the frequency is off or
// the address is blank.

const REPORT_STATE_KEY = "report_state";
const REPORT_EMAIL_KEY = "reportEmail";
const REPORT_FREQ_KEY = "emailReportFreq";
const REPORT_EXCLUDED_KEY = "excluded_domains";

// Identifies this install to the backend. Random, stored locally, and sent with
// every report call. It is what lets the backend tell "the install that
// subscribed this address" from "someone guessing addresses", so the same
// endpoint cannot be used to discover whether a person uses SecureView.
//
// Not a security boundary for the user's own data — it protects the mailing
// list, not the browsing history, which never leaves except in a report they
// asked for.
function _newClientId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function _getReportState() {
  const stored = await chrome.storage.local.get([REPORT_STATE_KEY]);
  const state = stored[REPORT_STATE_KEY] || {};
  return {
    clientId: typeof state.clientId === "string" ? state.clientId : null,
    // Which address the backend believes is confirmed, and for which install.
    subscribedEmail: typeof state.subscribedEmail === "string" ? state.subscribedEmail : "",
    status: ["none", "pending", "verified"].includes(state.status) ? state.status : "none",
    // Window ids already sent, so a report cannot go out twice even if the
    // worker restarts mid-morning.
    sent: state.sent && typeof state.sent === "object" ? state.sent : {},
    lastError: typeof state.lastError === "string" ? state.lastError : "",
    lastCheckedAt: Number(state.lastCheckedAt) || 0,
  };
}

async function _setReportState(patch) {
  const current = await _getReportState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [REPORT_STATE_KEY]: next });
  return next;
}

async function _ensureClientId() {
  const state = await _getReportState();
  if (state.clientId) return state.clientId;
  const clientId = _newClientId();
  await _setReportState({ clientId });
  return clientId;
}

function _reportUrl(path) {
  const base = getCFConfig()?.reportBase;
  if (!base) return null;
  return `${base}${path}`;
}

async function _postReport(path, payload) {
  const url = _reportUrl(path);
  if (!url) throw new Error("report endpoint not configured");
  const res = await fetch(url, {
    method: "POST",
    // application/json is required by the edge guard on these paths, and is
    // also what makes them unreachable from a web page: a no-cors request
    // cannot set it, and asking for it triggers a preflight that fails.
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Start (or restart) verification for an address.
 *
 * Called when the user saves a new address. The backend mails a confirmation
 * link; until it is clicked nothing else is sent. Changing the address resets
 * the status, because consent is per-address — a confirmed address does not
 * transfer to a new one.
 */
async function subscribeReportEmail(email) {
  const clientId = await _ensureClientId();
  try {
    const { ok, body } = await _postReport("/subscribe", { email, clientId });
    if (!ok) {
      await _setReportState({ lastError: "subscribe_failed" });
      Logger.warn("REPORTS", "Subscribe request failed");
      return "error";
    }
    const status = body.status === "verified" ? "verified" : "pending";
    const before = await _getReportState();
    await _setReportState({
      subscribedEmail: email,
      status,
      // A genuinely new address has sent nothing yet. Coming BACK to one this
      // install already confirmed keeps its history, or this morning's report
      // would go out a second time.
      sent: before.subscribedEmail === email ? before.sent : {},
      lastError: "",
    });
    Logger.info("REPORTS", status === "verified"
      ? "Address is already confirmed for this install"
      : "Verification requested for the saved address");
    return status;
  } catch (e) {
    await _setReportState({ lastError: "network" });
    Logger.warn("REPORTS", `Subscribe failed: ${e?.message}`);
    return "error";
  }
}

/** Ask the backend whether the saved address has been confirmed yet. */
async function refreshReportStatus() {
  const state = await _getReportState();
  if (!state.subscribedEmail || !state.clientId) return state.status;
  try {
    const { ok, body } = await _postReport("/status", {
      email: state.subscribedEmail,
      clientId: state.clientId,
    });
    if (!ok) return state.status;
    // "unknown" means the backend has no row this install can claim — the
    // address was unsubscribed, or expired unconfirmed. Fall back to none so
    // the popup prompts for confirmation again rather than implying all is well.
    const status = body.status === "verified" ? "verified"
      : body.status === "pending" ? "pending" : "none";
    await _setReportState({ status, lastCheckedAt: Date.now() });
    return status;
  } catch {
    return state.status;
  }
}

/**
 * Send the report for the current window, if one is due.
 *
 * Returns a short reason rather than throwing, because the caller is an alarm
 * handler that must not fail loudly on a missed morning.
 *
 * Skip-if-missed is the chosen behaviour: the window is only sent while the
 * clock is inside the morning send window. If Chrome was closed through it,
 * that window's id is never recorded as sent and never retried — tomorrow's id
 * is different, so nothing stacks up.
 */
async function maybeSendReport(now = new Date()) {
  const stored = await chrome.storage.local.get([REPORT_EMAIL_KEY, REPORT_FREQ_KEY, REPORT_EXCLUDED_KEY]);
  const email = typeof stored[REPORT_EMAIL_KEY] === "string" ? stored[REPORT_EMAIL_KEY].trim() : "";
  const frequency = stored[REPORT_FREQ_KEY] === "weekly" ? "weekly" : "daily";
  const excluded = Array.isArray(stored[REPORT_EXCLUDED_KEY]) ? stored[REPORT_EXCLUDED_KEY] : [];
  if (!email) return "no_email";

  if (!isWithinSendWindow(frequency, now)) return "outside_window";

  const state = await _getReportState();
  if (state.status !== "verified" || state.subscribedEmail !== email) {
    // Unconfirmed, or the address changed since confirming. Check once per
    // morning in case the user clicked the link since we last looked.
    const status = await refreshReportStatus();
    if (status !== "verified") return "not_verified";
  }

  const windowId = reportWindowId(frequency, now);
  const fresh = await _getReportState();
  if (fresh.sent && fresh.sent[windowId]) return "already_sent";

  // Read only the days this window needs.
  const w = reportWindow(frequency, now);
  const byKey = await chrome.storage.local.get(w.dayKeys);
  const report = buildReportData(frequency, byKey, now, excluded);

  // Nothing tracked at all: no email. A report saying "0s across 0 sites" is
  // noise, and the window is still marked sent so it is not reconsidered all
  // morning.
  if (report.totalSeconds <= 0) {
    await _setReportState({ sent: { ...fresh.sent, [windowId]: "empty" } });
    Logger.info("REPORTS", `Nothing tracked for ${windowId} — no email sent`);
    return "empty";
  }

  try {
    const { ok, status, body } = await _postReport("/send", {
      email,
      clientId: fresh.clientId,
      report,
    });
    if (ok && body.status === "sent") {
      await _setReportState({ sent: { ...fresh.sent, [windowId]: "sent" }, lastError: "" });
      Logger.info("REPORTS", `${frequency} report sent for ${windowId}`);
      return "sent";
    }
    if (body.status === "duplicate") {
      // The backend already has this window. Record it locally so we stop
      // asking; the two sides now agree.
      await _setReportState({ sent: { ...fresh.sent, [windowId]: "sent" } });
      return "already_sent";
    }
    if (body.status === "not_confirmed") {
      await _setReportState({ status: "pending" });
      return "not_verified";
    }
    await _setReportState({ lastError: `send_${status}` });
    Logger.warn("REPORTS", `Report send refused (${status})`);
    return "failed";
  } catch (e) {
    // Not recorded as sent, so a later tick inside the same morning retries.
    await _setReportState({ lastError: "network" });
    Logger.warn("REPORTS", `Report send failed: ${e?.message}`);
    return "failed";
  }
}

/**
 * Is this build pointed at the dev environment?
 *
 * The test-report control is gated on this rather than on a build-time flag,
 * because the thing that actually matters is which backend would receive the
 * report — and that is decided by the same _CF_HOST substitution the build
 * already performs and already tests. A production zip resolves to the
 * production host and the control stays hidden.
 */
function isDevBuild() {
  const base = getCFConfig()?.reportBase || "";
  return /^https:\/\/dev\./.test(base);
}

/**
 * Send a report for TODAY, on demand, for testing.
 *
 * Bypasses only the morning send window — the thing that otherwise makes
 * verifying this feature a day-long round trip. It does NOT bypass consent: an
 * unconfirmed address is refused here exactly as it is on the scheduled path,
 * because that check is the whole reason the feature is safe to ship.
 *
 * Deliberately TODAY rather than yesterday, so a tester sees the browsing they
 * just did, and so the window id cannot collide with the real daily report and
 * mark it as already sent.
 */
async function sendTestReport(now = new Date()) {
  if (!isDevBuild()) return "not_dev";

  const stored = await chrome.storage.local.get([REPORT_EMAIL_KEY, REPORT_EXCLUDED_KEY]);
  const email = typeof stored[REPORT_EMAIL_KEY] === "string" ? stored[REPORT_EMAIL_KEY].trim() : "";
  const excluded = Array.isArray(stored[REPORT_EXCLUDED_KEY]) ? stored[REPORT_EXCLUDED_KEY] : [];
  if (!email) return "no_email";

  const state = await _getReportState();
  if (state.status !== "verified" || state.subscribedEmail !== email) {
    const status = await refreshReportStatus();
    if (status !== "verified") return "not_verified";
  }

  // Today's key, built the same way as every other day key.
  const todayKey = reportDayKey(now);
  const byKey = await chrome.storage.local.get([todayKey]);
  // Same aggregation, cap and exclusion filter as the scheduled report — only
  // the window differs.
  const sum = summariseDays([todayKey], byKey, excluded);
  if (sum.totalSeconds <= 0) return "nothing_tracked";

  const report = {
    frequency: "daily",
    windowId: `daily:${todayKey}`,
    startDay: todayKey,
    endDay: todayKey,
    daysCovered: 1,
    daysPresent: 1,
    daysMissing: 0,
    totalSeconds: sum.totalSeconds,
    categories: sum.categories,
    siteCount: sum.siteCount,
    domains: sum.domains,
  };

  const fresh = await _getReportState();
  try {
    const { ok, status, body } = await _postReport("/send", {
      email,
      clientId: fresh.clientId,
      report,
    });
    if (ok && body.status === "sent") {
      Logger.info("REPORTS", `Test report sent for ${report.windowId}`);
      return "sent";
    }
    // Surfaced rather than smoothed over: the backend sends one report per
    // window, so a second press the same day is correctly a duplicate.
    if (body.status === "duplicate") return "duplicate";
    if (body.status === "not_confirmed") return "not_verified";
    Logger.warn("REPORTS", `Test report refused (${status})`);
    return "failed";
  } catch (e) {
    Logger.warn("REPORTS", `Test report failed: ${e?.message}`);
    return "failed";
  }
}

/**
 * Drop send history for windows that can no longer come round again.
 *
 * Without this the `sent` map grows for the life of the install. Keyed by
 * window id, so comparing the day key against the retention horizon is enough.
 */
function pruneSentHistory(sent, now = new Date(), keepDays = 40) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const out = {};
  for (const [id, value] of Object.entries(sent || {})) {
    const m = /^(?:daily|weekly):data_(\d{4})_(\d{2})_(\d{2})$/.exec(id);
    if (!m) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d >= cutoff) out[id] = value;
  }
  return out;
}
