#!/usr/bin/env python3
"""Unit tests for the email report Lambda.

The parts worth testing here are the ones that protect a recipient, not the
plumbing: nothing is emailed to an unconfirmed address, the client secret
gates every call, the report body cannot carry attacker markup, and a window
cannot be sent twice.

boto3 is stubbed, so no AWS call is made and no email is sent.

Usage:  python3 test/test_report_lambda.py
"""
import importlib
import json
import time
import re
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    if not ok:
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")


def check_true(name, value):
    check(name, bool(value), True)


# ─── stub boto3 before importing the module under test ──────────────────────
class FakeConditionalCheckFailed(Exception):
    pass


class FakeDDB:
    def __init__(self):
        self.rows = {}
        self.exceptions = types.SimpleNamespace(
            ConditionalCheckFailedException=FakeConditionalCheckFailed)
        self.deleted = []

    def get_item(self, TableName=None, Key=None):
        email = Key["email"]["S"]
        return {"Item": self.rows[email]} if email in self.rows else {}

    def update_item(self, TableName=None, Key=None, UpdateExpression=None,
                    ConditionExpression=None, ExpressionAttributeNames=None,
                    ExpressionAttributeValues=None):
        # Only the behaviours the tests rely on are modelled: rate-limit
        # refusal, and recording values the code later reads back.
        email = Key["email"]["S"]
        row = self.rows.setdefault(email, {"email": {"S": email}})
        names = ExpressionAttributeNames or {}
        vals = ExpressionAttributeValues or {}
        if ConditionExpression and "#c < :limit" in ConditionExpression:
            field = names.get("#c")
            current = int(row.get(field, {}).get("N", "0"))
            limit = int(vals[":limit"]["N"])
            bucket_field = names.get("#b")
            same_day = row.get(bucket_field, {}).get("S") == vals[":bucket"]["S"]
            if same_day and current >= limit:
                raise FakeConditionalCheckFailed()
            row[bucket_field] = vals[":bucket"]
            row[field] = {"N": str(current + 1 if same_day else 1)}
            return {}
        if ConditionExpression and "#b <> :bucket" in ConditionExpression:
            raise FakeConditionalCheckFailed()
        for frag, key in (("verified = :true", "verified"),):
            if frag in (UpdateExpression or ""):
                row[key] = {"BOOL": True}
        if "confirmToken = :t" in (UpdateExpression or ""):
            row["confirmToken"] = vals[":t"]
            row["confirmExpires"] = vals[":exp"]
            row["pendingClientId"] = vals[":cid"]
            row.setdefault("unsubToken", vals[":unsub"])
            row.setdefault("verified", vals[":false"])
            # Modelled because the bug was here: a TTL written onto a row that
            # was already confirmed.
            if "#ttl = :ttl" in UpdateExpression:
                row["ttl"] = vals[":ttl"]
        if "lastSentDaily" in (UpdateExpression or ""):
            row["lastSentDaily"] = vals[":w"]
        if "lastSentWeekly" in (UpdateExpression or ""):
            row["lastSentWeekly"] = vals[":w"]
        if "clientId = :cid" in (UpdateExpression or ""):
            row["clientId"] = vals[":cid"]
        if "confirmedToken = :t" in (UpdateExpression or ""):
            row["confirmedToken"] = vals[":t"]
            row["confirmedUntil"] = vals[":until"]
        # REMOVE really has to remove, or the idempotency test would pass by
        # finding a confirmToken the live table had already cleared.
        rem = (UpdateExpression or "").split("REMOVE")
        if len(rem) > 1:
            for frag in rem[1].split(","):
                attr = frag.strip()
                attr = names.get(attr, attr)
                row.pop(attr, None)
        return {}

    def scan(self, TableName=None, FilterExpression=None,
             ExpressionAttributeValues=None, ExclusiveStartKey=None):
        token = ExpressionAttributeValues[":t"]["S"]
        # The real filter may OR several token fields together; match whichever
        # ones it actually names, so the fake cannot pass a test the live scan
        # would fail.
        fields = [f for f in ("confirmToken", "confirmedToken", "unsubToken")
                  if f"{f} = :t" in (FilterExpression or "")]
        assert fields, f"unmodelled filter: {FilterExpression}"
        items = [r for r in self.rows.values()
                 if any(r.get(f, {}).get("S") == token for f in fields)]
        return {"Items": items}

    def delete_item(self, TableName=None, Key=None):
        self.deleted.append(Key["email"]["S"])
        self.rows.pop(Key["email"]["S"], None)


