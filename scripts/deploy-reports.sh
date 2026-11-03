#!/usr/bin/env bash
# Deploy the email report relay for one environment, and wire it into that
# environment's CloudFront distribution.
#
#   ./scripts/deploy-reports.sh dev
#   ./scripts/deploy-reports.sh prod
#
# Separate from deploy-backend.sh on purpose. That script redeploys the
# classifier and the Lambda@Edge signer; a code change there produces a new
# content hash, a new Lambda::Version and a CloudFront repoint. Reports have no
# business triggering that, and the classifier path is the one that must not
# break.
#
# Safe to re-run. With no source change the stack is a no-op and the CloudFront
# update is skipped because the behaviour is already present.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV=${1:-}
case "$ENV" in
  dev|prod) ;;
  *) echo "usage: $0 <dev|prod>" >&2; exit 2 ;;
esac

REGION=ap-southeast-2
STACK="secureview-reports-${ENV}"

ENV_FILE="${SECUREVIEW_ENV_FILE:-deploy.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
EXPECTED="${SECUREVIEW_ACCOUNT_ID:-}"
if [[ -n "$EXPECTED" && "$ACCOUNT" != "$EXPECTED" ]]; then
  echo "FATAL: wrong account ($ACCOUNT, expected $EXPECTED)" >&2
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  DIST="${SECUREVIEW_PROD_DISTRIBUTION_ID:-}"
  SITE_BASE="https://secureview.websaleem.com"
else
  DIST="${SECUREVIEW_DEV_DISTRIBUTION_ID:-}"
  SITE_BASE="https://dev.secureview.websaleem.com"
fi
if [[ -z "$DIST" ]]; then
  echo "FATAL: distribution id for $ENV is not set (see deploy.env.example)" >&2
  exit 1
fi

ARTIFACTS="secureview-artifacts-${ACCOUNT}-${REGION}"

say() { printf '\n== %s\n' "$1"; }

say "Preflight"
echo "  account:      $ACCOUNT"
echo "  environment:  $ENV"
echo "  distribution: $DIST"
echo "  link base:    $SITE_BASE"
python3 -m py_compile backend/lambda/report/lambda_function.py
echo "  report source compiles: ok"

# The sender domain must be a verified SES identity in this region, or every
# send fails at runtime with nothing to show for it at deploy time.
VERIFIED=$(aws sesv2 get-email-identity --region "$REGION" --email-identity websaleem.com \
  --query VerifiedForSendingStatus --output text 2>/dev/null || echo "MISSING")
if [[ "$VERIFIED" != "True" ]]; then
  echo "FATAL: websaleem.com is not verified for sending in $REGION (got: $VERIFIED)" >&2
  exit 1
fi
echo "  SES identity websaleem.com verified: yes"

say "Artifact bucket"
if ! aws s3api head-bucket --bucket "$ARTIFACTS" --region "$REGION" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$ARTIFACTS" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$ARTIFACTS" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "  created $ARTIFACTS"
else
  echo "  $ARTIFACTS"
fi

say "Packaging"
# Content-addressed by SOURCE, so an unchanged source yields the same key and
# the stack reports no change — which is what makes re-running this safe.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
hash=$(find backend/lambda/report -name '*.py' -type f -exec shasum -a 256 {} \; \
       | sort | shasum -a 256 | cut -c1-16)
key="report/${hash}.zip"
(cd backend/lambda/report && zip -qrX "$tmp/out.zip" . -i '*.py')
if aws s3api head-object --bucket "$ARTIFACTS" --key "$key" >/dev/null 2>&1; then
  echo "  report: $key (already uploaded)"
else
  aws s3 cp "$tmp/out.zip" "s3://${ARTIFACTS}/${key}" --only-show-errors
  echo "  report: $key (uploaded)"
fi

say "Stack: $STACK ($REGION)"
aws cloudformation deploy \
  --region "$REGION" \
  --template-file infra/secureview-reports.yml \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    Environment="$ENV" \
    ArtifactBucket="$ARTIFACTS" \
    ReportArtifactKey="$key" \
    DistributionId="$DIST" \
    SiteBaseUrl="$SITE_BASE"

out() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
FN_URL=$(out ReportFunctionUrl)
OAC_ID=$(out ReportOACId)
TABLE=$(out SubscribersTableName)
echo "  function url: $FN_URL"
echo "  oac:          $OAC_ID"
echo "  table:        $TABLE"

say "CloudFront: /report/* behaviour on $DIST"
python3 scripts/attach-report-behaviour.py "$DIST" "$FN_URL" "$OAC_ID"

say "Done"
echo "  Reports are reachable at ${SITE_BASE}/report/*"
echo "  Nothing is sent until an address is entered in the popup AND confirmed."
