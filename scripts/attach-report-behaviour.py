#!/usr/bin/env python3
"""Attach the report Function URL to a CloudFront distribution as /report/*.

    attach-report-behaviour.py <distribution-id> <function-url> <oac-id>

Idempotent: if the origin and behaviour already point where they should, it
reports no change and makes no API call.

WHY THIS IS A SCRIPT AND NOT CLOUDFORMATION. These distributions are not
CloudFormation-managed — they predate the templates and also front the
marketing site. Adopting one into a stack means describing every behaviour and
origin exactly, and a single omission is silently destructive on the next
update. Editing the live config in place, one behaviour at a time, is the
smaller risk.

It reads the current config, changes only what it must, and prints the diff
before applying. Everything else is written back byte-identical.
"""
import json
import subprocess
import sys

# Managed policies, by id so there is nothing to look up at runtime.
CACHE_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

PATH_PATTERN = "/report/*"
ORIGIN_ID = "secureview-report-origin"


def aws(*args):
    out = subprocess.run(["aws", *args], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"aws {' '.join(args)}\n{out.stderr.strip()}")
    return out.stdout


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    dist_id, fn_url, oac_id = sys.argv[1], sys.argv[2], sys.argv[3]
    domain = fn_url.replace("https://", "").rstrip("/")

    raw = json.loads(aws("cloudfront", "get-distribution-config", "--id", dist_id))
    etag = raw["ETag"]
    cfg = raw["DistributionConfig"]
    before = json.dumps(cfg, sort_keys=True)

    # ── origin ──
    origins = cfg.setdefault("Origins", {"Quantity": 0, "Items": []})
    items = origins.setdefault("Items", [])
    origin = next((o for o in items if o["Id"] == ORIGIN_ID), None)
    desired_origin = {
        "Id": ORIGIN_ID,
        "DomainName": domain,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            # Lambda function URLs require TLS 1.2. Offering only older
            # protocols makes the handshake fail as a 502 with nothing in the
            # function's logs to explain it.
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 30,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
        "OriginAccessControlId": oac_id,
    }
    if origin is None:
        items.append(desired_origin)
        print(f"  + origin {ORIGIN_ID} -> {domain}")
    else:
        for field in ("DomainName", "OriginAccessControlId"):
            if origin.get(field) != desired_origin[field]:
                print(f"  ~ origin {field}: {origin.get(field)} -> {desired_origin[field]}")
                origin[field] = desired_origin[field]
        co = origin.setdefault("CustomOriginConfig", desired_origin["CustomOriginConfig"])
        if co.get("OriginSslProtocols", {}).get("Items") != ["TLSv1.2"]:
            print(f"  ~ origin SslProtocols: {co.get('OriginSslProtocols', {}).get('Items')} -> ['TLSv1.2']")
            co["OriginSslProtocols"] = {"Quantity": 1, "Items": ["TLSv1.2"]}
    origins["Quantity"] = len(items)

    # ── behaviour ──
    behaviours = cfg.setdefault("CacheBehaviors", {"Quantity": 0, "Items": []})
    bitems = behaviours.setdefault("Items", [])
    desired_behaviour = {
        "PathPattern": PATH_PATTERN,
        "TargetOriginId": ORIGIN_ID,
        "ViewerProtocolPolicy": "https-only",
        # POST for subscribe/status/send, GET for the confirm and unsubscribe
        # links people click in their mail.
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"],
            "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]},
        },
        "Compress": False,
        "CachePolicyId": CACHE_DISABLED,
        "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
        "SmoothStreaming": False,
        "FieldLevelEncryptionId": "",
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "LambdaFunctionAssociations": {"Quantity": 0},
        # No CloudFront function. The /categorize guard demands POST with
        # application/json, which would reject the browser GETs that confirm a
        # subscription. The equivalent check lives in the Lambda, applied to the
        # POST routes only.
        "FunctionAssociations": {"Quantity": 0},
    }
    existing = next((b for b in bitems if b.get("PathPattern") == PATH_PATTERN), None)
    if existing is None:
        # Ahead of any catch-all, or "*" would swallow it.
        bitems.insert(0, desired_behaviour)
        print(f"  + behaviour {PATH_PATTERN} -> {ORIGIN_ID}")
    else:
        for field in ("TargetOriginId", "CachePolicyId", "OriginRequestPolicyId"):
            if existing.get(field) != desired_behaviour[field]:
                print(f"  ~ behaviour {field}: {existing.get(field)} -> {desired_behaviour[field]}")
                existing[field] = desired_behaviour[field]
    behaviours["Quantity"] = len(bitems)

    if json.dumps(cfg, sort_keys=True) == before:
        print("  no change — already wired")
        return

    with open("/tmp/secureview-report-cf.json", "w") as fh:
        json.dump(cfg, fh)
    aws("cloudfront", "update-distribution", "--id", dist_id,
        "--if-match", etag,
        "--distribution-config", "file:///tmp/secureview-report-cf.json")
    print("  applied — waiting for the distribution to deploy")
    aws("cloudfront", "wait", "distribution-deployed", "--id", dist_id)
    print("  deployed")


if __name__ == "__main__":
    main()
