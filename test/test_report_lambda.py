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
        if "lastSentDaily" in (UpdateExpression or ""):
            row["lastSentDaily"] = vals[":w"]
        if "lastSentWeekly" in (UpdateExpression or ""):
            row["lastSentWeekly"] = vals[":w"]
        if "clientId = :cid" in (UpdateExpression or ""):
            row["clientId"] = vals[":cid"]
        return {}

    def scan(self, TableName=None, FilterExpression=None,
             ExpressionAttributeValues=None, ExclusiveStartKey=None):
        token = ExpressionAttributeValues[":t"]["S"]
        field = "confirmToken" if "confirmToken" in FilterExpression else "unsubToken"
        items = [r for r in self.rows.values() if r.get(field, {}).get("S") == token]
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

print("\n--- still unconfirmed: a report must not go out ---")
FAKE_SES.sent.clear()
code, out = call("POST", "/report/send",
                 {"email": "owner@example.com", "clientId": "a" * 32, "report": GOOD_REPORT})
check("send before confirming is refused", out.get("status"), "not_confirmed")
check("no report email sent", len(FAKE_SES.sent), 0)

print("\n--- confirming the link ---")
token = FAKE_DDB.rows["owner@example.com"]["confirmToken"]["S"]
code, page = call("GET", "/report/confirm", query={"token": token})
check("confirm returns a page", code, 200)
check_true("page says confirmed", "confirmed" in str(page).lower())
check("row is now verified", FAKE_DDB.rows["owner@example.com"]["verified"]["BOOL"], True)
code, page = call("GET", "/report/confirm", query={"token": "not-a-real-token"})
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
check_true("the hostname is shown escaped", "&lt;img src=x" in h)
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
check("the row is deleted", "owner@example.com" in FAKE_DDB.deleted, True)
code, page = call("GET", "/report/unsubscribe", query={"token": "bogus-token"})
check_true("an unknown token gives the same page", "unsubscribed" in str(page).lower())

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
