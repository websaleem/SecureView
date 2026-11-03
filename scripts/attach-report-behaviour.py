#!/usr/bin/env python3
"""Attach /report/* to a CloudFront distribution, cloned from /categorize.

    attach-report-behaviour.py <distribution-id>

Reports reach API Gateway through the same origin and the same Lambda@Edge
signer as the classifier, so the behaviour is COPIED from the live /categorize
behaviour rather than written out here. That matters: the signer association
carries a specific function version, and the origin, cache policy and origin
request policy are all things that have already been got right once. Restating
them from memory is how a working configuration acquires a subtle difference.

Only two things are changed on the copy:
  * the path pattern
  * the allowed methods, because the confirmation and unsubscribe links are
    browser GETs while the extension's calls are POSTs

It also removes the secureview-report-origin left behind by the earlier
Function-URL attempt, if present. That origin is unreachable now and an unused
origin pointing at a Lambda URL is exactly the sort of thing that gets found
later and wondered about.

Idempotent: with nothing to change it makes no API call.
"""
import json
import subprocess
import sys

PATH_PATTERN = "/report/*"
CLONE_FROM = "/categorize"
DEAD_ORIGIN = "secureview-report-origin"
ALL_METHODS = ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"]


def aws(*args):
    out = subprocess.run(["aws", *args], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"aws {' '.join(args)}\n{out.stderr.strip()}")
    return out.stdout


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dist_id = sys.argv[1]

    raw = json.loads(aws("cloudfront", "get-distribution-config", "--id", dist_id))
    etag, cfg = raw["ETag"], raw["DistributionConfig"]
    before = json.dumps(cfg, sort_keys=True)

    behaviours = cfg.setdefault("CacheBehaviors", {"Quantity": 0, "Items": []})
    items = behaviours.setdefault("Items", [])

    template = next((b for b in items if b.get("PathPattern") == CLONE_FROM), None)
    if template is None:
        sys.exit(f"  no {CLONE_FROM} behaviour on {dist_id} — deploy the backend first")

    desired = json.loads(json.dumps(template))   # deep copy
    desired["PathPattern"] = PATH_PATTERN
    desired["AllowedMethods"] = {
        "Quantity": len(ALL_METHODS),
        "Items": ALL_METHODS,
        "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]},
    }

    signer = (template.get("LambdaFunctionAssociations", {}).get("Items") or [{}])[0].get("LambdaFunctionARN", "")
    print(f"  cloning {CLONE_FROM}: origin={template['TargetOriginId']}")
    print(f"    signer: {signer or '(none!)'}")
    if not signer:
        sys.exit("  refusing: /categorize has no Lambda@Edge association to copy")

    existing = next((b for b in items if b.get("PathPattern") == PATH_PATTERN), None)
    if existing is None:
        # Ahead of any catch-all, or "*" swallows it.
        items.insert(0, desired)
        print(f"  + behaviour {PATH_PATTERN}")
    else:
        for field in ("TargetOriginId", "CachePolicyId", "OriginRequestPolicyId",
                      "LambdaFunctionAssociations", "AllowedMethods", "FunctionAssociations"):
            if json.dumps(existing.get(field), sort_keys=True) != json.dumps(desired.get(field), sort_keys=True):
                print(f"  ~ behaviour {field} updated")
                existing[field] = desired[field]
    behaviours["Quantity"] = len(items)

    # Drop the origin from the abandoned Function-URL attempt.
    origins = cfg.get("Origins", {})
    oitems = origins.get("Items", [])
    still_used = {b.get("TargetOriginId") for b in items} | {cfg["DefaultCacheBehavior"]["TargetOriginId"]}
    dead = [o for o in oitems if o["Id"] == DEAD_ORIGIN and o["Id"] not in still_used]
    if dead:
        origins["Items"] = [o for o in oitems if o["Id"] != DEAD_ORIGIN]
        origins["Quantity"] = len(origins["Items"])
        print(f"  - origin {DEAD_ORIGIN} (unreferenced since the Function URL was dropped)")

    if json.dumps(cfg, sort_keys=True) == before:
        print("  no change — already wired")
        return

    with open("/tmp/secureview-report-cf.json", "w") as fh:
        json.dump(cfg, fh)
    aws("cloudfront", "update-distribution", "--id", dist_id, "--if-match", etag,
        "--distribution-config", "file:///tmp/secureview-report-cf.json")
    print("  applied — waiting for the distribution to deploy")
    aws("cloudfront", "wait", "distribution-deployed", "--id", dist_id)
    print("  deployed")


if __name__ == "__main__":
    main()
