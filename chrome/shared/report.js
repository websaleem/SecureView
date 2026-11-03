// SecureView email report windows and aggregation.
//
// Shared by the background worker (which schedules and sends) and the popup
// (which shows what the next report will cover). Pure functions only — no
// chrome.* calls — so the window arithmetic can be tested directly, which is
// the point: "yesterday midnight to midnight" and "Monday to Sunday" are easy
// to state and easy to get subtly wrong at month, year and DST boundaries.
//
// EVERYTHING HERE IS LOCAL TIME. The stored day keys are built from local
// calendar dates (see dayKeyFor in background.js), a day boundary means the
// user's midnight, and "Monday" means Monday where the user is. Mixing in UTC
// would shift every window by the timezone offset and, for anyone east of
// Greenwich, silently report the wrong day.

// The hour a report is allowed to go out, and how long after it the attempt
// stays valid.
//
// MV3 alarms only fire while Chrome is running, so a report cannot be
// guaranteed at a fixed minute. The window below is the compromise: any time
// Chrome is awake between 08:00 and 11:00 local counts as "morning". Miss it
// entirely — the browser was closed all morning — and that report is skipped
// rather than arriving at an odd hour or stacking up behind others.
const REPORT_HOUR = 8;
const REPORT_GRACE_HOURS = 3;

// Local midnight at the start of the day `date` falls in.
function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// The storage key for a local calendar date. Must stay identical to
// dayKeyFor() in background.js — test/verify-report-windows.mjs asserts the two
// agree across a long date range rather than trusting this comment.
function reportDayKey(date) {
  return `data_${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, "0")}_${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * The window a report covers, as whole local days.
 *
 * daily  — yesterday only: 00:00 to 24:00, one day.
 * weekly — the previous Monday 00:00 to the previous Sunday 24:00, seven days.
 *          Derived from the most recent Monday rather than by counting back
 *          seven days from today, so the result is a calendar week even if the
 *          function is called on a day other than Monday.
 *
 * Returns day keys oldest-first, plus the instants the window spans. `endMs` is
 * exclusive — the first instant of the day *after* the window — so a caller
 * comparing timestamps never has to reason about 23:59:59.999.
 */
function reportWindow(frequency, now = new Date()) {
  const today = startOfLocalDay(now);

  let start;
  let end;   // inclusive last day of the window
  if (frequency === "weekly") {
    // getDay(): 0 = Sunday, 1 = Monday. Shift so Monday is 0.
    const daysSinceMonday = (today.getDay() + 6) % 7;
    const thisMonday = addDays(today, -daysSinceMonday);
    start = addDays(thisMonday, -7);
    end = addDays(thisMonday, -1);
  } else {
    start = addDays(today, -1);
    end = start;
  }

  const dayKeys = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    dayKeys.push(reportDayKey(d));
  }

  return {
    frequency: frequency === "weekly" ? "weekly" : "daily",
    dayKeys,
    startMs: start.getTime(),
    endMs: addDays(end, 1).getTime(),   // exclusive
    startDate: start,
    endDate: end,
  };
}

/**
 * A stable identifier for one window, used to decide whether a report has
 * already been sent.
 *
 * Keyed on the window rather than on the send time: two attempts on the same
 * morning, or an attempt after a service-worker restart, resolve to the same id
 * and so cannot send twice. It also means a skipped window stays skipped — the
 * id simply never gets recorded, and tomorrow's id is different.
 */
function reportWindowId(frequency, now = new Date()) {
  const w = reportWindow(frequency, now);
  return `${w.frequency}:${w.dayKeys[0]}`;
}

/**
 * Is `now` inside the morning send window for this frequency?
 *
 * Weekly reports only go out on Mondays. Daily reports go out every day. Both
 * require the local hour to be within [REPORT_HOUR, REPORT_HOUR + grace).
 */
function isWithinSendWindow(frequency, now = new Date()) {
  const hour = now.getHours();
  if (hour < REPORT_HOUR || hour >= REPORT_HOUR + REPORT_GRACE_HOURS) return false;
  if (frequency === "weekly") return now.getDay() === 1;   // Monday
  return true;
}

/**
 * Aggregate stored days into the payload a report is rendered from.
 *
 * `byKey` maps a day key to that day's stored record. Days absent from storage
 * contribute nothing and are counted in `daysMissing`, so a report can say it
 * covers five of seven days instead of quietly presenting a smaller total as
 * the whole week.
 *
 * Domain seconds are summed across days. Category labels are taken from the
 * most recent visit, matching how the popup aggregates a week: a domain
 * reclassified mid-window reports under its latest category rather than being
 * split across two.
 */
function buildReportData(frequency, byKey, now = new Date()) {
  const w = reportWindow(frequency, now);

  const domains = {};
  let daysPresent = 0;

  for (const key of w.dayKeys) {
    const day = byKey[key];
    if (!day) continue;
    daysPresent++;
    for (const d of Object.values(day.domains || {})) {
      if (!d || !d.hostname) continue;
      const acc = domains[d.hostname] || {
        hostname: d.hostname,
        seconds: 0,
        category: d.category || "Other",
        lastVisit: 0,
      };
      acc.seconds += d.seconds || 0;
      if ((d.lastVisit || 0) >= acc.lastVisit) {
        acc.lastVisit = d.lastVisit || 0;
        acc.category = d.category || acc.category;
      }
      domains[d.hostname] = acc;
    }
  }

  // Categories are derived from the aggregated domains rather than summed from
  // each day's own category totals, so a reclassified domain cannot be counted
  // under both labels.
  const categories = {};
  let totalSeconds = 0;
  for (const d of Object.values(domains)) {
    const cat = d.category || "Other";
    categories[cat] = (categories[cat] || 0) + d.seconds;
    totalSeconds += d.seconds;
  }

  const topDomains = Object.values(domains)
    .sort((a, b) => b.seconds - a.seconds)
    .map(({ hostname, seconds, category }) => ({ hostname, seconds, category }));

  return {
    frequency: w.frequency,
    windowId: `${w.frequency}:${w.dayKeys[0]}`,
    startDay: w.dayKeys[0],
    endDay: w.dayKeys[w.dayKeys.length - 1],
    daysCovered: w.dayKeys.length,
    daysPresent,
    daysMissing: w.dayKeys.length - daysPresent,
    totalSeconds,
    categories,
    domains: topDomains,
  };
}
