// URL categorization rules based on domain patterns
const CATEGORY_RULES = [
  {
    name: "News & Media",
    icon: "📰",
    color: "#E74C3C",
    domains: [
      "cnn.com", "bbc.com", "bbc.co.uk", "reuters.com", "nytimes.com",
      "theguardian.com", "washingtonpost.com", "forbes.com", "bloomberg.com",
      "apnews.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com",
      "foxnews.com", "npr.org", "theatlantic.com", "huffpost.com",
      "businessinsider.com", "techcrunch.com", "wired.com", "axios.com",
      "politico.com", "vox.com", "slate.com", "thedailybeast.com",
      "usatoday.com", "latimes.com", "nypost.com", "wsj.com",
      "ft.com", "economist.com", "time.com", "newsweek.com",
      "ndtv.com", "thehindu.com", "hindustantimes.com", "timesofindia.com",
      "aljazeera.com", "dw.com", "france24.com", "rt.com"
    ],
    keywords: ["news", "times", "post", "herald", "tribune", "daily", "gazette"]
  },
  {
    name: "Entertainment",
    icon: "🎬",
    color: "#9B59B6",
    domains: [
      "youtube.com", "netflix.com", "hulu.com", "disneyplus.com",
      "primevideo.com", "hbomax.com", "max.com", "peacocktv.com",
      "paramountplus.com", "crunchyroll.com", "funimation.com",
      "spotify.com", "soundcloud.com", "pandora.com", "tidal.com",
      "twitch.tv", "imdb.com", "rottentomatoes.com", "metacritic.com",
      "fandango.com", "vudu.com", "appletv.com", "tv.apple.com",
      "vimeo.com", "dailymotion.com", "bilibili.com", "niconico.jp",
      "9gag.com", "buzzfeed.com", "vice.com"
    ],
    keywords: ["movie", "film", "music", "stream", "video", "tv", "watch"]
  },
  {
    name: "Social Media",
    icon: "💬",
    color: "#3498DB",
    domains: [
      "twitter.com", "x.com", "facebook.com", "instagram.com",
      "linkedin.com", "pinterest.com", "snapchat.com", "tiktok.com",
      "reddit.com", "tumblr.com", "mastodon.social", "threads.net",
      "discord.com", "telegram.org", "web.telegram.org", "signal.org",
      "whatsapp.com", "web.whatsapp.com", "messenger.com",
      "quora.com", "nextdoor.com", "meetup.com", "clubhouse.com"
    ],
    keywords: ["social", "community", "forum", "chat", "connect"]
  },
  {
    name: "Travel",
    icon: "✈️",
    color: "#1ABC9C",
    domains: [
      "booking.com", "airbnb.com", "expedia.com", "hotels.com",
      "tripadvisor.com", "kayak.com", "skyscanner.com", "hopper.com",
      "priceline.com", "orbitz.com", "travelocity.com", "agoda.com",
      "hostelworld.com", "vrbo.com", "homeaway.com",
      "united.com", "delta.com", "aa.com", "southwest.com",
      "britishairways.com", "lufthansa.com", "emirates.com", "airfrance.com",
      "marriott.com", "hilton.com", "hyatt.com", "ihg.com",
      "lonelyplanet.com", "wikitravel.org", "rome2rio.com",
      "google.com/travel", "maps.google.com"
    ],
    keywords: ["travel", "hotel", "flight", "vacation", "trip", "tour", "booking"]
  },
  {
    name: "Shopping",
    icon: "🛒",
    color: "#E67E22",
    domains: [
      "ebay.com", "etsy.com", "walmart.com", "target.com",
      "bestbuy.com", "costco.com", "homedepot.com", "lowes.com",
      "wayfair.com", "overstock.com", "chewy.com", "zappos.com",
      "nordstrom.com", "macys.com", "gap.com", "oldnavy.com",
      "nike.com", "adidas.com", "underarmour.com", "reebok.com",
      "aliexpress.com", "wish.com", "shein.com", "asos.com",
      "shopify.com", "zara.com", "hm.com", "uniqlo.com",
      "newegg.com", "bhphotovideo.com", "adorama.com"
    ],
    keywords: ["shop", "store", "buy", "cart", "deal", "sale", "market"]
  },
  {
    name: "Technology",
    icon: "💻",
    color: "#2ECC71",
    domains: [
      "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com",
      "stackexchange.com", "developer.mozilla.org", "w3schools.com",
      "medium.com", "dev.to", "hashnode.com", "hackernews.com",
      "news.ycombinator.com", "producthunt.com", "techradar.com",
      "theverge.com", "arstechnica.com", "engadget.com", "gizmodo.com",
      "digitaltrends.com", "tomsguide.com", "tomshardware.com",
      "npmjs.com", "pypi.org", "crates.io", "rubygems.org",
      "codepen.io", "jsfiddle.net", "replit.com", "codesandbox.io",
      "docs.google.com", "notion.so", "atlassian.com", "jira.com",
      "confluence.com", "trello.com"
    ],
    keywords: ["tech", "code", "dev", "software", "api", "docs", "developer"]
  },
  {
    name: "Education",
    icon: "📚",
    color: "#F39C12",
    domains: [
      "coursera.org", "udemy.com", "edx.org", "khanacademy.org",
      "duolingo.com", "skillshare.com", "linkedin.com/learning",
      "pluralsight.com", "udacity.com", "datacamp.com",
      "wikipedia.org", "britannica.com", "scholarpedia.org",
      "jstor.org", "researchgate.net", "academia.edu",
      "google.com/scholar", "scholar.google.com",
      "mit.edu", "stanford.edu", "harvard.edu", "coursera.org",
      "codecademy.com", "freecodecamp.org", "theodinproject.com",
      "leetcode.com", "hackerrank.com", "codewars.com",
      "twinkl.com.au", "content.twinkl.co.uk", "twinkl.co.uk"
    ],
    keywords: ["learn", "edu", "course", "school", "university", "academy", "tutorial"]
  },
  {
    name: "Finance",
    icon: "💰",
    color: "#27AE60",
    domains: [
      "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
      "capitalone.com", "discover.com", "americanexpress.com",
      "paypal.com", "venmo.com", "cashapp.com", "zelle.com",
      "robinhood.com", "etrade.com", "fidelity.com", "schwab.com",
      "vanguard.com", "tdameritrade.com", "coinbase.com", "binance.com",
      "mint.com", "personalcapital.com", "ynab.com", "nerdwallet.com",
      "creditkarma.com", "bankrate.com", "investopedia.com",
      "finance.yahoo.com", "marketwatch.com", "cnbc.com"
    ],
    keywords: ["bank", "finance", "invest", "crypto", "stock", "pay", "money", "wallet"]
  },
  {
    name: "Health & Fitness",
    icon: "🏃",
    color: "#16A085",
    domains: [
      "webmd.com", "mayoclinic.org", "healthline.com", "medicalnewstoday.com",
      "nih.gov", "cdc.gov", "who.int", "medlineplus.gov",
      "myfitnesspal.com", "strava.com", "garmin.com", "fitbit.com",
      "nike.com/training", "beachbodyondemand.com", "peloton.com",
      "headspace.com", "calm.com", "betterhelp.com", "talkspace.com",
      "healthgrades.com", "zocdoc.com", "teladoc.com"
    ],
    keywords: ["health", "fitness", "medical", "diet", "workout", "wellness", "doctor"]
  },
  {
    name: "Productivity",
    icon: "⚡",
    color: "#8E44AD",
    domains: [
      "gmail.com", "mail.google.com", "outlook.com", "yahoo.com/mail",
      "mail.yahoo.com", "protonmail.com", "fastmail.com",
      "drive.google.com", "calendar.google.com",
      "docs.google.com", "sheets.google.com", "slides.google.com",
      "office.com", "microsoft365.com", "teams.microsoft.com",
      "zoom.us", "meet.google.com", "webex.com", "gotomeeting.com",
      "dropbox.com", "box.com", "onedrive.com", "icloud.com",
      "evernote.com", "notion.so", "airtable.com", "clickup.com",
      "asana.com", "monday.com", "basecamp.com"
    ],
    keywords: ["mail", "email", "calendar", "meet", "office", "workspace", "task"]
  },
  {
    name: "Gaming",
    icon: "🎮",
    color: "#C0392B",
    domains: [
      "steampowered.com", "store.steampowered.com", "epicgames.com",
      "origin.com", "ea.com", "battle.net", "ubisoft.com",
      "gog.com", "itch.io", "gamejolt.com", "kongregate.com",
      "miniclip.com", "poki.com", "crazygames.com", "y8.com",
      "ign.com", "gamespot.com", "kotaku.com", "polygon.com",
      "pcgamer.com", "rockpapershotgun.com", "eurogamer.net",
      "twitch.tv", "youtube.com/gaming"
    ],
    keywords: ["game", "gaming", "play", "esport", "rpg", "mmo"]
  }
];

