#!/usr/bin/env python3
"""Repoint a CloudFront distribution's Lambda@Edge associations at a new version.

CloudFront associations must name a specific published Lambda version — an alias
or a bare function ARN is rejected. So deploying edge code is a three-step dance:
update the code, publish a version, then rewrite every association on the
distribution to that version ARN. Skipping the third step is silent: the deploy
"succeeds" and live traffic keeps running the old version.

Usage:  update_edge_association.py <distribution-id> <function-version-arn>
"""

import sys

import boto3


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    distribution_id, version_arn = sys.argv[1], sys.argv[2]
    if not distribution_id or distribution_id == "None":
        print("No distribution id resolved — skipping association update.", file=sys.stderr)
        return 1

    cloudfront = boto3.client("cloudfront")
    current = cloudfront.get_distribution_config(Id=distribution_id)
    etag = current["ETag"]
    config = current["DistributionConfig"]

    # The function ARN without the trailing ":<version>" — used to recognise our
    # own associations and leave any unrelated edge function alone.
    base_arn = version_arn.rsplit(":", 1)[0]
    updated = 0

    def repoint(behavior):
        nonlocal updated
        associations = behavior.get("LambdaFunctionAssociations", {})
        for item in associations.get("Items", []) or []:
            if item.get("LambdaFunctionARN", "").startswith(base_arn):
                if item["LambdaFunctionARN"] != version_arn:
                    item["LambdaFunctionARN"] = version_arn
                    updated += 1

    repoint(config.get("DefaultCacheBehavior", {}))
    for behavior in config.get("CacheBehaviors", {}).get("Items", []) or []:
        repoint(behavior)

    if updated == 0:
        print("Associations already current — nothing to do.")
        return 0

    cloudfront.update_distribution(Id=distribution_id, IfMatch=etag, DistributionConfig=config)
    print(f"Repointed {updated} association(s) to {version_arn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
