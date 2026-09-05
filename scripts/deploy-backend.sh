#!/usr/bin/env bash
# Deploy the SecureView backend for one environment, end to end.
#
#   ./scripts/deploy-backend.sh dev
#   ./scripts/deploy-backend.sh prod
#
# Two stacks, because AWS forces the split:
#   secureview-api-<env>       ap-southeast-2  classifier Lambda + API Gateway
#   secureview-edge-cdn-<env>  us-east-1       Lambda@Edge + WAF + CloudFront
#
# Lambda code is content-hashed into its S3 key, so a code change changes the
# key, which replaces the Lambda::Version, which repoints the CloudFront
# association — in one deploy, with no manual publish step. That chain is what
# the old process was missing: `update-function-code` alone never reached live
# traffic because the distribution stayed pinned to an old version.
#
# Safe to re-run. With no changes it is a no-op on both stacks.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV=${1:-}
case "$ENV" in
  dev|prod) ;;
  *) echo "usage: $0 <dev|prod>" >&2; exit 2 ;;
esac

API_REGION=ap-southeast-2
EDGE_REGION=us-east-1
API_STACK="secureview-api-${ENV}"
CDN_STACK="secureview-edge-cdn-${ENV}"

if [[ "$ENV" == "prod" ]]; then
  DEFAULT_ALIAS="secureview.websaleem.com"
  SITE_BUCKET="secureview.websaleem.com"
  OAC_ID="${OAC_ID:-E37RLKCUPSENTL}"
  # Prod adopts its existing distribution rather than building a new one: that
  # distribution already holds the apex alias and a certificate the wildcard
  # does not cover, so recreating it would force a DNS cutover for no gain.
  # The stack still owns the edge signer; the distribution is wired by
  # scripts/attach-api-behaviour.py.
  MANAGE_DISTRIBUTION="${MANAGE_DISTRIBUTION:-false}"
  ADOPT_DISTRIBUTION_ID="${ADOPT_DISTRIBUTION_ID:-EOOCNJ6DOIEP3}"
  # Prod's distribution already carries a CloudFront-managed ACL with a rate
  # limit PLUS IP-reputation, common-rule-set and known-bad-inputs groups.
  # Ours would be a downgrade, so do not create or attach one.
  CREATE_WEB_ACL="${CREATE_WEB_ACL:-false}"
else
  DEFAULT_ALIAS="dev.secureview.websaleem.com"
  SITE_BUCKET="dev.secureview.websaleem.com"
  OAC_ID="${OAC_ID:-E1Q0XJQQ940RUS}"
  # Dev adopts its existing distribution for the same reason prod does: it
  # already holds dev.secureview.websaleem.com and the wildcard certificate, so
  # reusing it avoids a DNS cutover and keeps the endpoint on a stable alias
  # rather than a *.cloudfront.net domain.
  MANAGE_DISTRIBUTION="${MANAGE_DISTRIBUTION:-false}"
  ADOPT_DISTRIBUTION_ID="${ADOPT_DISTRIBUTION_ID:-E13N2TZOSX24F7}"
  # Dev deliberately runs without a WebACL. Rate limiting is a production
  # concern here: dev's endpoint is not published in any shipped extension
  # build, and the cost of a stray ACL is a monthly charge plus drift to manage.
  # Set CREATE_WEB_ACL=true for a one-off if dev ever needs protecting.
  CREATE_WEB_ACL="${CREATE_WEB_ACL:-false}"
fi

# Alias handling. CloudFront rejects an alias that another distribution already
# claims, so the first build-out runs WITHOUT one: the new stack comes up on its
# *.cloudfront.net domain and can be verified end to end while the old
# distribution keeps serving the site. At cutover, release the alias from the
# old distribution and re-run with WITH_ALIAS=1.
#
#   ./scripts/deploy-backend.sh dev              # no alias (safe, default)
#   WITH_ALIAS=1 ./scripts/deploy-backend.sh dev # claim the alias
if [[ "${WITH_ALIAS:-0}" == "1" ]]; then
  ALIAS="${ALIAS:-$DEFAULT_ALIAS}"
else
  ALIAS=""
fi

# The wildcard cert covers dev.* but NOT the apex secureview.websaleem.com, so
# prod needs its own cert ARN. Override with CERT_ARN when deploying prod.
CERT_ARN="${CERT_ARN:-arn:aws:acm:us-east-1:715626528514:certificate/b9dc7752-38a7-46eb-a49f-3f89b90d1270}"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
API_ARTIFACTS="secureview-artifacts-${ACCOUNT}-${API_REGION}"
EDGE_ARTIFACTS="secureview-artifacts-${ACCOUNT}-${EDGE_REGION}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

