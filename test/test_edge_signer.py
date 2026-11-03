#!/usr/bin/env python3
"""Unit tests for the Lambda@Edge SigV4 signer.

This function is the most consequential piece of the pipeline: it is what makes
/categorize work at all, in production, and it is versioned Lambda@Edge whose
association propagates on CloudFront's schedule — a bad deploy is slow to
notice and slow to undo. It had no tests before reports needed it to sign a
second kind of request.

Every case below EXECUTES the handler rather than inspecting it. Writing these
immediately caught a NameError on the classifier path: content_type was being
assigned only on the report branch, so the one route that already worked in
production would have raised on the first request. A syntax check and pyflakes
both passed it.

Usage:  python3 test/test_edge_signer.py
"""
import base64
import importlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILURES = []


def check(name, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'} {name}")
    if not ok:
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")


def check_true(name, value):
    check(name, bool(value), True)


# Lambda@Edge reads credentials from the execution environment.
os.environ.setdefault("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
os.environ.pop("AWS_SESSION_TOKEN", None)

sys.path.insert(0, os.path.join(ROOT, "backend", "lambda"))
edge = importlib.import_module("lambda_function")

API_HOST = "abc123.execute-api.ap-southeast-2.amazonaws.com"


def event(uri, method="POST", body=None, encoding="text", querystring="",
          origin_path="/live", truncated=False, content_type="application/json"):
    headers = {"host": [{"key": "Host", "value": "dev.secureview.websaleem.com"}]}
    if content_type:
        headers["content-type"] = [{"key": "Content-Type", "value": content_type}]
    req = {
        "method": method,
        "uri": uri,
        "querystring": querystring,
        "headers": headers,
        "origin": {"custom": {"domainName": API_HOST, "path": origin_path}},
    }
    if body is not None:
        data = base64.b64encode(body.encode()).decode() if encoding == "base64" else body
        req["body"] = {"data": data, "encoding": encoding}
        if truncated:
            req["body"]["inputTruncated"] = True
    return {"Records": [{"cf": {"request": req}}]}


def run(*a, **kw):
    return edge.lambda_handler(event(*a, **kw), None)


def is_error(resp):
    return "status" in resp


def auth_of(resp):
    return resp["headers"]["authorization"][0]["value"]


# ── routing ─────────────────────────────────────────────────────────────────
print("--- routing: path and method together ---")
check("unknown path -> 404", run("/nonsense")["status"], "404")
check("GET /categorize -> 405 (path exists, method does not)",
      run("/categorize", method="GET", body=None)["status"], "405")
check("POST /report/confirm -> 405", run("/report/confirm")["status"], "405")
check("GET /report/subscribe -> 405",
      run("/report/subscribe", method="GET", body=None)["status"], "405")
check("OPTIONS is not a route", run("/categorize", method="OPTIONS")["status"], "405")
# A prefix match would have let these through; the allowlist is explicit.
for path in ("/report", "/report/", "/report/anything", "/report/send/extra", "/categorize/x"):
    check(f"not signed: {path}", run(path)["status"], "404")

# ── classifier: unchanged behaviour ─────────────────────────────────────────
print("\n--- classifier (must behave exactly as before) ---")
resp = run("/categorize", body=json.dumps({"hostname": "github.com", "title": "GitHub"}))
check_true("signed, not an error", not is_error(resp))
check_true("Authorization header added", auth_of(resp).startswith("AWS4-HMAC-SHA256"))
check("Host set to the API", resp["headers"]["host"][0]["value"], API_HOST)
check_true("Content-Type kept", resp["headers"]["content-type"][0]["value"] == "application/json")
check("body replaced so forwarded bytes are the signed bytes",
      resp["body"]["action"], "replace")
check("body is the re-serialised JSON",
      json.loads(resp["body"]["data"]), {"hostname": "github.com", "title": "GitHub"})
check("missing hostname still refused",
      run("/categorize", body=json.dumps({"title": "x"}))["status"], "400")
check("non-JSON body still refused", run("/categorize", body="{not json")["status"], "400")
check("non-object body still refused", run("/categorize", body="[1,2,3]")["status"], "400")
check("base64 bodies still decoded",
      json.loads(run("/categorize", body=json.dumps({"hostname": "a.com"}),
                     encoding="base64")["body"]["data"])["hostname"], "a.com")

# ── report POST ─────────────────────────────────────────────────────────────
print("\n--- report POST: body passes through untouched ---")
payload = json.dumps({"email": "a@b.co", "clientId": "x" * 32,
                      "report": {"frequency": "daily", "domains": []}})
resp = run("/report/send", body=payload)
check_true("signed", not is_error(resp))
check("body forwarded verbatim, not re-serialised", resp["body"]["data"], payload)
check("still replaced, so signed bytes are forwarded bytes", resp["body"]["action"], "replace")
check_true("Authorization present", auth_of(resp).startswith("AWS4-HMAC-SHA256"))
# No hostname in a report payload — the classifier's rule must not apply here.
check_true("no hostname required", not is_error(run("/report/subscribe", body=payload)))
check("an empty report body is refused", run("/report/send", body="")["status"], "400")
check("a missing report body is refused", run("/report/send", body=None)["status"], "400")

# ── report GET ──────────────────────────────────────────────────────────────
print("\n--- report GET: no body, no Content-Type ---")
resp = run("/report/confirm", method="GET", body=None, querystring="token=abc123",
           content_type=None)
check_true("signed", not is_error(resp))
check_true("Authorization present", auth_of(resp).startswith("AWS4-HMAC-SHA256"))
check("no Content-Type travels with it", "content-type" in resp["headers"], False)
check("no body replacement for a GET", "action" in (resp.get("body") or {}), False)
check_true("SignedHeaders excludes content-type",
           "content-type" not in auth_of(resp).split("SignedHeaders=")[1].split(",")[0]
           and "content-type" not in auth_of(resp).split("SignedHeaders=")[1].split("Signature")[0])
# A browser may send a Content-Type on a GET; it must not be signed or forwarded.
resp2 = run("/report/unsubscribe", method="GET", body=None, content_type="text/html")
check("a viewer-supplied Content-Type on a GET is dropped",
      "content-type" in resp2["headers"], False)

# ── signing covers the stage-prefixed path ──────────────────────────────────
print("\n--- the signature must cover the origin path prefix ---")
a = auth_of(run("/categorize", body=json.dumps({"hostname": "a.com"}), origin_path="/live"))
b = auth_of(run("/categorize", body=json.dumps({"hostname": "a.com"}), origin_path="/prod"))
check("a different stage produces a different signature", a == b, False)
c = auth_of(run("/report/confirm", method="GET", body=None,
                querystring="token=1", content_type=None))
d = auth_of(run("/report/confirm", method="GET", body=None,
                querystring="token=2", content_type=None))
check("a different querystring produces a different signature", c == d, False)

# ── truncation ──────────────────────────────────────────────────────────────
print("\n--- a truncated body must never be signed ---")
check("truncated classifier body -> 413",
      run("/categorize", body=json.dumps({"hostname": "a.com"}), truncated=True)["status"], "413")
check("truncated report body -> 413",
      run("/report/send", body=payload, truncated=True)["status"], "413")

# ── origin sanity ───────────────────────────────────────────────────────────
print("\n--- malformed events ---")
ev = event("/categorize", body=json.dumps({"hostname": "a.com"}))
ev["Records"][0]["cf"]["request"]["origin"] = {"custom": {}}
check("missing origin domain -> 502", edge.lambda_handler(ev, None)["status"], "502")

print("\n--- route_kind is total ---")
for uri, method, want in [
    ("/categorize", "POST", "categorize"),
    ("/categorize", "GET", None),
    ("/report/subscribe", "POST", "report_post"),
    ("/report/status", "POST", "report_post"),
    ("/report/send", "POST", "report_post"),
    ("/report/confirm", "GET", "report_get"),
    ("/report/unsubscribe", "GET", "report_get"),
    ("/report/confirm", "POST", None),
    ("/", "GET", None),
    ("", "POST", None),
]:
    check(f"route_kind({uri!r}, {method!r})", edge.route_kind(uri, method), want)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S)")
    for f in FAILURES:
        print(f"  {f}")
    sys.exit(1)
print("ALL TESTS PASS")
