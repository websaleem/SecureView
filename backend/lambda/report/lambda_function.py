"""SecureView email reports — subscribe, confirm, send, unsubscribe.

An endpoint that emails content to an address is a spam relay unless it is
built not to be, so the whole design here is about that:

  * Nothing is ever emailed to an address that has not confirmed a link sent to
    it. Subscribing is not consent; clicking the link is.
  * The report body is RENDERED HERE from a constrained payload. The client
    sends hostnames and second counts, never markup and never prose, so there
    is no text an attacker can put in front of a recipient.
  * Every call after subscribe must present the client secret stored on the
    row. Without it the answer is the same whether or not the address is
    subscribed, so the endpoint cannot be used to test whether someone uses
    SecureView.
  * Verification emails are rate limited per address, because the abuse worth
    worrying about is not "attacker reads a report" but "attacker makes us mail
    a stranger repeatedly".

WHAT IS STORED. One row per address: the address, whether it is confirmed, the
client secret, the confirmation token, and the id of the last window sent for
each frequency. Report contents are never stored — they are rendered, sent, and
dropped. Unconfirmed rows expire by TTL so an abandoned subscription does not
linger.
"""

import base64
import hmac
import html
import json
import logging
import os
import re
import secrets
import time
from urllib.parse import urlencode

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

_region = os.environ.get("AWS_REGION", "ap-southeast-2")
_ddb = boto3.client("dynamodb", region_name=_region)
_ses = boto3.client("sesv2", region_name=_region)

TABLE = os.environ["SUBSCRIBERS_TABLE"]
SENDER = os.environ["REPORT_SENDER"]            # e.g. SecureView <reports@websaleem.com>
SITE_BASE = os.environ["SITE_BASE_URL"].rstrip("/")   # for confirm/unsubscribe links

# info@ is a send-only address: nothing reads the replies. Saying so in the mail
# matters more than it looks — a recipient with a question about unexpected mail
# will otherwise reply and hear nothing, which is exactly how legitimate mail
# starts getting reported as spam. Point them at the form that is monitored.
SUPPORT_URL = f"{SITE_BASE}/contact-support.html"
NO_REPLY_NOTE = ("This address is not monitored — replies are not read. "
                 f'Questions go to <a href="{SUPPORT_URL}">Contact Support</a>.')
NO_REPLY_NOTE_TEXT = ("This address is not monitored — replies are not read. "
                      f"Questions: {SUPPORT_URL}")

# An unconfirmed row is a stranger's address we were asked to mail once. Keep it
# only as long as the link is useful.
CONFIRM_TTL_SECONDS = 7 * 24 * 3600

# How long a confirmation link keeps SAYING "confirmed" after it was used.
#
# Mail clients and corporate link scanners fetch every URL in a message before
# a human ever clicks it. That fetch consumes the token, so the user's own click
# arrived at a link that had already been spent and was told "Link not valid" —
# while their subscription was in fact live. For this long after a link is used,
# re-fetching it re-renders the success page instead of an error. It grants no
# capability: the page confirms an address that is already confirmed, and shows
# nothing about who it belongs to.
CONFIRMED_LINK_GRACE_SECONDS = 7 * 24 * 3600

# Verification emails per address per day. The point is not to stop one person
# subscribing twice; it is to stop an address being mailed over and over by
# someone who does not own it.
MAX_VERIFY_EMAILS_PER_DAY = 3

# Reports per address per day. Daily plus weekly on a Monday is two; a third is
# already a sign something is retrying in a loop.
MAX_REPORTS_PER_DAY = 4

# Deliberately not RFC 5322. Rejecting the shapes that are definitely not
# addresses is the goal; SES is the real arbiter of deliverability.
EMAIL_RE = re.compile(r"^[^\s@,;:<>\"]{1,64}@[^\s@.,;:<>\"]+(\.[^\s@.,;:<>\"]+)+$")