class FakeSES:
    def __init__(self):
        self.sent = []

    def send_email(self, **kwargs):
        self.sent.append(kwargs)


FAKE_DDB = FakeDDB()
FAKE_SES = FakeSES()

fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda service_name=None, region_name=None, **kw: (
    FAKE_DDB if service_name == "dynamodb" else FAKE_SES)
sys.modules["boto3"] = fake_boto3

fake_exc = types.ModuleType("botocore.exceptions")


class ClientError(Exception):
    def __init__(self, response=None, operation_name=None):
        super().__init__("client error")
        self.response = response or {}


fake_exc.ClientError = ClientError
sys.modules["botocore"] = types.ModuleType("botocore")
sys.modules["botocore.exceptions"] = fake_exc

os.environ["SUBSCRIBERS_TABLE"] = "test-table"
os.environ["REPORT_SENDER"] = "SecureView <reports@example.com>"
os.environ["SITE_BASE_URL"] = "https://secureview.example.com"

sys.path.insert(0, os.path.join(ROOT, "backend", "lambda", "report"))
rpt = importlib.import_module("lambda_function")


def ctx():
    return types.SimpleNamespace(aws_request_id="test")


def call(method, path, body=None, query=None, content_type="application/json"):
    event = {"httpMethod": method, "path": path}
    if content_type is not None:
        event["headers"] = {"Content-Type": content_type}
    if body is not None:
        event["body"] = json.dumps(body)
    if query:
        event["queryStringParameters"] = query
    resp = rpt.lambda_handler(event, ctx())
    try:
        parsed = json.loads(resp["body"])
    except (json.JSONDecodeError, TypeError):
        parsed = resp["body"]
    return resp["statusCode"], parsed


GOOD_REPORT = {
    "frequency": "daily",
    "windowId": "daily:data_2026_11_08",
    "startDay": "data_2026_11_08",
    "endDay": "data_2026_11_08",
    "daysCovered": 1,
    "daysPresent": 1,
    "domains": [{"hostname": "github.com", "seconds": 600, "category": "Technology"}],
}

