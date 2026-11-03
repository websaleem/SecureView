import os
import json
import base64
import logging

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Lambda@Edge cannot carry environment variables, so anything configurable has
# to be a constant here and redeployed with the function.
#
# An explicit allowlist of path AND method, not a prefix match. Every entry here
# is a route that exists behind API Gateway; anything else is refused before a
# signature is computed, so a typo in a behaviour cannot turn this into an open
# signing proxy for the whole API.
#
# WHY REPORTS COME THROUGH HERE. They were first built on a Lambda function URL
# with CloudFront OAC, which signs origin requests without needing this
# function. That does not work: OAC does not sign the request BODY for a Lambda
# function URL, so anything carrying one fails SigV4 at the URL's front door.
# Measured against dev — an empty-body POST reached the handler, a POST of "{}"
# came back 403 signature mismatch. This function signs the body, which is
# exactly what /categorize already depends on, so reports use it too.
CATEGORIZE_PATH = "/categorize"

# POST with a JSON body, from the extension's service worker.
REPORT_POST_PATHS = ("/report/subscribe", "/report/status", "/report/send")

# GET with no body, from a browser: the links people click in their email.
REPORT_GET_PATHS = ("/report/confirm", "/report/unsubscribe")


def route_kind(uri, method):
    """Which kind of request this is, or None if it is not allowed.

    Returned as a kind rather than a boolean because the three differ in how
    they must be signed: the classifier's body is re-serialised and validated,
    a report body is passed through untouched, and a report link has no body at
    all and must be signed over an empty payload.
    """
    if uri == CATEGORIZE_PATH:
        return "categorize" if method == "POST" else None
    if uri in REPORT_POST_PATHS:
        return "report_post" if method == "POST" else None
    if uri in REPORT_GET_PATHS:
        return "report_get" if method == "GET" else None
    return None


def error_response(status, message):
    return {
        "status": status,
        "statusDescription": message,
        "headers": {
            "content-type": [{"key": "Content-Type", "value": "application/json"}],
            "cache-control": [{"key": "Cache-Control", "value": "no-store"}],
        },
        "body": json.dumps({"error": message}),
    }