# Category labels the classifier can produce. The report groups by these, and
# anything else is folded into "Other" rather than rendered — the client sends
# this field, so it is not trusted to be one of them.
KNOWN_CATEGORIES = {
    "News & Media", "Social Media", "Shopping", "Technology",
    "Finance & Banking", "Education", "Entertainment",
    "Government", "Health & Fitness", "Travel", "Sports",
    "Food & Dining", "Productivity", "Gaming",
    "Adult Content", "Malware / Phishing", "Personal",
    "Jobs & Careers", "Business", "Real Estate",
    "Arts & Design", "Automotive", "Science & Nature",
    "Religion & Spirituality", "Telecommunications",
    "Utilities & Energy", "Other",
}

MAX_DOMAINS_IN_EMAIL = 25
MAX_HOSTNAME_LEN = 253          # the DNS limit; anything longer is not a hostname
MAX_PAYLOAD_DOMAINS = 500       # a day of browsing is tens, not hundreds


# ─── helpers ─────────────────────────────────────────────────────────────────

def _resp(status, obj, content_type="application/json"):
    body = obj if isinstance(obj, str) else json.dumps(obj)
    return {
        "statusCode": status,
        # No Access-Control-Allow-Origin, matching /categorize: the only
        # legitimate caller is the extension's service worker, which holds host
        # permissions and is not subject to CORS. Sending "*" would let any page
        # drive these endpoints from a visitor's browser.
        "headers": {"Content-Type": content_type},
        "body": body,
    }


