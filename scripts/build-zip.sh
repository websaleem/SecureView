#!/usr/bin/env bash
# Package SecureView for Chrome Web Store upload.
#
#   ./scripts/build-zip.sh                       # production zip
#   CHANNEL=beta ./scripts/build-zip.sh          # beta zip — manifest.name patched
#   OUTPUT=foo.zip ./scripts/build-zip.sh        # override the zip filename
#
# PROD_CLOUDFRONT_URL (production channel only) repoints the extension at the
# production distribution — a bare https origin, e.g. https://dxxxx.cloudfront.net
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

VERSION=$(node -p "require('./chrome/manifest.json').version")
DEFAULT_NAME="SecureView"
BETA_NAME="SecureView Beta"

if [[ "$CHANNEL" == "beta" ]]; then
  OUTPUT=${OUTPUT:-SecureView-Beta-${VERSION}.zip}
else
  OUTPUT=${OUTPUT:-SecureView-${VERSION}.zip}
fi

# Validate manifest before doing anything else.
node -e '
  const m = require("./chrome/manifest.json");
  if (m.manifest_version !== 3) { console.error("manifest_version != 3"); process.exit(1); }
  if (!m.version)               { console.error("manifest.version missing"); process.exit(1); }
  if (!m.name)                  { console.error("manifest.name missing"); process.exit(1); }
'

# Stage to a build dir so any per-channel manifest mutation never touches source.
BUILD_DIR=build/$CHANNEL
rm -rf "$BUILD_DIR" "$OUTPUT"
mkdir -p "$BUILD_DIR"

# Copy the shipping bits.
cp chrome/manifest.json "$BUILD_DIR/"
for d in background content icons popup shared; do
  cp -R "chrome/$d" "$BUILD_DIR/"
done

# Drop macOS metadata and local-only scratch files so a developer build doesn't
# accidentally ship them. `_preview.html` is the design harness in popup/ — it
# is gitignored, but `cp -R` above copies whatever is in the working tree.
find "$BUILD_DIR" -name ".DS_Store" -delete
find "$BUILD_DIR" -name "_*" -delete

if [[ "$CHANNEL" == "beta" ]]; then
  node -e '
    const fs = require("fs");
    const path = "build/beta/manifest.json";
    const m = JSON.parse(fs.readFileSync(path, "utf8"));
    m.name = process.argv[1];
    fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  ' "$BETA_NAME"
  
  # Inject dev URLs for the beta/dev extension
  node -e '
    const fs = require("fs");
    const path = require("path");
    function replaceInDir(dir) {
      fs.readdirSync(dir).forEach(file => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          replaceInDir(fullPath);
        } else if (fullPath.endsWith(".html") || fullPath.endsWith(".js")) {
          let content = fs.readFileSync(fullPath, "utf8");
          content = content.replace(/https:\/\/secureview\.websaleem\.com/g, "https://dev.secureview.websaleem.com");
          fs.writeFileSync(fullPath, content);
        }
      });
    }
    replaceInDir("build/beta");
  '
elif [[ "$CHANNEL" == "production" ]]; then
  # Point the production build at the production CloudFront distribution.
  #
  # config.js and manifest.json must BOTH be rewritten: the service worker's
  # fetch is blocked unless host_permissions covers the host it calls, so
  # swapping only the config silently breaks categorisation in the prod build.
  if [[ -n "${PROD_CLOUDFRONT_URL:-}" ]]; then
    node -e '
      const fs = require("fs");
      const host = process.env.PROD_CLOUDFRONT_URL.replace(/\/+$/, "");
      if (!/^https:\/\/[^/]+$/.test(host)) {
        console.error(`PROD_CLOUDFRONT_URL must be a bare https origin (got: ${host})`);
        process.exit(1);
      }

      const configPath = "build/production/shared/config.js";
      let c = fs.readFileSync(configPath, "utf8");
      const before = c;
      c = c.replace(/const _CF_HOST\s*=\s*\[[^\]]+\]\.join\(""\);/, `const _CF_HOST = "${host}";`);
      if (c === before) { console.error("Could not rewrite _CF_HOST in config.js"); process.exit(1); }
      fs.writeFileSync(configPath, c);

      const manifestPath = "build/production/manifest.json";
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.host_permissions = [`${host}/*`];
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

      console.log(`Production endpoint set to ${host}`);
    '
  else
    echo "Warning: PROD_CLOUDFRONT_URL is missing. Using dev endpoint for the production zip!"
  fi
fi

(cd "$BUILD_DIR" && zip -qr "../../$OUTPUT" .)

SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
SHIPPED_NAME=$(node -e "console.log(require('./$BUILD_DIR/manifest.json').name)")
echo "Built $OUTPUT  channel=$CHANNEL  version=$VERSION  name='$SHIPPED_NAME'  size=$SIZE bytes"
