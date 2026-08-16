// SecureView shared configuration
// Single source of truth for API settings used by background.js.
//
// The production build rewrites _CF_HOST (and the matching host_permissions
// entry in manifest.json) via scripts/build-zip.sh — keep the two in sync, or
// the service worker's fetch will be blocked by the missing host permission.

// Split-string construction to keep the host out of naive repo scrapers. This
// is obfuscation, not a secret: the value ships in the extension either way.
//
// The dev alias, not a *.cloudfront.net domain: the alias survives a
// distribution being replaced, so this value does not have to be chased.
// scripts/build-zip.sh swaps it for the production alias on the prod channel.
const _CF_HOST = ["https://", "dev.secureview", ".websaleem", ".com"].join("");
const CF_CONFIG = {
  url: `${_CF_HOST}/categorize`
};

function getCFConfig() {
  return CF_CONFIG;
}
