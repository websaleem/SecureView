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
# /report was removed along with the Cognito login flow; /categorize is the only
# path this distribution serves.
KNOWN_API_PATHS = ("/categorize",)


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

    # ── Handle OPTIONS preflight ───────────────────────────────────────────
    if method == "OPTIONS":
        return {
            "status": "204",
            "statusDescription": "No Content",
            "headers": {
                "access-control-allow-origin": [{"key": "Access-Control-Allow-Origin", "value": "*"}],
                "access-control-allow-methods": [{"key": "Access-Control-Allow-Methods", "value": "OPTIONS, POST"}],
                "access-control-allow-headers": [{"key": "Access-Control-Allow-Headers", "value": "Content-Type"}],
            },
        }

    if uri not in KNOWN_API_PATHS:
        logger.warning("Rejected request for unknown path")
        return error_response("404", "Not Found")

    if method != "POST":
        return error_response("405", "Method Not Allowed")

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

    # ── Body decoding ──────────────────────────────────────────────────────
    body_obj = cf_request.get("body") or {}
    raw = body_obj.get("data", "")
    body = (
        base64.b64decode(raw).decode("utf-8")
        if raw and body_obj.get("encoding") == "base64"
        else (raw or "")
    )

    # ── Parse and validate ─────────────────────────────────────────────────
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
    cf_request["body"] = {"action": "replace", "encoding": "text", "data": clean_body}

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

    aws_request = AWSRequest(
        method=method,
        url=url,
        data=clean_body.encode("utf-8"),
        headers={
            "Host": api_host,
            "Content-Type": content_type,
        },
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
    cf_request["headers"]["content-type"] = [{"key": "Content-Type", "value": content_type}]

    logger.info("Forwarding signed request to %s (region %s)", signed_path, api_region)

    return cf_request