print("--- consent: nothing is sent to an unconfirmed address ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "stranger@example.com", "clientId": "c" * 32, "report": GOOD_REPORT})
check("send to unknown address reports not_confirmed", out.get("status"), "not_confirmed")
check("no email sent to an unknown address", len(FAKE_SES.sent), 0)

print("\n--- subscribe sends a verification link, not a report ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/subscribe", {"email": "owner@example.com", "clientId": "a" * 32})
check("subscribe accepted", (code, out.get("status")), (202, "pending"))
check("exactly one email sent", len(FAKE_SES.sent), 1)
sent = FAKE_SES.sent[0]
check("verification goes to the subscribed address",
      sent["Destination"]["ToAddresses"], ["owner@example.com"])
check_true("subject is about confirming",
           "Confirm" in sent["Content"]["Simple"]["Subject"]["Data"])
check_true("body carries a confirm link",
           "/report/confirm?token=" in sent["Content"]["Simple"]["Body"]["Html"]["Data"])

print("\n--- a repeated subscribe must not invalidate the first link ---")
# The popup saves on three events, so one edit can call subscribe twice. If the
# token is replaced, the link in the first email is dead — which is exactly how
# the first real-inbox test failed.
FAKE_SES.sent.clear()
call("POST", "/report/subscribe", {"email": "twice@example.com", "clientId": "t" * 32})
first_token = FAKE_DDB.rows["twice@example.com"]["confirmToken"]["S"]
first_expiry = FAKE_DDB.rows["twice@example.com"]["confirmExpires"]["N"]
call("POST", "/report/subscribe", {"email": "twice@example.com", "clientId": "t" * 32})
second_token = FAKE_DDB.rows["twice@example.com"]["confirmToken"]["S"]
check("the token is reused, so the first link still works", second_token, first_token)
check("and its expiry is not pushed out",
      FAKE_DDB.rows["twice@example.com"]["confirmExpires"]["N"], first_expiry)
# Both emails carry the same link, so either is clickable.
links = [d["Content"]["Simple"]["Body"]["Html"]["Data"] for d in FAKE_SES.sent]
check("every email sent carries that same token",
      all(f"token={first_token}" in l for l in links), True)
code, page = call("GET", "/report/confirm", query={"token": first_token, "confirm": "1"})
check("the first email's link confirms successfully", "confirmed" in str(page).lower(), True)

print("\n--- a link that was prefetched must still work for the user ---")
# Mail clients and corporate link scanners fetch every URL in a message before a
# human clicks it. That fetch confirms the address and spends the token, so the
# user's own click used to land on "Link not valid" while their subscription was
# in fact live. This is the second half of the dead-link report.
code, page = call("GET", "/report/confirm", query={"token": first_token, "confirm": "1"})
check("a second fetch of the same link still reports success",
      "confirmed" in str(page).lower(), True)
check_true("and does not claim the link is invalid",
           "not valid" not in str(page).lower())
check_true("the address stays confirmed",
           FAKE_DDB.rows["twice@example.com"]["verified"]["BOOL"] is True)

# The grace is time-boxed, not permanent: once it lapses the honest answer is
# that the link is spent.
FAKE_DDB.rows["twice@example.com"]["confirmedUntil"] = {"N": "1"}
code, page = call("GET", "/report/confirm", query={"token": first_token, "confirm": "1"})
check("once the grace has lapsed the link is reported as used",
      "not valid" in str(page).lower(), True)

check("an unknown token is still rejected",
      "not valid" in str(call("GET", "/report/confirm", query={"token": "z" * 40, "confirm": "1"})[1]).lower(),
      True)

print("\n--- an unsubscribe link must not fire on a prefetch ---")
# Worse than the confirm case: a scanner fetching this URL used to delete the
# subscription outright, so reports stopped with nobody having clicked anything.
call("POST", "/report/subscribe", {"email": "unsub@example.com", "clientId": "u" * 32})
utok = FAKE_DDB.rows["unsub@example.com"]["unsubToken"]["S"]
FAKE_DDB.deleted.clear()
code, page = call("GET", "/report/unsubscribe", query={"token": utok})
check_true("a bare fetch does not unsubscribe", "unsub@example.com" not in FAKE_DDB.deleted)
check_true("the row survives it", "unsub@example.com" in FAKE_DDB.rows)
check_true("it asks for confirmation instead", "confirm=1" in str(page))
# And the button still works.
code, page = call("GET", "/report/unsubscribe", query={"token": utok, "confirm": "1"})
check_true("confirming it does unsubscribe", "unsub@example.com" in FAKE_DDB.deleted)
check("and says so", "unsubscribed" in str(page).lower(), True)

print("\n--- a different installation does NOT get the pending token ---")
# Reuse is scoped to the installation that asked. Handing a stranger's pending
# token to another client would let them confirm an address they do not own.
call("POST", "/report/subscribe", {"email": "scoped@example.com", "clientId": "u" * 32})
tok_a = FAKE_DDB.rows["scoped@example.com"]["confirmToken"]["S"]
call("POST", "/report/subscribe", {"email": "scoped@example.com", "clientId": "v" * 32})
tok_b = FAKE_DDB.rows["scoped@example.com"]["confirmToken"]["S"]
check("a second installation gets a fresh token", tok_a == tok_b, False)

print("\n--- still unconfirmed: a report must not go out ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "a" * 32, "report": GOOD_REPORT})
check("send before confirming is refused", out.get("status"), "not_confirmed")
check("no report email sent", len(FAKE_SES.sent), 0)

print("\n--- confirming the link ---")
token = FAKE_DDB.rows["owner@example.com"]["confirmToken"]["S"]
code, page = call("GET", "/report/confirm", query={"token": token, "confirm": "1"})
check("confirm returns a page", code, 200)
check_true("page says confirmed", "confirmed" in str(page).lower())
check("row is now verified", FAKE_DDB.rows["owner@example.com"]["verified"]["BOOL"], True)
code, page = call("GET", "/report/confirm", query={"token": "not-a-real-token", "confirm": "1"})
check_true("a bogus token is rejected", "not valid" in str(page).lower())

print("\n--- the client secret gates sending ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "WRONG-secret-value-padding", "report": GOOD_REPORT})
check("wrong clientId cannot send", out.get("status"), "not_confirmed")
check("and no email went out", len(FAKE_SES.sent), 0)

print("\n--- a confirmed address receives its report ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "a" * 32, "report": GOOD_REPORT})
check("report sent", (code, out.get("status")), (200, "sent"))
check("one email", len(FAKE_SES.sent), 1)
body_html = FAKE_SES.sent[0]["Content"]["Simple"]["Body"]["Html"]["Data"]
check_true("report lists the domain", "github.com" in body_html)
check_true("duration rendered, not raw seconds", "10m" in body_html)
check_true("unsubscribe link present", "/report/unsubscribe?token=" in body_html)

print("\n--- the same window cannot be sent twice ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "a" * 32, "report": GOOD_REPORT})
check("second attempt is a duplicate", out.get("status"), "duplicate")
check("no second email", len(FAKE_SES.sent), 0)

print("\n--- the report body cannot carry markup or unknown labels ---")
FAKE_SES.sent.clear()
hostile = dict(GOOD_REPORT)
hostile["windowId"] = "daily:data_2026_11_09"
hostile["domains"] = [
    {"hostname": "<img src=x onerror=alert(1)>", "seconds": 60, "category": "Technology"},
    {"hostname": "evil.example", "seconds": 30,
     "category": "<script>alert(1)</script>"},
    {"hostname": "neg.example", "seconds": -500, "category": "Technology"},
]
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "a" * 32, "report": hostile})
check("hostile payload still sends (as text)", out.get("status"), "sent")
h = FAKE_SES.sent[0]["Content"]["Simple"]["Body"]["Html"]["Data"]
check("no executable img tag survives", "<img src=x onerror" in h, False)
check("no script tag survives", "<script>" in h, False)
# Stronger than escaping it: a string that is not a hostname is not rendered.
check_true("a markup 'hostname' is not rendered at all", "img src=x" not in h)
check_true("the real hostnames beside it still are", "evil.example" in h)
check_true("unknown category folded to Other", ">Other<" in h)
check("negative seconds clamped to zero", "-500" in h, False)

print("\n--- payload validation ---")
for label, report, want_ok in [
    ("missing frequency", {k: v for k, v in GOOD_REPORT.items() if k != "frequency"}, False),
    ("bad frequency", {**GOOD_REPORT, "frequency": "hourly"}, False),
    ("windowId not matching frequency",
     {**GOOD_REPORT, "frequency": "weekly", "windowId": "daily:data_2026_11_08"}, False),
    ("malformed windowId", {**GOOD_REPORT, "windowId": "daily:yesterday"}, False),
    ("domains not a list", {**GOOD_REPORT, "domains": "github.com"}, True),
]:
    got = rpt._sanitise_report(report)
    check(f"sanitiser rejects: {label}" if not want_ok else f"sanitiser tolerates: {label}",
          got is not None, want_ok)

print("\n--- totals are recomputed, not trusted ---")
lying = {**GOOD_REPORT, "windowId": "daily:data_2026_11_10",
         "totalSeconds": 999999,
         "domains": [{"hostname": "a.example", "seconds": 60, "category": "Technology"},
                     {"hostname": "b.example", "seconds": 30, "category": "Gaming"}]}
clean = rpt._sanitise_report(lying)
check("total comes from the domains", clean["totalSeconds"], 90)
check("categories come from the domains", clean["categories"], {"Technology": 60, "Gaming": 30})

print("\n--- email address validation ---")
for addr, ok in [
    ("a@b.co", True), ("first.last+tag@sub.example.com", True),
    ("no-at-sign", False), ("two@@at.com", False), ("spaces in@example.com", False),
    ("trailing@example", False), ("", False), (None, False),
    ("x@example.com\n<script>", False),
]:
    check(f"email {addr!r}", rpt._normalise_email(addr) is not None, ok)
check("addresses are lowercased", rpt._normalise_email("  MiXeD@Example.COM "), "mixed@example.com")

print("\n--- verification emails are rate limited per address ---")
FAKE_SES.sent.clear()
for i in range(6):
    call("POST", "/report/subscribe", {"email": "target@example.com", "clientId": "b" * 32})
check(f"at most {rpt.MAX_VERIFY_EMAILS_PER_DAY} verification emails",
      len(FAKE_SES.sent), rpt.MAX_VERIFY_EMAILS_PER_DAY)

print("\n--- status requires the secret ---")
code, out = call("POST", "/report/status", {"email": "owner@example.com", "clientId": "a" * 32})
check("owner sees verified", out.get("status"), "verified")
code, out = call("POST", "/report/status", {"email": "owner@example.com", "clientId": "z" * 32})
check("a prober learns nothing", out.get("status"), "unknown")
code, out = call("POST", "/report/status", {"email": "never-seen@example.com", "clientId": "z" * 32})
check("unknown address gives the same answer", out.get("status"), "unknown")

print("\n--- unsubscribe ---")
unsub = FAKE_DDB.rows["owner@example.com"]["unsubToken"]["S"]
code, page = call("GET", "/report/unsubscribe", query={"token": unsub})
check("unsubscribe returns a page", code, 200)
# Takes two steps now: the emailed link asks, the button acts. See the prefetch
# section above for why.
code, page = call("GET", "/report/unsubscribe", query={"token": unsub, "confirm": "1"})
check("the row is deleted", "owner@example.com" in FAKE_DDB.deleted, True)
code, page = call("GET", "/report/unsubscribe",
                  query={"token": "bogus-token", "confirm": "1"})
check_true("an unknown token gives the same page", "unsubscribed" in str(page).lower())

print("\n--- a bare fetch of the confirm link must not confirm ---")
# One GET used to be enough, and mail scanners issue that GET by themselves. A
# stranger could subscribe someone else's address, let the victim's scanner
# "click", and own a confirmed subscription to a mailbox they had never seen.
call("POST", "/report/subscribe", {"email": "scan@example.com", "clientId": "s" * 32})
stok = FAKE_DDB.rows["scan@example.com"]["confirmToken"]["S"]
code, page = call("GET", "/report/confirm", query={"token": stok})
check_true("a prefetch leaves the address unconfirmed",
           FAKE_DDB.rows["scan@example.com"]["verified"]["BOOL"] is False)
check_true("and shows a button instead", "confirm=1" in str(page))
call("GET", "/report/confirm", query={"token": stok, "confirm": "1"})
check_true("pressing the button confirms",
           FAKE_DDB.rows["scan@example.com"]["verified"]["BOOL"] is True)

print("\n--- re-subscribing must not put an expiry on a confirmed address ---")
check_true("a confirmed row has no ttl", "ttl" not in FAKE_DDB.rows["scan@example.com"])
FAKE_SES.sent.clear()
code, out = call("POST", "/report/subscribe", {"email": "scan@example.com", "clientId": "s" * 32})
check("the owning install is told it is already verified", out.get("status"), "verified")
check("and no email is sent", len(FAKE_SES.sent), 0)
check_true("and no ttl appears", "ttl" not in FAKE_DDB.rows["scan@example.com"])
check_true("and no pending token is minted", "confirmToken" not in FAKE_DDB.rows["scan@example.com"])
# A different install asking for the same address: allowed to ASK, but the
# confirmed row must not start expiring, and the owner keeps working.
code, out = call("POST", "/report/subscribe", {"email": "scan@example.com", "clientId": "z" * 32})
check("a stranger gets the ordinary pending answer", (code, out.get("status")), (202, "pending"))
check_true("the confirmed row still has no ttl", "ttl" not in FAKE_DDB.rows["scan@example.com"])
check_true("the takeover email says what it is",
           "different browser" in FAKE_SES.sent[-1]["Content"]["Simple"]["Body"]["Text"]["Data"])
code, out = call("POST", "/report/status", {"email": "scan@example.com", "clientId": "s" * 32})
check("the owner is still verified", out.get("status"), "verified")
code, out = call("POST", "/report/status", {"email": "scan@example.com", "clientId": "z" * 32})
check("the asker is only pending", out.get("status"), "pending")

print("\n--- /status must not reveal who subscribes ---")
# A confirmed row has no pendingClientId, and compare_digest("", "") is True,
# so simply omitting clientId used to return "verified" for any subscriber.
unknown = call("POST", "/report/status", {"email": "nobody@example.com"})
for label, body in [
    ("no clientId", {"email": "scan@example.com"}),
    ("empty clientId", {"email": "scan@example.com", "clientId": ""}),
    ("non-string clientId", {"email": "scan@example.com", "clientId": 7}),
    ("non-ASCII clientId", {"email": "scan@example.com", "clientId": "é" * 20}),
]:
    check(f"{label}: same answer as an unknown address", call("POST", "/report/status", body), unknown)
rep = {"frequency": "daily", "windowId": "daily:data_2026_11_08", "domains": []}
check("send with a non-ASCII clientId: same answer as an unknown address",
      call("POST", "/report/send", {"email": "scan@example.com", "clientId": "é" * 20, "report": rep}),
      call("POST", "/report/send", {"email": "nobody@example.com", "clientId": "é" * 20, "report": rep}))

print("\n--- a report cannot carry prose ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send", {"email": "scan@example.com", "clientId": "s" * 32, "report": {
    "frequency": "daily", "windowId": "daily:data_2026_11_08",
    "startDay": "URGENT: your account is suspended", "endDay": "URGENT: your account is suspended",
    "siteCount": 60,
    "categories": {"Technology": 7200, "Totally Made Up": 99999, "Finance & Banking": 1e999},
    "domains": [
        {"hostname": "Your mailbox is locked. Sign in at https://evil.example/login", "seconds": 5, "category": "Other"},
        {"hostname": "evil.example/login", "seconds": 5, "category": "Other"},
        {"hostname": "GitHub.com", "seconds": 3600, "category": "Technology"},
        {"hostname": "[::1]", "seconds": 60, "category": "Technology"},
        {"hostname": "xn--bcher-kva.example", "seconds": 1e999, "category": "Education"},
    ]}})
check("the report still sends", out.get("status"), "sent")
mail = FAKE_SES.sent[-1]["Content"]["Simple"]
text = mail["Body"]["Text"]["Data"]
check("the subject is built from the window, not the payload",
      mail["Subject"]["Data"], "SecureView Daily Report — 8 Nov 2026")
check_true("free text is not rendered", "locked" not in text and "evil.example" not in text)
check_true("real hostnames are, lowercased", "github.com (Technology)" in text and "[::1]" in text)
check_true("an unknown category is dropped", "Totally Made Up" not in text)
check_true("the client's category total is used", "Technology: 2h" in text)
check_true("the site count covers sites not listed", "across 60 sites" in text and "and 57 more sites" in text)

print("\n--- the report email: branding, links, and nothing unescaped ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send", {"email": "scan@example.com", "clientId": "s" * 32, "report": {
    "frequency": "weekly", "windowId": "weekly:data_2026_11_02",
    "startDay": "data_2026_11_02", "endDay": "data_2026_11_08",
    "daysCovered": 7, "daysPresent": 5, "siteCount": 3,
    "categories": {"Technology": 5400, "Finance": 1800},
    "domains": [
        {"hostname": "github.com", "seconds": 5400, "category": "Technology"},
        {"hostname": "commbank.com.au", "seconds": 1800, "category": "Finance"},
    ]}})
check("the weekly report sends", out.get("status"), "sent")
mail = FAKE_SES.sent[-1]["Content"]["Simple"]
h, t = mail["Body"]["Html"]["Data"], mail["Body"]["Text"]["Data"]
site = "https://secureview.example.com"
check_true("the logo is an image from our own site, linked to it",
           f'<img src="{site}/images/email-logo.png"' in h and f'<a href="{site}"' in h)
check_true("the logo has alt text for clients that block images", 'alt="SecureView"' in h)
check_true("no image or link points at a third-party host other than the store",
           all(u.startswith((site, "https://chromewebstore.google.com/"))
               for u in re.findall(r'(?:src|href)="([^"]+)"', h)))
check_true("install link goes to the public store listing",
           "https://chromewebstore.google.com/detail/ojhmodiiehcingcnhlglenenoemmegim" in h)
check_true("privacy policy is linked", f'href="{site}/privacy.html"' in h)
check_true("unsubscribe is still there", "/report/unsubscribe?token=" in h)
check_true("copyright line with the current year",
           f"&copy; {time.strftime('%Y', time.gmtime())} SecureView. All rights reserved." in h)
check_true("the text part carries install, privacy and copyright too",
           "Install SecureView: https://chromewebstore" in t and f"Privacy Policy: {site}/privacy.html" in t
           and "SecureView. All rights reserved." in t)
# The extension's own rules say "Finance"; it used to be folded into "Other".
check_true("a bank matched by the built-in rules keeps its category",
           "commbank.com.au (Finance)" in t and "Other" not in t)
check_true("shares are shown", "75%" in h and "25%" in h)
check_true("the two missing days are called out", "2 of the 7 days" in h)
check_true("styling is inline — no <style> block or script for a client to strip",
           "<style" not in h and "<script" not in h)

print("\n--- verification mail is capped across all addresses ---")
rpt.MAX_VERIFY_EMAILS_GLOBAL_PER_DAY = 2
FAKE_DDB.rows.pop(rpt.GLOBAL_COUNTER_KEY, None)
FAKE_SES.sent.clear()
for i in range(5):
    code, out = call("POST", "/report/subscribe", {"email": f"flood{i}@example.com", "clientId": "f" * 32})
check("only the capped number are mailed", len(FAKE_SES.sent), 2)
check("and the caller cannot tell", (code, out.get("status")), (202, "pending"))
rpt.MAX_VERIFY_EMAILS_GLOBAL_PER_DAY = 300
FAKE_DDB.rows.pop(rpt.GLOBAL_COUNTER_KEY, None)

print("\n--- POST routes require application/json (the no-cors defence) ---")
FAKE_SES.sent.clear()
for ct, want in [
    ("application/json", 202),
    ("application/json; charset=utf-8", 202),
    ("text/plain", 415),
    ("application/x-www-form-urlencoded", 415),
    ("multipart/form-data", 415),
    (None, 415),
]:
    code, _ = call("POST", "/report/subscribe",
                   {"email": "ct@example.com", "clientId": "d" * 32}, content_type=ct)
    check(f"content-type {ct!r} -> {want}", code, want)
check("only the two application/json attempts produced mail",
      sum(1 for d in FAKE_SES.sent
          if d["Destination"]["ToAddresses"] == ["ct@example.com"]), 2)
# GET links must still work without a content type.
code, page = call("GET", "/report/confirm", query={"token": "nope"}, content_type=None)
check("GET confirm is not blocked by the gate", code, 200)

print("\n--- unknown routes ---")
check("unknown path 404s", call("POST", "/report/whatever", {})[0], 404)
check("wrong method 404s", call("GET", "/report/send")[0], 404)
check("malformed JSON is a 400", rpt.lambda_handler(
    {"httpMethod": "POST", "path": "/report/subscribe",
     "headers": {"Content-Type": "application/json"}, "body": "{not json"}, ctx())["statusCode"], 400)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S)")
    for f in FAILURES:
        print(f"  {f}")
    sys.exit(1)
print("ALL TESTS PASS")
