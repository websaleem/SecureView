#!/usr/bin/env bash
# Package SecureView for Chrome Web Store upload.
#
#   ./scripts/build-zip.sh                       # production zip
#   CHANNEL=beta ./scripts/build-zip.sh          # beta zip — manifest.name patched
#   OUTPUT=foo.zip ./scripts/build-zip.sh        # override the zip filename
#
# What ships:  manifest.json + background/ content/ icons/ popup/ shared/
# What doesn't: .git, .github, scripts, README, .gitignore, .gitattributes,
#               build/, any pre-existing zips, and dotfiles in general.
set -euo pipefail

cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-production}
case "$CHANNEL" in
  production|beta) ;;
  *) echo "CHANNEL must be 'production' or 'beta' (got: $CHANNEL)"; exit 1 ;;
esac

VERSION=$(node -p "require('./manifest.json').version")
DEFAULT_NAME="SecureView"
BETA_NAME="SecureView Beta"

if [[ "$CHANNEL" == "beta" ]]; then
  OUTPUT=${OUTPUT:-SecureView-Beta-${VERSION}.zip}
else
  OUTPUT=${OUTPUT:-SecureView-${VERSION}.zip}
fi

# Validate manifest before doing anything else.
node -e '
  const m = require("./manifest.json");
  if (m.manifest_version !== 3) { console.error("manifest_version != 3"); process.exit(1); }
  if (!m.version)               { console.error("manifest.version missing"); process.exit(1); }
  if (!m.name)                  { console.error("manifest.name missing"); process.exit(1); }
'

# Stage to a build dir so any per-channel manifest mutation never touches source.
BUILD_DIR=build/$CHANNEL
rm -rf "$BUILD_DIR" "$OUTPUT"
mkdir -p "$BUILD_DIR"

# Copy the shipping bits.
cp manifest.json "$BUILD_DIR/"
for d in background content icons popup shared; do
  cp -R "$d" "$BUILD_DIR/"
done

# Drop macOS metadata so a developer build doesn't accidentally ship it.
find "$BUILD_DIR" -name ".DS_Store" -delete

# Patch manifest.name for beta channel.
if [[ "$CHANNEL" == "beta" ]]; then
  node -e '
    const fs = require("fs");
    const path = "build/beta/manifest.json";
    const m = JSON.parse(fs.readFileSync(path, "utf8"));
    m.name = process.argv[1];
    fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  ' "$BETA_NAME"
fi

(cd "$BUILD_DIR" && zip -qr "../../$OUTPUT" .)

SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
SHIPPED_NAME=$(node -e "console.log(require('./$BUILD_DIR/manifest.json').name)")
echo "Built $OUTPUT  channel=$CHANNEL  version=$VERSION  name='$SHIPPED_NAME'  size=$SIZE bytes"
