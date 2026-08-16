#!/usr/bin/env bash
# Remove the superseded SecureView backend resources.
#
#   ./scripts/teardown-legacy.sh          # dry run — prints the plan, changes nothing
#   ./scripts/teardown-legacy.sh --apply  # actually delete
#
# WHY: three overlapping stacks accumulated, all partially drifted, plus
# resources created by hand outside CloudFormation. Specifically:
#
#   secureview-cognito-auth   Cognito pool #1 (2 users)          — login removed
#   secureview-backend-dev    API 1kbd8rx0k6, svCategorizeURL,
#                             svSendEmailReport, Cognito #2,
#                             distribution E13N2TZOSX24F7        — "dev" name, prod-ish content
#   SecureViewBackend-dev     API 8vinwzmf85, svCategorizeURL-dev,
#                             svSendEmailReport-dev, Cognito #3,
#                             distribution E2GR0JKONMEAYE        — already deleted out of band
#
# Both stacks also declared their Lambda@Edge function in ap-southeast-2, where
# CloudFront can never attach it; those were deleted by hand already, so the
# stacks are drifted. The real edge functions live unmanaged in us-east-1.
#
# Everything above is replaced by secureview-api-<env> + secureview-edge-cdn-<env>.
#
# SAFETY: this account also hosts SecureBin, ShopShare, FloraSense, SkillView,
# Quizzee and websaleem.com. Every target below is named explicitly — there are
# no wildcards and no "delete everything matching" logic. Anything not on these
# lists is untouched by construction.
set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

API_REGION=ap-southeast-2
EDGE_REGION=us-east-1
SEA4=ap-southeast-4

# ── Explicit target lists ────────────────────────────────────────────────────
LEGACY_STACKS=(
  "SecureViewBackend-dev"
  "secureview-backend-dev"
  "secureview-cognito-auth"
)

# Created by hand, so stack deletion will not remove them.
# Both associations have been released (dev by --reset-default-behaviour, prod
# still pending — see step 4 notes), so these become deletable once CloudFront
# finishes removing their replicas.
LEGACY_EDGE_FUNCTIONS=(          # us-east-1
  "svSignedCategorizeRequest"
  "svSignedCategorizeRequest-Dev"
)

LEGACY_SEA4_FUNCTIONS=(          # ap-southeast-4 — the stray prod classifier
  "svCategorizeURL"
)

LEGACY_SEA4_APIS=(               # ap-southeast-4
  "qmpx5s8vne"                   # svURLCategorizeAPI
)

# NOTE: deliberately EMPTY.
#
# Both distributions — E13N2TZOSX24F7 (dev) and EOOCNJ6DOIEP3 (prod) — are now
# ADOPTED, not superseded. They hold the live aliases and certificates and have
# been rewired to the new API origins and edge signers, so deleting them would
# take both sites down and force a DNS cutover for no benefit.
LEGACY_DISTRIBUTIONS=()

banner() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
act()    { if $APPLY; then echo "  RUN  $*"; "$@"; else echo "  SKIP $*"; fi; }

$APPLY || banner "DRY RUN — nothing will be deleted. Re-run with --apply."

banner "Account check"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "  account: $ACCOUNT"
if [[ "$ACCOUNT" != "715626528514" ]]; then
  echo "  refusing to run against an unexpected account" >&2
  exit 1
fi

