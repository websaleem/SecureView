#!/usr/bin/env python3
"""Wire an EXISTING CloudFront distribution to the SecureView categorize API.

Used when a distribution already holds the alias and certificate we want to keep
— prod's `secureview.websaleem.com` — so recreating it under CloudFormation
would mean a DNS cutover and an apex certificate the wildcard does not cover.
The edge signer, its version and the WAF still come from
secureview-edge-cdn-<env> with ManageDistribution=false; only the distribution
itself is patched here.

The change is additive. The `*` -> S3 behaviour that serves the site is left
exactly as it is, so the site keeps serving throughout.

  1. Adds (or updates) an API origin pointing at API Gateway, with
     OriginPath=/<stage> — CloudFront prepends this after Lambda@Edge runs, so
     the signer signs the same path API Gateway will see.
  2. Inserts a /categorize behaviour BEFORE the `*` catch-all. CloudFront takes
     the first matching pattern, and a `*` allowing only GET/HEAD is what has
     been 403-ing every POST.
  3. Attaches the edge version with IncludeBody=true, without which the signer
     receives no body.
  4. Optionally attaches a WAF WebACL (--web-acl-arn). Left alone by default:
     prod already has a CloudFront-managed ACL and silently swapping it could
     drop protections that are not ours to remove.

Dry run unless --apply is passed.
"""

import argparse
import sys

import boto3

API_PATH = "/categorize"
CATCH_ALL = "*"
API_ORIGIN_ID = "SecureViewApiOrigin"
ALL_METHODS = ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"]
CACHED_METHODS = ["HEAD", "GET"]
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"


def upsert_api_origin(config, api_domain, stage):
    origin_path = f"/{stage.strip('/')}"
    desired = {
        "Id": API_ORIGIN_ID,
        "DomainName": api_domain,
        "OriginPath": origin_path,
        "CustomHeaders": {"Quantity": 0},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 30,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
    }
    items = config["Origins"]["Items"]
    existing = next((o for o in items if o["Id"] == API_ORIGIN_ID), None)
    if existing is None:
        items.append(desired)
        config["Origins"]["Quantity"] = len(items)
        return [f"add origin {API_ORIGIN_ID} -> {api_domain} (OriginPath {origin_path})"]
    if existing != desired:
        items[items.index(existing)] = desired
        return [f"update origin {API_ORIGIN_ID} -> {api_domain} (OriginPath {origin_path})"]
    return []


def upsert_api_behaviour(config, edge_version_arn):
    desired = {
        "PathPattern": API_PATH,
        "TargetOriginId": API_ORIGIN_ID,
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
            "Quantity": len(ALL_METHODS),
            "Items": list(ALL_METHODS),
            "CachedMethods": {"Quantity": len(CACHED_METHODS), "Items": list(CACHED_METHODS)},
        },
        "SmoothStreaming": False,
        "Compress": False,
        "LambdaFunctionAssociations": {
            "Quantity": 1,
            "Items": [
                {
                    "LambdaFunctionARN": edge_version_arn,
                    "EventType": "origin-request",
                    "IncludeBody": True,
                }
            ],
        },
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "CachePolicyId": CACHING_DISABLED,
        "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
    }

    behaviours = config.setdefault("CacheBehaviors", {"Quantity": 0, "Items": []})
    items = behaviours.get("Items") or []
    changes = []

    existing = next((b for b in items if b["PathPattern"] == API_PATH), None)
    if existing is None:
        insert_at = next((i for i, b in enumerate(items) if b["PathPattern"] == CATCH_ALL), len(items))
        items.insert(insert_at, desired)
        changes.append(f"insert '{API_PATH}' behaviour at index {insert_at} (before '{CATCH_ALL}')")
    else:
        idx = items.index(existing)
        if existing != desired:
            items[idx] = desired
            changes.append(f"update '{API_PATH}' behaviour (origin / edge version / IncludeBody)")
        catch_idx = next((i for i, b in enumerate(items) if b["PathPattern"] == CATCH_ALL), None)
        if catch_idx is not None and idx > catch_idx:
            items.insert(catch_idx, items.pop(idx))
            changes.append(f"move '{API_PATH}' ahead of '{CATCH_ALL}' — it was being shadowed")

    behaviours["Items"] = items
    behaviours["Quantity"] = len(items)
    return changes