def lambda_handler(event, context):
    cf_request = event["Records"][0]["cf"]["request"]
    method = cf_request["method"]
    querystring = cf_request.get("querystring", "")
    uri = cf_request["uri"]

    # No CORS preflight handler, and no Access-Control-Allow-Origin anywhere.
    #
    # The extension calls this from an MV3 service worker holding
    # host_permissions for the host, which is not subject to CORS. Answering
    # preflights with "*" only ever served web pages — letting any site invoke
    # the classifier through its visitors' browsers, which also sidesteps the
    # WAF's per-IP rate limit. OPTIONS now falls through to the 405 below.

    kind = route_kind(uri, method)
    if kind is None:
        # 404 for a path nobody serves, 405 when the path exists but not with
        # this method — a GET to /categorize is a different mistake from a GET
        # to /nonsense, and saying so costs nothing.
        known = (uri == CATEGORIZE_PATH or uri in REPORT_POST_PATHS or uri in REPORT_GET_PATHS)
        if known:
            return error_response("405", "Method Not Allowed")
        logger.warning("Rejected request for unknown path")
        return error_response("404", "Not Found")

    origin_custom = cf_request.get("origin", {}).get("custom", {})
    api_host = origin_custom.get("domainName", "")
    if not api_host:
        logger.error("Origin domainName missing from the CloudFront event")
        return error_response("502", "Bad Gateway")

    api_region = api_host.split(".")[2] if ".execute-api." in api_host else "ap-southeast-2"

    # CloudFront prepends the origin's OriginPath (e.g. "/live", the API Gateway
    # stage) to cf_request["uri"] when it forwards to the origin — but it does so
    # AFTER this function returns. So the SigV4 signature has to cover the
    # stage-prefixed path while cf_request["uri"] stays un-prefixed.
    #
    # Getting this wrong is silent: the request reaches API Gateway with a
    # signature computed over a different path and comes back 403. Reading the
    # prefix off the event rather than hardcoding it also means the stage name
    # can change in the template without this function drifting out of sync —
    # the previous hardcoded "/prod" did not match the "live" stage at all.
    origin_path = origin_custom.get("path", "") or ""
    signed_path = f"{origin_path}{uri}"

    # ── Body ───────────────────────────────────────────────────────────────
    # Whatever is signed must be byte-identical to what CloudFront forwards, so
    # every path with a body replaces it explicitly rather than relying on the
    # original bytes surviving unchanged.
    body_obj = cf_request.get("body") or {}
    raw = body_obj.get("data", "")
    body = (
        base64.b64decode(raw).decode("utf-8")
        if raw and body_obj.get("encoding") == "base64"
        else (raw or "")
    )

    # Lambda@Edge hands over at most 1 MB of body and flags the rest as
    # truncated. Signing a truncated body produces a signature over bytes the
    # origin will never see, which arrives as an unexplainable 403 — so refuse
    # it with something that names the cause instead.
    if body_obj.get("inputTruncated"):
        logger.error("Request body was truncated by Lambda@Edge; refusing to sign")
        return error_response("413", "Payload Too Large")

    if kind == "report_get":
        # No body, and no Content-Type: the signature must cover exactly the
        # headers sent, and inventing one here would break it.
        clean_body = ""
        content_type = None
    elif kind == "categorize":
        # Deliberately no logging of the body, hostname, or title: these are the
        # user's browsing history, and CloudWatch is not where it belongs.
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            logger.error("Request body is not valid JSON")
            return error_response("400", "Bad Request - invalid body")

        if not isinstance(parsed, dict):
            return error_response("400", "Bad Request - invalid body")

        hostname = parsed.get("hostname")
        if not hostname or not isinstance(hostname, str):
            logger.warning("Request rejected: missing hostname")
            return error_response("400", "Bad Request - hostname is required")

        clean_body = json.dumps(parsed)
    else:
        # report_post. The body passes through untouched: its shape is the
        # report Lambda's business, and re-serialising it here would mean this
        # function had to know and preserve that schema. It is still replaced,
        # so the forwarded bytes are the bytes that were signed.
        if not body:
            return error_response("400", "Bad Request - body is required")
        clean_body = body

    if clean_body:
        cf_request["body"] = {"action": "replace", "encoding": "text", "data": clean_body}

    # Resolved once, after the per-kind branches above. The report_get branch
    # has already set this to None and must keep it: a GET is signed over no
    # Content-Type at all, and supplying one would invalidate the signature.
    if kind != "report_get":
        ct_headers = cf_request.get("headers", {}).get("content-type", [])
        content_type = ct_headers[0]["value"] if ct_headers else "application/json"

    credentials = Credentials(
        access_key=os.environ["AWS_ACCESS_KEY_ID"],
        secret_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        token=os.environ.get("AWS_SESSION_TOKEN"),
    )

    url = f"https://{api_host}{signed_path}"
    if querystring:
        url = f"{url}?{querystring}"

    sign_headers = {"Host": api_host}
    if content_type is not None:
        sign_headers["Content-Type"] = content_type

    aws_request = AWSRequest(
        method=method,
        url=url,
        data=clean_body.encode("utf-8"),
        headers=sign_headers,
    )

    SigV4Auth(credentials, "execute-api", api_region).add_auth(aws_request)
    signed = dict(aws_request.headers)

    cf_request["headers"]["authorization"] = [{"key": "Authorization", "value": signed["Authorization"]}]
    cf_request["headers"]["x-amz-date"] = [{"key": "X-Amz-Date", "value": signed["X-Amz-Date"]}]
    if "X-Amz-Security-Token" in signed:
        cf_request["headers"]["x-amz-security-token"] = [
            {"key": "X-Amz-Security-Token", "value": signed["X-Amz-Security-Token"]}
        ]

    cf_request["headers"]["host"] = [{"key": "Host", "value": api_host}]
    if content_type is not None:
        cf_request["headers"]["content-type"] = [{"key": "Content-Type", "value": content_type}]
    else:
        # A signature computed without Content-Type must not travel with one.
        cf_request["headers"].pop("content-type", None)

    logger.info("Forwarding signed request to %s (region %s)", signed_path, api_region)

    return cf_request