banner "1. Disable legacy CloudFront distributions"
if [[ ${#LEGACY_DISTRIBUTIONS[@]} -eq 0 ]]; then
  echo "  none — both distributions were adopted and rewired, not replaced."
fi
for d in ${LEGACY_DISTRIBUTIONS[@]+"${LEGACY_DISTRIBUTIONS[@]}"}; do
  if ! aws cloudfront get-distribution --id "$d" >/dev/null 2>&1; then
    echo "  · $d already gone"
    continue
  fi
  enabled=$(aws cloudfront get-distribution --id "$d" --query 'Distribution.DistributionConfig.Enabled' --output text)
  aliases=$(aws cloudfront get-distribution --id "$d" --query 'Distribution.DistributionConfig.Aliases.Items' --output text)
  echo "  · $d enabled=$enabled aliases=$aliases"
  if [[ "$enabled" == "True" ]]; then
    if $APPLY; then
      tmp=$(mktemp)
      etag=$(aws cloudfront get-distribution-config --id "$d" --query ETag --output text)
      aws cloudfront get-distribution-config --id "$d" --query DistributionConfig > "$tmp"
      python3 -c "
import json,sys
c=json.load(open('$tmp')); c['Enabled']=False; c['Aliases']={'Quantity':0}
json.dump(c, open('$tmp','w'))
"
      aws cloudfront update-distribution --id "$d" --if-match "$etag" --distribution-config "file://$tmp" >/dev/null
      rm -f "$tmp"
      echo "    disabled and aliases released (deploy takes ~5 min)"
    else
      echo "    SKIP disable + release aliases"
    fi
  fi
done

banner "2. Delete legacy CloudFormation stacks"
# GUARD — do not skip this.
#
# secureview-backend-dev still OWNS distribution E13N2TZOSX24F7, which is the
# live dev distribution: it holds dev.secureview.websaleem.com and has been
# rewired to the new API. `delete-stack` would delete it, taking dev down and
# losing the alias.
#
# CloudFormation only honours --retain-resources on a stack already in
# DELETE_FAILED, and these stacks are too drifted to accept a template update
# adding DeletionPolicy: Retain. So the safe order is to detach the distribution
# from the stack first (import it into secureview-edge-cdn-<env>, or accept the
# stack shell and delete its other resources individually).
#
# Until then, refuse rather than guess.
for s in "${LEGACY_STACKS[@]}"; do
  if ! aws cloudformation describe-stacks --region "$API_REGION" --stack-name "$s" >/dev/null 2>&1; then
    echo "  · $s already gone"
    continue
  fi

  # A distribution the stack owns is only a hazard if it is BOTH still alive and
  # not marked Retain. With DeletionPolicy: Retain, deleting the stack detaches
  # it and leaves it serving — which is how dev's E13N2TZOSX24F7 is handled.
  tpl=$(aws cloudformation get-template --region "$API_REGION" --stack-name "$s" --query TemplateBody --output text 2>/dev/null || true)
  owned_live=""
  for d in $(aws cloudformation list-stack-resources --region "$API_REGION" --stack-name "$s" \
               --query "StackResourceSummaries[?ResourceType=='AWS::CloudFront::Distribution'].PhysicalResourceId" \
               --output text 2>/dev/null); do
    aws cloudfront get-distribution --id "$d" >/dev/null 2>&1 || continue
    logical=$(aws cloudformation list-stack-resources --region "$API_REGION" --stack-name "$s" \
                --query "StackResourceSummaries[?PhysicalResourceId=='$d'].LogicalResourceId | [0]" --output text 2>/dev/null)
    # Retain sits directly under the logical id in the template body.
    if printf '%s' "$tpl" | grep -A3 "^  ${logical}:" | grep -q "DeletionPolicy: Retain"; then
      echo "    $d is Retain — will be detached, not deleted"
    else
      owned_live="$owned_live $d"
    fi
  done

  if [[ -n "$owned_live" ]]; then
    echo "  ! $s REFUSED — still owns live distribution(s):$owned_live"
    echo "    Deleting this stack would delete a distribution that is serving"
    echo "    traffic. Detach it first; see the comment above this guard."
    continue
  fi

  echo "  · $s"
  act aws cloudformation delete-stack --region "$API_REGION" --stack-name "$s"
done
if $APPLY; then
  for s in "${LEGACY_STACKS[@]}"; do
    # DELETE_IN_PROGRESS only for the ones that actually got a delete call;
    # anything the guard refused is still CREATE_COMPLETE and is skipped.
    st=$(aws cloudformation describe-stacks --region "$API_REGION" --stack-name "$s" \
           --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo GONE)
    [[ "$st" == *DELETE_IN_PROGRESS* ]] || continue
    echo "  waiting on $s ..."
    aws cloudformation wait stack-delete-complete --region "$API_REGION" --stack-name "$s" 2>/dev/null || \
      echo "    (did not complete cleanly — check the console for retained/drifted resources)"
  done
fi

banner "3. Delete stray ap-southeast-4 resources"
for f in "${LEGACY_SEA4_FUNCTIONS[@]}"; do
  if aws lambda get-function --region "$SEA4" --function-name "$f" >/dev/null 2>&1; then
    echo "  · lambda $f"
    act aws lambda delete-function --region "$SEA4" --function-name "$f"
  else
    echo "  · lambda $f already gone"
  fi
done
for a in "${LEGACY_SEA4_APIS[@]}"; do
  if aws apigateway get-rest-api --region "$SEA4" --rest-api-id "$a" >/dev/null 2>&1; then
    echo "  · api $a"
    act aws apigateway delete-rest-api --region "$SEA4" --rest-api-id "$a"
  else
    echo "  · api $a already gone"
  fi
done

banner "4. Delete hand-made Lambda@Edge functions (us-east-1)"
echo "  These fail until CloudFront finishes removing their replicas — often a"
echo "  few hours after the distribution is disabled. Re-run then; it is idempotent."
for f in "${LEGACY_EDGE_FUNCTIONS[@]}"; do
  if aws lambda get-function --region "$EDGE_REGION" --function-name "$f" >/dev/null 2>&1; then
    echo "  · $f"
    if $APPLY; then
      aws lambda delete-function --region "$EDGE_REGION" --function-name "$f" 2>&1 | sed 's/^/    /' || \
        echo "    still has replicas — re-run later"
    else
      echo "    SKIP delete"
    fi
  else
    echo "  · $f already gone"
  fi
done

banner "5. Delete the disabled distributions"
if [[ ${#LEGACY_DISTRIBUTIONS[@]} -eq 0 ]]; then
  echo "  none — see above."
fi
for d in ${LEGACY_DISTRIBUTIONS[@]+"${LEGACY_DISTRIBUTIONS[@]}"}; do
  if ! aws cloudfront get-distribution --id "$d" >/dev/null 2>&1; then
    echo "  · $d already gone"; continue
  fi
  status=$(aws cloudfront get-distribution --id "$d" --query 'Distribution.Status' --output text)
  enabled=$(aws cloudfront get-distribution --id "$d" --query 'Distribution.DistributionConfig.Enabled' --output text)
  if [[ "$status" == "Deployed" && "$enabled" == "False" ]]; then
    etag=$(aws cloudfront get-distribution-config --id "$d" --query ETag --output text)
    echo "  · $d ready to delete"
    act aws cloudfront delete-distribution --id "$d" --if-match "$etag"
  else
    echo "  · $d not ready (status=$status enabled=$enabled) — re-run once deployed"
  fi
done

banner "Remaining SecureView footprint"
echo "  stacks ($API_REGION):"
aws cloudformation list-stacks --region "$API_REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'ecureView') || contains(StackName,'ecureview')].StackName" \
  --output text | tr '\t' '\n' | sed 's/^/    /'
echo "  cognito pools:"
aws cognito-idp list-user-pools --max-results 20 --region "$API_REGION" \
  --query "UserPools[?contains(Name,'SecureView')].[Id,Name]" --output text | sed 's/^/    /'

$APPLY || printf '\n\033[1mDry run complete. Re-run with --apply to execute.\033[0m\n'