def reset_default_behaviour(config):
    """Point the default behaviour at the site origin and strip Lambda@Edge.

    The default behaviour is unreachable whenever a `*` ordered behaviour exists,
    so on these distributions it is dead config — but it still holds a reference
    to the OLD hand-made edge function, and CloudFront will not let that function
    be deleted while any association survives. Repointing it at the site origin
    both releases that reference and makes the distribution fail closed (serving
    the site) rather than exposing the API on every path if `*` is ever removed.
    """
    site = next((b for b in config.get("CacheBehaviors", {}).get("Items", []) or []
                 if b["PathPattern"] == CATCH_ALL), None)
    if site is None:
        return ["(no '*' behaviour found — leaving the default alone)"]

    desired = {k: v for k, v in site.items() if k != "PathPattern"}
    if config.get("DefaultCacheBehavior") == desired:
        return []
    old_target = config.get("DefaultCacheBehavior", {}).get("TargetOriginId")
    old_lambdas = [
        a["LambdaFunctionARN"].split(":function:")[-1]
        for a in config.get("DefaultCacheBehavior", {})
        .get("LambdaFunctionAssociations", {})
        .get("Items", []) or []
    ]
    config["DefaultCacheBehavior"] = desired
    msg = f"reset default behaviour: {old_target} -> {desired['TargetOriginId']}"
    if old_lambdas:
        msg += f", releasing edge association(s) {', '.join(old_lambdas)}"
    return [msg]


def prune_unused_origins(config):
    """Drop origins no longer referenced by any behaviour.

    Leaving the superseded API origin behind would pin the distribution to an
    API Gateway the teardown is about to delete.
    """
    used = {config["DefaultCacheBehavior"]["TargetOriginId"]}
    used |= {b["TargetOriginId"] for b in config.get("CacheBehaviors", {}).get("Items", []) or []}
    items = config["Origins"]["Items"]
    keep = [o for o in items if o["Id"] in used]
    removed = [o["Id"] for o in items if o["Id"] not in used]
    if removed:
        config["Origins"]["Items"] = keep
        config["Origins"]["Quantity"] = len(keep)
        return [f"remove unreferenced origin(s): {', '.join(removed)}"]
    return []


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--distribution-id", required=True)
    p.add_argument("--api-domain", required=True, help="e.g. abc123.execute-api.ap-southeast-2.amazonaws.com")
    p.add_argument("--stage", default="live")
    p.add_argument("--edge-version-arn", required=True)
    p.add_argument("--web-acl-arn", default=None, help="Optional; leaves the existing ACL alone if omitted")
    p.add_argument("--reset-default-behaviour", action="store_true",
                   help="Repoint the (unreachable) default behaviour at the site origin, "
                        "releasing any legacy Lambda@Edge association, and prune unused origins")
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()

    cf = boto3.client("cloudfront")
    current = cf.get_distribution_config(Id=args.distribution_id)
    etag = current["ETag"]
    config = current["DistributionConfig"]

    print(f"Distribution {args.distribution_id} — {config.get('Comment','')}")
    print(f"  aliases: {config.get('Aliases',{}).get('Items',[])}")
    print(f"  current WebACL: {config.get('WebACLId') or '(none)'}")

    changes = []
    changes += upsert_api_origin(config, args.api_domain, args.stage)
    changes += upsert_api_behaviour(config, args.edge_version_arn)
    if args.reset_default_behaviour:
        changes += reset_default_behaviour(config)
        changes += prune_unused_origins(config)

    if args.web_acl_arn and config.get("WebACLId") != args.web_acl_arn:
        changes.append(f"attach WebACL {args.web_acl_arn}")
        config["WebACLId"] = args.web_acl_arn

    if not changes:
        print("\nAlready wired — nothing to change.")
        return 0

    print("\nPlanned changes:")
    for c in changes:
        print(f"  · {c}")

    print("\nResulting behaviour order:")
    for i, b in enumerate(config["CacheBehaviors"]["Items"]):
        tag = "  <= API" if b["PathPattern"] == API_PATH else ""
        print(f"  {i}. '{b['PathPattern']}' -> {b['TargetOriginId']} {b['AllowedMethods']['Items']}{tag}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to write this.")
        return 0

    cf.update_distribution(Id=args.distribution_id, IfMatch=etag, DistributionConfig=config)
    alias = (config.get("Aliases", {}).get("Items") or ["<domain>"])[0]
    print(f"\nApplied. CloudFront redeploys in ~3-5 min, then verify:\n")
    print(f"  curl -s -X POST https://{alias}/categorize \\")
    print("    -H 'Content-Type: application/json' \\")
    print('    -d \'{"url":"https://agl.com.au/","hostname":"agl.com.au","title":"AGL Energy"}\'')
    return 0


if __name__ == "__main__":
    sys.exit(main())