def _html_page(title, heading, message):
    return _resp(200, f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{html.escape(title)}</title>
<style>
 body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #f8fafc; color: #0f172a; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }}
 .card {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 16px;
          padding: 40px; max-width: 460px; text-align: center; }}
 h1 {{ font-size: 20px; margin: 0 0 12px; }}
 p {{ color: #64748b; line-height: 1.6; margin: 0; font-size: 14px; }}
 a {{ color: #2563eb; }}
</style></head>
<body><div class="card">
<h1>{html.escape(heading)}</h1>
<p>{message}</p>
</div></body></html>""", content_type="text/html; charset=utf-8")


def _now():
    return int(time.time())


def _normalise_email(value):
    """Lowercase and strip. Case is not significant for routing, and treating
    `A@x.com` and `a@x.com` as different rows would let one address hold several
    subscriptions and so several times the rate limit."""
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 254:
        return None
    return email


def _get_row(email):
    try:
        got = _ddb.get_item(TableName=TABLE, Key={"email": {"S": email}})
    except ClientError:
        log.exception(json.dumps({"event": "ddb_get_failed"}))
        raise
    return got.get("Item")


def _secret_matches(row, client_id):
    """Constant-time comparison of the client secret.

    The secret is what separates "the extension that subscribed this address"
    from "someone guessing addresses", so it is compared without leaking
    length or prefix through timing.
    """
    stored = (row.get("clientId") or {}).get("S", "")
    if not stored or not isinstance(client_id, str) or not client_id:
        return False
    return hmac.compare_digest(stored, client_id)


def _day_bucket(ts=None):
    """The UTC day a rate-limit counter belongs to.

    UTC deliberately, unlike the report windows themselves: this is an abuse
    counter, not something a user sees, and it must not reset twice a year when
    the sender's clocks change.
    """
    return time.strftime("%Y-%m-%d", time.gmtime(ts or _now()))


def _bump_counter(email, field, limit):
    """Increment a per-day counter, refusing past `limit`.

    The conditional update is what makes this a limit rather than a suggestion:
    two concurrent requests cannot both read 2, both write 3, and both send.
    """
    bucket = _day_bucket()
    try:
        _ddb.update_item(
            TableName=TABLE,
            Key={"email": {"S": email}},
            UpdateExpression="SET #b = :bucket, #c = if_not_exists(#c, :zero) + :one",
            ConditionExpression=(
                "attribute_not_exists(#b) OR #b <> :bucket OR "
                "attribute_not_exists(#c) OR #c < :limit"
            ),
            ExpressionAttributeNames={"#b": f"{field}Day", "#c": field},
            ExpressionAttributeValues={
                ":bucket": {"S": bucket},
                ":zero": {"N": "0"},
                ":one": {"N": "1"},
                ":limit": {"N": str(limit)},
            },
        )
        return True
    except _ddb.exceptions.ConditionalCheckFailedException:
        return False


def _reset_counter_if_new_day(email, field):
    """Zero a counter whose day bucket has rolled over.

    _bump_counter's condition allows the write when the bucket differs, but the
    stored count would then be carried forward; this resets it first so the new
    day starts at zero.
    """
    bucket = _day_bucket()
    try:
        _ddb.update_item(
            TableName=TABLE,
            Key={"email": {"S": email}},
            UpdateExpression="SET #b = :bucket, #c = :zero",
            ConditionExpression="attribute_exists(#b) AND #b <> :bucket",
            ExpressionAttributeNames={"#b": f"{field}Day", "#c": field},
            ExpressionAttributeValues={":bucket": {"S": bucket}, ":zero": {"N": "0"}},
        )
    except _ddb.exceptions.ConditionalCheckFailedException:
        pass


# ─── rendering ───────────────────────────────────────────────────────────────

def _fmt_duration(seconds):
    seconds = int(seconds)
    h, m = seconds // 3600, (seconds % 3600) // 60
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    if m:
        return f"{m}m"
    return f"{seconds}s"


def _pretty_day(day_key):
    """`data_2026_11_08` -> `8 Nov 2026`, or the raw key if it is malformed."""
    m = re.match(r"^data_(\d{4})_(\d{2})_(\d{2})$", day_key or "")
    if not m:
        return html.escape(str(day_key))
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    if not 1 <= mo <= 12:
        return html.escape(day_key)
    return f"{d} {months[mo]} {y}"


def _sanitise_report(payload):
    """Reduce the client's payload to the few typed values the email needs.

    Everything that reaches the rendered email passes through here. Hostnames
    are length-capped and escaped at render time, seconds are coerced to
    non-negative integers, and categories must be on the known list. The client
    cannot contribute a string that is rendered as anything but text in a table
    cell.
    """
    if not isinstance(payload, dict):
        return None

    frequency = payload.get("frequency")
    if frequency not in ("daily", "weekly"):
        return None

    window_id = payload.get("windowId")
    if not isinstance(window_id, str) or not re.match(r"^(daily|weekly):data_\d{4}_\d{2}_\d{2}$", window_id):
        return None
    if not window_id.startswith(f"{frequency}:"):
        return None

    def _int(value, lo=0, hi=10 ** 9):
        try:
            n = int(value)
        except (TypeError, ValueError):
            return 0
        return max(lo, min(hi, n))

    raw_domains = payload.get("domains")
    if not isinstance(raw_domains, list) or len(raw_domains) > MAX_PAYLOAD_DOMAINS:
        raw_domains = raw_domains[:MAX_PAYLOAD_DOMAINS] if isinstance(raw_domains, list) else []

    domains = []
    for d in raw_domains:
        if not isinstance(d, dict):
            continue
        host = d.get("hostname")
        if not isinstance(host, str):
            continue
        host = host.strip()[:MAX_HOSTNAME_LEN]
        if not host:
            continue
        category = d.get("category")
        if category not in KNOWN_CATEGORIES:
            category = "Other"
        domains.append({
            "hostname": host,
            "seconds": _int(d.get("seconds")),
            "category": category,
        })

    domains.sort(key=lambda d: d["seconds"], reverse=True)

    # Totals are recomputed from the sanitised domains rather than trusted from
    # the payload, so the figures in the email always add up to the rows shown.
    categories = {}
    total = 0
    for d in domains:
        categories[d["category"]] = categories.get(d["category"], 0) + d["seconds"]
        total += d["seconds"]

    days_covered = _int(payload.get("daysCovered"), 1, 31) or (7 if frequency == "weekly" else 1)
    days_present = min(_int(payload.get("daysPresent"), 0, 31), days_covered)

    return {
        "frequency": frequency,
        "windowId": window_id,
        "startDay": payload.get("startDay") if isinstance(payload.get("startDay"), str) else "",
        "endDay": payload.get("endDay") if isinstance(payload.get("endDay"), str) else "",
        "daysCovered": days_covered,
        "daysPresent": days_present,
        "totalSeconds": total,
        "categories": categories,
        "domains": domains,
    }


def _render_email(report, unsub_url):
    freq = "Daily" if report["frequency"] == "daily" else "Weekly"
    start, end = report["startDay"], report["endDay"]
    period = _pretty_day(start) if start == end else f"{_pretty_day(start)} – {_pretty_day(end)}"

    missing = report["daysCovered"] - report["daysPresent"]
    caveat = ""
    if missing > 0:
        # Said plainly rather than omitted: a smaller total with no explanation
        # reads as lost time.
        caveat = (f'<p class="note">No activity was recorded on {missing} of the '
                  f'{report["daysCovered"]} days in this period.</p>')

    cat_rows = "".join(
        f'<tr><td>{html.escape(name)}</td><td class="n">{_fmt_duration(secs)}</td></tr>'
        for name, secs in sorted(report["categories"].items(), key=lambda kv: -kv[1])
    ) or '<tr><td colspan="2" class="empty">Nothing tracked in this period.</td></tr>'

    dom_rows = "".join(
        f'<tr><td>{html.escape(d["hostname"])}</td>'
        f'<td>{html.escape(d["category"])}</td>'
        f'<td class="n">{_fmt_duration(d["seconds"])}</td></tr>'
        for d in report["domains"][:MAX_DOMAINS_IN_EMAIL]
    ) or '<tr><td colspan="3" class="empty">No sites tracked in this period.</td></tr>'

    more = len(report["domains"]) - MAX_DOMAINS_IN_EMAIL
    more_note = f'<p class="note">and {more} more site{"s" if more != 1 else ""}.</p>' if more > 0 else ""

    html_body = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>SecureView {freq} Report</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;">
  <h1 style="font-size:20px;margin:0 0 4px;">SecureView {freq} Report</h1>
  <p style="color:#64748b;font-size:13px;margin:0 0 24px;">{html.escape(period)}</p>

  <p style="font-size:15px;margin:0 0 24px;">
    Total tracked time: <strong>{_fmt_duration(report["totalSeconds"])}</strong>
    across <strong>{len(report["domains"])}</strong> site{"s" if len(report["domains"]) != 1 else ""}.
  </p>
  {caveat}

  <h2 style="font-size:14px;margin:24px 0 8px;">By category</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">{cat_rows}</table>

  <h2 style="font-size:14px;margin:24px 0 8px;">Top sites</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">{dom_rows}</table>
  {more_note}

  <p style="color:#94a3b8;font-size:11px;margin:28px 0 0;border-top:1px solid #e2e8f0;padding-top:16px;">
    Sent because you confirmed this address for SecureView reports.
    <a href="{html.escape(unsub_url)}" style="color:#64748b;">Unsubscribe</a>.<br />
    {NO_REPLY_NOTE}
  </p>
</div></body></html>"""

    text_lines = [
        f"SecureView {freq} Report — {period}",
        "",
        f"Total tracked time: {_fmt_duration(report['totalSeconds'])} across {len(report['domains'])} sites.",
    ]
    if missing > 0:
        text_lines.append(f"No activity recorded on {missing} of {report['daysCovered']} days.")
    text_lines += ["", "By category:"]
    for name, secs in sorted(report["categories"].items(), key=lambda kv: -kv[1]):
        text_lines.append(f"  {name}: {_fmt_duration(secs)}")
    text_lines += ["", "Top sites:"]
    for d in report["domains"][:MAX_DOMAINS_IN_EMAIL]:
        text_lines.append(f"  {d['hostname']} ({d['category']}): {_fmt_duration(d['seconds'])}")
    text_lines += ["", f"Unsubscribe: {unsub_url}", NO_REPLY_NOTE_TEXT]

    subject = f"SecureView {freq} Report — {period}"
    return subject, html_body, "\n".join(text_lines)


def _send_email(to_address, subject, html_body, text_body):
    _ses.send_email(
        FromEmailAddress=SENDER,
        Destination={"ToAddresses": [to_address]},
        Content={
            "Simple": {
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {
                    "Html": {"Data": html_body, "Charset": "UTF-8"},
                    "Text": {"Data": text_body, "Charset": "UTF-8"},
                },
            }
        },
    )


# ─── routes ──────────────────────────────────────────────────────────────────

def _subscribe(body):
    """Start verification for an address. Consent is the click, not this call."""
    email = _normalise_email(body.get("email"))
    client_id = body.get("clientId")
    if not email or not isinstance(client_id, str) or not (16 <= len(client_id) <= 128):
        return _resp(400, {"error": "email and clientId are required"})

    now = _now()
    existing = _get_row(email)

    # REUSE a live token rather than minting a new one on every call.
    #
    # Minting unconditionally made every earlier verification email dead, which
    # is how the first real test failed. The popup saves the address on three
    # separate events — debounced typing, blur, and Enter — so one edit can call
    # this twice seconds apart. The second call replaced the token, and the link
    # in the first email, which is the one a person is most likely to click,
    # answered "Link not valid". Observed in dev: verifySent=2, two sends 2.5s
    # apart, and only the later link working.
    #
    # Reusing it makes every email for an address carry the same working link,
    # which also means a "resend" is genuinely idempotent. The token is replaced
    # only when there is nothing usable to reuse: none stored, expired, or
    # pending for a different installation.
    reusable = None
    if existing:
        stored_token = (existing.get("confirmToken") or {}).get("S", "")
        expires = int((existing.get("confirmExpires") or {}).get("N", "0"))
        pending_for = (existing.get("pendingClientId") or {}).get("S", "")
        same_client = bool(pending_for) and hmac.compare_digest(pending_for, client_id)
        if stored_token and expires > now and same_client:
            reusable = stored_token

    confirm_token = reusable or secrets.token_urlsafe(32)
    unsub_token = secrets.token_urlsafe(32)
    # A reused token keeps its original expiry. Pushing the window out on every
    # save would let a 7-day link live indefinitely for an address nobody ever
    # confirms.
    if reusable:
        confirm_expires = int((existing.get("confirmExpires") or {}).get("N", "0"))
        log.info(json.dumps({"event": "reusing_pending_token"}))
    else:
        confirm_expires = now + CONFIRM_TTL_SECONDS

    # An address that is already confirmed by a DIFFERENT client is not
    # re-pointed on request — otherwise anyone could redirect a stranger's
    # reports to their own install by subscribing the same address. They must
    # confirm the new link, which only the address owner can do.
    if existing and (existing.get("verified") or {}).get("BOOL") and not _secret_matches(existing, client_id):
        log.info(json.dumps({"event": "subscribe_rebind_requires_confirm"}))

    _reset_counter_if_new_day(email, "verifySent")
    _ddb.update_item(
        TableName=TABLE,
        Key={"email": {"S": email}},
        UpdateExpression=(
            "SET confirmToken = :t, confirmExpires = :exp, pendingClientId = :cid, "
            "createdAt = if_not_exists(createdAt, :now), unsubToken = if_not_exists(unsubToken, :unsub), "
            "verified = if_not_exists(verified, :false), #ttl = :ttl"
        ),
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={
            ":t": {"S": confirm_token},
            ":exp": {"N": str(confirm_expires)},
            ":cid": {"S": client_id},
            ":now": {"N": str(now)},
            ":unsub": {"S": unsub_token},
            ":false": {"BOOL": False},
            # Only unconfirmed rows carry a TTL; confirming clears it. Tied to
            # the link's expiry so the row cannot vanish while its link is still
            # advertised as valid.
            ":ttl": {"N": str(confirm_expires)},
        },
    )

    if not _bump_counter(email, "verifySent", MAX_VERIFY_EMAILS_PER_DAY):
        log.warning(json.dumps({"event": "verify_rate_limited"}))
        # Deliberately indistinguishable from success: whether an address has
        # hit its limit is not something a caller needs to learn.
        return _resp(202, {"status": "pending"})

    confirm_url = f"{SITE_BASE}/report/confirm?{urlencode({'token': confirm_token})}"
    _send_email(
        email,
        "Confirm your SecureView email reports",
        f"""<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;padding:24px;color:#0f172a;">
<h1 style="font-size:18px;">Confirm your SecureView reports</h1>
<p style="font-size:14px;color:#334155;">Click below to start receiving browsing reports at this address.
If you did not ask for this, ignore this email — nothing will be sent.</p>
<p><a href="{html.escape(confirm_url)}" style="display:inline-block;background:#2563eb;color:#fff;
padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Confirm this address</a></p>
<p style="font-size:12px;color:#94a3b8;">This link expires in 7 days.<br />{NO_REPLY_NOTE}</p>
</body></html>""",
        f"Confirm your SecureView reports: {confirm_url}\n\n"
        f"If you did not ask for this, ignore this email — nothing will be sent.\n"
        f"This link expires in 7 days.\n\n{NO_REPLY_NOTE_TEXT}",
    )
    log.info(json.dumps({"event": "verification_sent"}))
    return _resp(202, {"status": "pending"})


def _confirmed_page():
    """The success page, shown for both the first use of a link and a re-fetch."""
    return _html_page("SecureView", "Address confirmed",
                      "Reports will arrive on the schedule you chose. "
                      "You can change or stop them from the SecureView popup at any time.")


def _confirm(params):
    token = (params.get("token") or [""])[0]
    if not token or len(token) > 128:
        return _html_page("SecureView", "Link not valid",
                          "This confirmation link is missing or malformed.")

    # Scan is acceptable here: the table holds one row per subscriber, this runs
    # once per subscription, and indexing a single-use token would cost a GSI
    # for no benefit.
    found = None
    # Matches the live token OR one already spent, so a second fetch of the same
    # link can be answered honestly rather than as a failure.
    kwargs = {"TableName": TABLE,
              "FilterExpression": "confirmToken = :t OR confirmedToken = :t",
              "ExpressionAttributeValues": {":t": {"S": token}}}
    while True:
        page = _ddb.scan(**kwargs)
        for item in page.get("Items", []):
            found = item
            break
        if found or "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    if not found:
        return _html_page("SecureView", "Link not valid",
                          "This link has already been used, or it expired.")

    # Already confirmed by an earlier fetch of THIS link — typically a prefetch
    # by the mail client, moments before the user clicked it themselves.
    already = (found.get("confirmedToken") or {}).get("S", "")
    verified = (found.get("verified") or {}).get("BOOL", False)
    if (verified and already and hmac.compare_digest(already, token)
            and int((found.get("confirmedUntil") or {}).get("N", "0")) > _now()):
        return _confirmed_page()

    # The scan also matches spent tokens now, so the live token is checked
    # explicitly rather than inferred from the row having been found.
    if not hmac.compare_digest((found.get("confirmToken") or {}).get("S", ""), token):
        return _html_page("SecureView", "Link not valid",
                          "This link has already been used, or it expired.")

    if int((found.get("confirmExpires") or {}).get("N", "0")) < _now():
        return _html_page("SecureView", "Link expired",
                          "Open SecureView and save your email again to get a new link.")

    email = found["email"]["S"]
    pending = (found.get("pendingClientId") or {}).get("S", "")
    _ddb.update_item(
        TableName=TABLE,
        Key={"email": {"S": email}},
        UpdateExpression=("SET verified = :true, clientId = :cid, "
                          "confirmedToken = :t, confirmedUntil = :until "
                          "REMOVE confirmToken, confirmExpires, pendingClientId, #ttl"),
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={":true": {"BOOL": True}, ":cid": {"S": pending},
                                   ":t": {"S": token},
                                   ":until": {"N": str(_now() + CONFIRMED_LINK_GRACE_SECONDS)}},
    )
    log.info(json.dumps({"event": "address_confirmed"}))
    return _confirmed_page()


def _status(body):
    """Whether this install's address is confirmed.

    Requires the client secret, so the answer is only ever given to the install
    that subscribed. Without it the response is identical to an unknown
    address, which is what stops this being a way to test whether a given
    person uses SecureView.
    """
    email = _normalise_email(body.get("email"))
    client_id = body.get("clientId")
    if not email:
        return _resp(400, {"error": "email is required"})
    row = _get_row(email)
    if not row or not (_secret_matches(row, client_id)
                       or hmac.compare_digest((row.get("pendingClientId") or {}).get("S", ""),
                                              client_id if isinstance(client_id, str) else "")):
        return _resp(200, {"status": "unknown"})
    verified = (row.get("verified") or {}).get("BOOL", False)
    return _resp(200, {"status": "verified" if verified else "pending"})


def _send(body):
    email = _normalise_email(body.get("email"))
    client_id = body.get("clientId")
    if not email:
        return _resp(400, {"error": "email is required"})

    report = _sanitise_report(body.get("report"))
    if not report:
        return _resp(400, {"error": "report payload is not valid"})

    row = _get_row(email)
    if not row or not _secret_matches(row, client_id):
        # Same answer as "not confirmed": no caller learns whether the address
        # is subscribed to anything.
        return _resp(200, {"status": "not_confirmed"})
    if not (row.get("verified") or {}).get("BOOL", False):
        return _resp(200, {"status": "not_confirmed"})

    # Send-once, keyed on the window rather than the time: a retry after a
    # service-worker restart, or two alarms in one morning, resolve to the same
    # id and cannot both send.
    sent_key = f"lastSent{report['frequency'].capitalize()}"
    if (row.get(sent_key) or {}).get("S") == report["windowId"]:
        return _resp(200, {"status": "duplicate"})

    _reset_counter_if_new_day(email, "reportsSent")
    if not _bump_counter(email, "reportsSent", MAX_REPORTS_PER_DAY):
        log.warning(json.dumps({"event": "report_rate_limited"}))
        return _resp(429, {"status": "rate_limited"})

    unsub_token = (row.get("unsubToken") or {}).get("S", "")
    unsub_url = f"{SITE_BASE}/report/unsubscribe?{urlencode({'token': unsub_token})}"
    subject, html_body, text_body = _render_email(report, unsub_url)

    try:
        _send_email(email, subject, html_body, text_body)
    except ClientError as exc:
        log.error(json.dumps({"event": "ses_send_failed",
                              "error_code": exc.response.get("Error", {}).get("Code")}))
        return _resp(502, {"status": "send_failed"})

    # Recorded only after SES accepted it, so a failed send can be retried.
    _ddb.update_item(
        TableName=TABLE,
        Key={"email": {"S": email}},
        UpdateExpression=f"SET {sent_key} = :w, lastSentAt = :now",
        ExpressionAttributeValues={":w": {"S": report["windowId"]}, ":now": {"N": str(_now())}},
    )
    log.info(json.dumps({"event": "report_sent", "frequency": report["frequency"],
                         "domains": len(report["domains"]),
                         "total_seconds": report["totalSeconds"]}))
    return _resp(200, {"status": "sent"})


def _unsubscribe(params):
    token = (params.get("token") or [""])[0]
    if not token or len(token) > 128:
        return _html_page("SecureView", "Link not valid", "This unsubscribe link is malformed.")

    # A BARE FETCH MUST NOT UNSUBSCRIBE.
    #
    # Same cause as the confirmation link: mail clients and link scanners fetch
    # every URL in a message before a human sees it. This endpoint deleted the
    # subscription on that fetch, so reports could stop with nobody having
    # clicked anything, and nothing to show why. The emailed link now only
    # renders a button; the button's URL is what unsubscribes.
    #
    # Still a GET, so the signer's allowlist is unchanged. RFC 8058 one-click
    # unsubscribe would want a POST, which needs a signer and IAM change; this
    # fixes the silent-unsubscribe without touching the classifier's path.
    if (params.get("confirm") or [""])[0] != "1":
        link = f"{SITE_BASE}/report/unsubscribe?{urlencode({'token': token, 'confirm': '1'})}"
        return _html_page(
            "SecureView", "Stop these reports?",
            "Confirm that you want SecureView to stop emailing reports to this "
            f'address.<br /><br /><a href="{html.escape(link)}">Yes, unsubscribe</a>')

    found = None
    kwargs = {"TableName": TABLE,
              "FilterExpression": "unsubToken = :t",
              "ExpressionAttributeValues": {":t": {"S": token}}}
    while True:
        page = _ddb.scan(**kwargs)
        for item in page.get("Items", []):
            found = item
            break
        if found or "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    # Already-unsubscribed and never-subscribed get the same page: an
    # unsubscribe link should not report whether an address was on a list.
    if found:
        _ddb.delete_item(TableName=TABLE, Key={"email": {"S": found["email"]["S"]}})
        log.info(json.dumps({"event": "unsubscribed"}))
    return _html_page("SecureView", "Unsubscribed",
                      "No further reports will be sent to this address. "
                      "Clear the email in the SecureView popup to stop it asking again.")


# ─── entry point ─────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    request_id = getattr(context, "aws_request_id", "local")
    path = (event.get("path") or event.get("rawPath") or "").rstrip("/")
    method = (event.get("httpMethod") or "").upper()
    route = path.rsplit("/report", 1)[-1] or "/"

    log.info(json.dumps({"event": "request", "route": route, "method": method,
                         "request_id": request_id}))

    try:
        body = {}
        if method == "POST":
            # Require application/json on the POST routes, enforced here rather
            # than at the edge.
            #
            # The /categorize behaviour has a CloudFront function demanding
            # exactly this, but it cannot be reused on /report/*: the
            # confirmation and unsubscribe links are browser GETs and the guard
            # would reject them. So the check moves inside, where GET and POST
            # can be told apart.
            #
            # It matters for the same reason it did there. A cross-origin
            # no-cors fetch may only send a CORS-safelisted content type —
            # text/plain, multipart/form-data, x-www-form-urlencoded — never
            # application/json. Asking for it leaves no-cors mode, which forces
            # a preflight that fails because nothing here answers CORS. Without
            # this, any web page could make us mail a verification link to an
            # address of its choosing from a visitor's browser.
            headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
            media_type = (headers.get("content-type") or "").split(";")[0].strip().lower()
            if media_type != "application/json":
                log.warning(json.dumps({"event": "rejected_media_type", "route": route}))
                return _resp(415, {"error": "content-type must be application/json"})

            raw = event.get("body") or "{}"
            if event.get("isBase64Encoded"):
                raw = base64.b64decode(raw).decode("utf-8", errors="replace")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                return _resp(400, {"error": "body must be JSON"})
            if not isinstance(body, dict):
                return _resp(400, {"error": "body must be a JSON object"})

        # API Gateway hands these over as a flat dict already; wrap each value in
        # a list so the route handlers can read them uniformly.
        raw_params = event.get("queryStringParameters") or {}
        params = {k: [v] for k, v in raw_params.items() if isinstance(v, str)}

        if method == "POST" and route == "/subscribe":
            return _subscribe(body)
        if method == "POST" and route == "/status":
            return _status(body)
        if method == "POST" and route == "/send":
            return _send(body)
        if method == "GET" and route == "/confirm":
            return _confirm(params)
        if method == "GET" and route == "/unsubscribe":
            return _unsubscribe(params)

        return _resp(404, {"error": "not found"})

    except Exception as exc:
        log.error(json.dumps({"event": "unhandled_exception", "request_id": request_id,
                              "error_type": type(exc).__name__, "error": str(exc)}))
        return _resp(500, {"error": "An internal error occurred"})
