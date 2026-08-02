// SecureView shared configuration
// Single source of truth for auth and API settings used across
// background.js, popup.js, login.js, and signup.js.

const SV_CONFIG = {
  COGNITO_REGION: "ap-southeast-2",
  COGNITO_CLIENT_ID: "1bpn546e7vk1bm95ncbr0u5ma8",
  COGNITO_DOMAIN: "secureview-auth-715626528514-dev.auth.ap-southeast-2.amazoncognito.com",
};

// Obfuscated domain construction to evade automated GitHub scraping bots
const _CF_HOST = ["https://", "d1pjkjoqck0lva", ".cloudfront", ".net"].join("");
const CF_CONFIG = {
  url: `${_CF_HOST}/categorize`,
  reportUrl: `${_CF_HOST}/report`
};

function getCFConfig() {
  return CF_CONFIG;
}