// True if `keyword` appears in `hostname` aligned to a label boundary —
// either at the start of the hostname / a label, or before a label/path break.
// Both inputs must already be lowercase. Scans every occurrence so a
// late aligned hit (e.g. "sale" in "mywebsaleem.sale.com") isn't missed
// just because an earlier mid-label one was.
function hostnameMatchesKeyword(hostname, keyword) {
  let idx = hostname.indexOf(keyword);
  while (idx !== -1) {
    const before = idx === 0 ? "^" : hostname[idx - 1];
    const afterIdx = idx + keyword.length;
    const after = afterIdx === hostname.length ? "$" : hostname[afterIdx];
    const startBoundary = before === "^" || before === "." || before === "-";
    const endBoundary   = after  === "$" || after  === "." || after  === "-";
    if (startBoundary || endBoundary) return true;
    idx = hostname.indexOf(keyword, idx + 1);
  }
  return false;
}

function categorizeUrl(url) {
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url === "about:blank") {
    return { name: "System", icon: "⚙️", color: "#95A5A6" };
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, "");
    const fullPath = hostname + urlObj.pathname;

    // Exact domain (and subdomain / path-prefix) matches
    for (const category of CATEGORY_RULES) {
      for (const domain of category.domains) {
        if (hostname === domain || hostname.endsWith("." + domain) || fullPath.startsWith(domain)) {
          return { name: category.name, icon: category.icon, color: category.color };
        }
      }
    }

    // Keyword matching in hostname.
    // Keyword must align to a label boundary (start/end of hostname or a `.`/`-`)
    // so substrings inside unrelated names don't trigger false positives.
    // Examples:
    //   "news"  matches "news.com", "mynews.com", "online-news.com", "ndtv.news"
    //   "sale"  does NOT match "websaleem.com" (the bug this guard fixes)
    //   "shop"  matches "shop.com", "online-shop.com", "shopstyle.com"
    //   "shop"  does NOT match "bishopusa.com"
    for (const category of CATEGORY_RULES) {
      for (const keyword of category.keywords) {
        if (hostnameMatchesKeyword(hostname, keyword)) {
          return { name: category.name, icon: category.icon, color: category.color };
        }
      }
    }
  } catch (e) {
    // Invalid URL
  }

  return { name: "Other", icon: "🌐", color: "#7F8C8D" };
}

// Export for use in background.js and popup.js
if (typeof module !== "undefined") {
  module.exports = { categorizeUrl, CATEGORY_RULES };
}

