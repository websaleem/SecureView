import boto3
import json
import logging
import time

log = logging.getLogger()
log.setLevel(logging.INFO)

bedrock = boto3.client(
    service_name="bedrock-runtime",
    region_name="ap-southeast-4",
)

MODEL_ID = "amazon.nova-pro-v1:0"

CATEGORIES = [
    "News & Media", "Social Media", "Shopping", "Technology", 
    "Finance & Banking", "Education", "Entertainment", 
    "Government", "Health & Fitness", "Travel", "Sports", 
    "Food & Dining", "Productivity", "Gaming", 
    "Adult Content", "Malware / Phishing", "Personal", "Other"
]

SYSTEM_PROMPT = """You are a URL categorisation engine.
Given a website hostname and page title (optional), return the single most accurate
category from the provided list. Reply with ONLY the category name —
no explanation, no punctuation, nothing else."""


def build_user_message(hostname: str, title: str) -> str:
    hostname = hostname.strip()[:200]
    title  = title.strip()[:300].encode("utf-8", errors="ignore").decode("utf-8")
    cats   = "\n".join(f"- {c}" for c in CATEGORIES)
    return f"""hostname: {hostname}
Title:  {title}

Categories:
{cats}

Category:"""


def invoke_nova(hostname: str, title: str) -> str:
    user_message = build_user_message(hostname, title)

    body = {
        "system": [{"text": SYSTEM_PROMPT}],
        "messages": [
            {
                "role": "user",
                "content": [{"text": user_message}],
            }
        ],
        "inferenceConfig": {
            "maxTokens": 20,
            "temperature": 0
        }
    }

    # ── Pre-invocation log ────────────────────────────────────────────────────
    log.info(json.dumps({
        "event":     "bedrock_invoke_start",
        "model_id":  MODEL_ID,
        "hostname":  hostname,
        "prompt": user_message,
    }))

    start_ts = time.monotonic()

    try:
        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
    except Exception as exc:
        latency_ms = int((time.monotonic() - start_ts) * 1000)
        log.error(json.dumps({
            "event":      "bedrock_invoke_error",
            "model_id":   MODEL_ID,
            "hostname":   hostname,
            "latency_ms": latency_ms,
            "error_type": type(exc).__name__,
            "error":      str(exc),
        }))
        raise

    latency_ms = int((time.monotonic() - start_ts) * 1000)

    # ── Parse response ────────────────────────────────────────────────────────
    result = json.loads(response["body"].read())
    raw    = result.get("output", {}).get("message", {}).get("content", [{"text": ""}])[0].get("text", "").strip()

    usage         = result.get("usage", {})
    input_tokens  = usage.get("inputTokens",  0)
    output_tokens = usage.get("outputTokens", 0)

    # HTTP / Bedrock request metadata
    http_meta     = response.get("ResponseMetadata", {})
    bedrock_req_id = http_meta.get("RequestId", "n/a")
    http_status    = http_meta.get("HTTPStatusCode", "n/a")

    # ── Post-invocation log ───────────────────────────────────────────────────
    log.info(json.dumps({
        "event":          "bedrock_invoke_end",
        "model_id":       MODEL_ID,
        "hostname":       hostname,
        "latency_ms":     latency_ms,
        "http_status":    http_status,
        "bedrock_req_id": bedrock_req_id,
        "input_tokens":   input_tokens,
        "output_tokens":  output_tokens,
        "total_tokens":   input_tokens + output_tokens,
        "stop_reason":    result.get("stop_reason"),
        "raw_response":   raw,
    }))

    return raw


def sanitise_category(raw: str) -> str:
    cleaned = raw.strip().rstrip(".")
    for cat in CATEGORIES:
        if cat.lower() == cleaned.lower():
            return cat
    for cat in CATEGORIES:
        if cat.lower() in cleaned.lower():
            return cat
    log.warning(json.dumps({
        "event":   "category_fallback",
        "raw":     raw,
        "cleaned": cleaned,
        "result":  "Other",
    }))
    return "Other"


def lambda_handler(event, context):
    lambda_req_id = context.aws_request_id if context else "local"

    try:
        body     = json.loads(event.get("body") or "{}")
        hostname = body.get("hostname", "").strip()
        title    = body.get("title", "").strip()

        log.info(json.dumps({
            "event":          "request_received",
            "lambda_req_id":  lambda_req_id,
            "hostname":       hostname,
            "title_preview":  title[:80],
        }))

        if not hostname:
            log.warning(json.dumps({"event": "validation_error", "reason": "missing hostname"}))
            return _resp(400, {"error": "hostname is required"})

        raw      = invoke_nova(hostname, title)
        category = sanitise_category(raw)

        log.info(json.dumps({
            "event":         "request_complete",
            "lambda_req_id": lambda_req_id,
            "hostname":      hostname,
            "category":      category,
        }))

        return _resp(200, {
            "hostname": hostname,
            "title":    title,
            "category": category,
        })

    except Exception as e:
        log.error(json.dumps({
            "event":         "unhandled_exception",
            "lambda_req_id": lambda_req_id,
            "error_type":    type(e).__name__,
            "error":         str(e),
        }))
        return _resp(500, {"error": str(e)})


def _resp(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type":                "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body),
    }