import os
import json
import base64
import logging

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

logger = logging.getLogger()
logger.setLevel(logging.INFO)

API_REGION   = "ap-southeast-4"
API_HOST     = "your-api-id.execute-api.ap-southeast-4.amazonaws.com"

# Error response structure
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
    cf_request  = event["Records"][0]["cf"]["request"]
    method      = cf_request["method"]
    querystring = cf_request.get("querystring", "")

    # ── Map environment to URI prefix ──────────────────────────────────────
    uri = cf_request['uri']
    
    # Backward compatibility: map root requests to the prod stage
    if uri == "/categorize":
        uri = "/prod/categorize"
        
    cf_request["uri"] = uri

    # ── Body decoding ──────────────────────────────────────────────────────
    body_obj = cf_request.get("body") or {}
    raw      = body_obj.get("data", "")
    body     = base64.b64decode(raw).decode("utf-8") \
               if raw and body_obj.get("encoding") == "base64" \
               else (raw or "")

    # ── Log 1: raw body before parsing ────────────────────────────────────
    logger.info("[2] Secureview Raw body received: %s", repr(body))

    # ── Parse and validate hostname + title ───────────────────────────────
    try:
        parsed = json.loads(body) if body else {}
    except json.JSONDecodeError as e:
        logger.error("[3] Body is not valid JSON: %s | body was: %s", e, repr(body))
        parsed = {}
        return error_response("403", "Forbidden - invalid body")

    hostname = parsed.get("hostname")
    title    = parsed.get("title")

    # ── Log 2: extracted fields ────────────────────────────────────────────
    logger.info("[3] hostname=%s | title=%s", repr(hostname), repr(title))

    if not hostname:
        logger.error("[!] hostname is EMPTY — check the caller payload")
        return error_response("403", "Forbidden - empty hostname")
    if not title:
        logger.warning("[!] title is EMPTY — check the caller payload")

    clean_body = json.dumps(parsed)

    cf_request["body"] = {"action": "replace", "encoding": "text", "data": clean_body}

    # ── Extract Content-Type ───────────────────────────────────────────────
    ct_headers   = cf_request.get("headers", {}).get("content-type", [])
    content_type = ct_headers[0]["value"] if ct_headers else "application/json"

    # ── Log 3: content-type being used ────────────────────────────────────
    logger.info("[4] Content-Type: %s", content_type)

    credentials = Credentials(
        access_key=os.environ["AWS_ACCESS_KEY_ID"],
        secret_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        token=os.environ.get("AWS_SESSION_TOKEN"),
    )

    url = f"https://{API_HOST}{uri}"
    if querystring:
        url = f"{url}?{querystring}"

    aws_request = AWSRequest(
        method=method,
        url=url,
        data=clean_body.encode("utf-8"),
        headers={
            "Host": API_HOST,
            "Content-Type": content_type,
        },
    )

    SigV4Auth(credentials, "execute-api", API_REGION).add_auth(aws_request)
    signed = dict(aws_request.headers)

    cf_request["headers"]["authorization"] = [{
        "key": "Authorization", "value": signed["Authorization"],
    }]
    cf_request["headers"]["x-amz-date"] = [{
        "key": "X-Amz-Date", "value": signed["X-Amz-Date"],
    }]
    if "X-Amz-Security-Token" in signed:
        cf_request["headers"]["x-amz-security-token"] = [{
            "key": "X-Amz-Security-Token",
            "value": signed["X-Amz-Security-Token"],
        }]

    cf_request["headers"]["host"]         = [{"key": "Host","value": API_HOST}]
    cf_request["headers"]["content-type"] = [{"key": "Content-Type", "value": content_type}]

    # ── Log 4: confirm request is being forwarded ──────────────────────────
    logger.info("[5] Forwarding to %s | uri=%s | method=%s | hostname=%s | title=%s",
                url, cf_request["uri"], method, repr(hostname), repr(title))

    return cf_request