ensure_bucket() {
  local bucket=$1 region=$2
  if ! aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    echo "  creating artifact bucket $bucket ($region)"
    if [[ "$region" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
    else
      aws s3api create-bucket --bucket "$bucket" --region "$region" \
        --create-bucket-configuration LocationConstraint="$region" >/dev/null
    fi
    aws s3api put-public-access-block --bucket "$bucket" \
      --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-encryption --bucket "$bucket" \
      --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  fi
}

# Zip a source dir reproducibly and upload under a content-hashed key.
package() {
  local src=$1 name=$2 bucket=$3
  local tmp; tmp=$(mktemp -d)
  # -X drops extra file attributes and timestamps vary anyway, so hash the
  # SOURCE rather than the zip to keep the key stable across rebuilds.
  local hash; hash=$(find "$src" -type f -name '*.py' -exec shasum -a 256 {} \; | sort | shasum -a 256 | cut -c1-12)
  local key="${name}/${hash}.zip"
  (cd "$src" && zip -qrX "$tmp/out.zip" . -i '*.py')
  if ! aws s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>&1; then
    aws s3 cp "$tmp/out.zip" "s3://${bucket}/${key}" >/dev/null
    echo "  uploaded s3://${bucket}/${key}" >&2
  else
    echo "  reusing s3://${bucket}/${key} (unchanged)" >&2
  fi
  rm -rf "$tmp"
  printf '%s' "$key"
}

say "Preflight"
echo "  account:     $ACCOUNT"
echo "  environment: $ENV"
echo "  alias:       ${ALIAS:-(none — new distribution, existing site untouched)}"
python3 -m py_compile backend/lambda/lambda_function.py backend/lambda/bedrock/lambda_function.py
echo "  lambda sources compile: ok"

say "Artifact buckets"
ensure_bucket "$API_ARTIFACTS" "$API_REGION"
ensure_bucket "$EDGE_ARTIFACTS" "$EDGE_REGION"

say "Packaging"
CLASSIFIER_KEY=$(package backend/lambda/bedrock classifier "$API_ARTIFACTS")
EDGE_KEY=$(package backend/lambda edge "$EDGE_ARTIFACTS")
echo "  classifier: $CLASSIFIER_KEY"
echo "  edge:       $EDGE_KEY"

say "Stack 1/2: $API_STACK ($API_REGION)"
aws cloudformation deploy \
  --region "$API_REGION" \
  --template-file infra/secureview-api.yml \
  --stack-name "$API_STACK" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    Environment="$ENV" \
    ArtifactBucket="$API_ARTIFACTS" \
    ClassifierArtifactKey="$CLASSIFIER_KEY"

api_out() {
  aws cloudformation describe-stacks --region "$API_REGION" --stack-name "$API_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
API_DOMAIN=$(api_out ApiDomainName)
API_STAGE=$(api_out ApiStageName)
echo "  api: $API_DOMAIN (stage $API_STAGE)"

say "Stack 2/2: $CDN_STACK ($EDGE_REGION)"
aws cloudformation deploy \
  --region "$EDGE_REGION" \
  --template-file infra/secureview-edge-cdn.yml \
  --stack-name "$CDN_STACK" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    Environment="$ENV" \
    ArtifactBucket="$EDGE_ARTIFACTS" \
    EdgeArtifactKey="$EDGE_KEY" \
    ApiDomainName="$API_DOMAIN" \
    ApiStageName="$API_STAGE" \
    SiteBucketRegionalDomainName="${SITE_BUCKET}.s3.${API_REGION}.amazonaws.com" \
    OriginAccessControlId="$OAC_ID" \
    AcmCertificateArn="$CERT_ARN" \
    DistributionAlias="$ALIAS" \
    ManageDistribution="$MANAGE_DISTRIBUTION" \
    CreateWebACL="$CREATE_WEB_ACL"

cdn_out() {
  aws cloudformation describe-stacks --region "$EDGE_REGION" --stack-name "$CDN_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
EDGE_VERSION_ARN=$(cdn_out EdgeVersionArn)
echo "  edge version: $EDGE_VERSION_ARN"

if [[ "$MANAGE_DISTRIBUTION" == "true" ]]; then
  DIST_ID=$(cdn_out DistributionId)
  DIST_DOMAIN=$(cdn_out DistributionDomainName)
  ENDPOINT_HOST="${ALIAS:-$DIST_DOMAIN}"
else
  say "Wiring existing distribution $ADOPT_DISTRIBUTION_ID"
  DIST_ID="$ADOPT_DISTRIBUTION_ID"
  DIST_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.DomainName' --output text)
  ENDPOINT_HOST="${ALIAS:-$DEFAULT_ALIAS}"
  # The distribution is not stack-managed, so it is patched additively: the
  # `*` -> S3 behaviour that serves the site is left untouched.
  WEB_ACL_ARN=""
  if [[ "$CREATE_WEB_ACL" == "true" ]]; then
    WEB_ACL_ARN=$(cdn_out WebACLArn)
    echo "  web acl:      $WEB_ACL_ARN"
  fi
  python3 scripts/attach-api-behaviour.py \
    --distribution-id "$DIST_ID" \
    --api-domain "$API_DOMAIN" \
    --stage "$API_STAGE" \
    --edge-version-arn "$EDGE_VERSION_ARN" \
    --reset-default-behaviour \
    ${WEB_ACL_ARN:+--web-acl-arn "$WEB_ACL_ARN"} \
    ${ATTACH_APPLY:+--apply}
  if [[ -z "${ATTACH_APPLY:-}" ]]; then
    echo
    echo "  Distribution NOT modified (dry run). Re-run with ATTACH_APPLY=1 to write it."
  fi
fi

say "Done"
echo "  distribution: $DIST_ID ($DIST_DOMAIN)"
if [[ -n "$ALIAS" ]]; then
  echo "  alias:        https://$ALIAS  — point DNS at $DIST_DOMAIN"
elif [[ "$MANAGE_DISTRIBUTION" != "true" ]]; then
  echo "  alias:        https://$ENDPOINT_HOST (already on the adopted distribution)"
else
  echo "  alias:        none yet. Verify on the CloudFront domain, then re-run"
  echo "                with WITH_ALIAS=1 once the old distribution has released it."
fi
echo
echo "  Verify (CloudFront needs ~3-5 min to finish deploying first):"
echo
echo "    curl -s -X POST https://$ENDPOINT_HOST/categorize \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"url\":\"https://agl.com.au/\",\"hostname\":\"agl.com.au\",\"title\":\"AGL Energy\"}'"
echo
echo "  Expect: {\"hostname\":\"agl.com.au\",...,\"category\":\"Utilities & Energy\"}"
