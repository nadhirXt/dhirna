/**
 * Pure Adult Content & Focus Shield logic for Dhirna (Desktop + Browser Extension + Mobile DNS QR).
 * Zero browser or network dependencies so every rule is unit-tested with `node --test`.
 */

import { extractHostname, matchesDomain } from "./domains.js";

export const SHIELD_COOLDOWN_SECONDS = 60;

export const SHIELD_DISABLE_PHRASE = {
  fr: "JE DESACTIVE LE BOUCLIER",
  en: "DISABLE ADULT SHIELD"
};

export const SOCIAL_SHIELD_DOMAINS = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "messenger.com"
];

/**
 * Checks whether a domain/URL belongs to the social/video platforms managed by Messages-Only Mode.
 */
export function isSocialShieldManagedDomain(domainOrHost) {
  if (typeof domainOrHost !== "string" || !domainOrHost.trim()) return false;
  const host =
    extractHostname(domainOrHost) ||
    domainOrHost.trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  return SOCIAL_SHIELD_DOMAINS.some((d) => matchesDomain(host, d));
}

export const SHIELD_LOCK_PRESETS = [
  { id: "24h", hours: 24, labelFr: "24 h", labelEn: "24 h" },
  { id: "7d", hours: 24 * 7, labelFr: "7 jours", labelEn: "7 days" },
  { id: "30d", hours: 24 * 30, labelFr: "30 jours", labelEn: "30 days" }
];

export const SHIELD_PROVIDERS = {
  cleanbrowsing: {
    id: "cleanbrowsing",
    name: "CleanBrowsing Adult",
    ipv4: ["185.228.168.10", "185.228.169.11"],
    ipv6: ["2a0d:2a00:1::1", "2a0d:2a00:2::1"],
    dotHost: "adult-filter-dns.cleanbrowsing.org",
    dohUrl: "https://doh.cleanbrowsing.org/doh/adult-filter/",
    canaryDomain: "badexample.com",
    profileUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000101",
    payloadUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000102",
    descFr: "Bloque les sites adultes, les proxies de contournement et force SafeSearch",
    descEn: "Blocks adult sites, bypass proxies, and enforces SafeSearch"
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare for Families",
    ipv4: ["1.1.1.3", "1.0.0.3"],
    ipv6: ["2606:4700:4700::1113", "2606:4700:4700::1003"],
    dotHost: "family.cloudflare-dns.com",
    dohUrl: "https://family.cloudflare-dns.com/dns-query",
    canaryDomain: "nudity.testcategory.com",
    profileUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000201",
    payloadUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000202",
    descFr: "Latence minimale, sans journaux, bloque sites adultes et logiciels malveillants",
    descEn: "Minimal latency, zero logs, blocks adult content and malware"
  },
  adguard: {
    id: "adguard",
    name: "AdGuard Family",
    ipv4: ["94.140.14.15", "94.140.15.16"],
    ipv6: ["2a10:50c0::bad1:ff", "2a10:50c0::bad2:ff"],
    dotHost: "family.adguard-dns.com",
    dohUrl: "https://family.adguard-dns.com/dns-query",
    canaryDomain: "nudity.testcategory.com",
    profileUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000301",
    payloadUuid: "B8C41910-6E42-4D9C-8A11-4F91D2000302",
    descFr: "Bloque sites adultes, publicités, traceurs et force SafeSearch",
    descEn: "Blocks adult sites, ads, trackers, and enforces SafeSearch"
  }
};

export const CURATED_ADULT_DOMAINS = [
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "tube8.com",
  "spankbang.com",
  "eporner.com",
  "txxx.com",
  "beeg.com",
  "hqporner.com",
  "daftsex.com",
  "brazzers.com",
  "bangbros.com",
  "naughtyamerica.com",
  "realitykings.com",
  "onlyfans.com",
  "fansly.com",
  "chaturbate.com",
  "stripchat.com",
  "bongacams.com",
  "cam4.com",
  "livejasmin.com",
  "myfreecams.com",
  "camsoda.com",
  "flirt4free.com",
  "rule34.xxx",
  "nhentai.net",
  "hanime.tv",
  "hentaihaven.xxx",
  "e-hentai.org",
  "exhentai.org",
  "gelbooru.com",
  "danbooru.donmai.us",
  "fapello.com",
  "erome.com",
  "coomer.su",
  "kemono.su",
  "motherless.com",
  "heavy-r.com",
  "efukt.com",
  "thisvid.com",
  "tnaflix.com",
  "drtuber.com",
  "sunporno.com",
  "nuvid.com",
  "porntrex.com",
  "pornone.com",
  "porn300.com",
  "porndig.com",
  "porndoe.com",
  "porngo.com",
  "pornhat.com",
  "pornhits.com",
  "pornktube.com",
  "porntube.com",
  "pornzog.com",
  "sexvid.xxx",
  "ixxx.com",
  "ok.xxx",
  "fuq.com",
  "gotporn.com",
  "hclips.com",
  "javhd.com",
  "missav.com",
  "javguru.com",
  "jable.tv",
  "supjav.com",
  "youjizz.com",
  "jizzbunker.com",
  "vporn.com",
  "xtube.com",
  "4tube.com",
  "anysex.com",
  "alohatube.com",
  "alphaporno.com",
  "apclips.com",
  "clips4sale.com",
  "manyvids.com",
  "iwantclips.com",
  "loyalfans.com",
  "adultfriendfinder.com",
  "ashleymadison.com",
  "fetlife.com",
  "literotica.com",
  "asstr.org",
  "imagefap.com",
  "pornpics.com",
  "sex.com",
  "porn.com",
  "xxx.com",
  "xvideos2.com",
  "xvideos3.com",
  "xvideos-cdn.com",
  "xnxx2.com",
  "xnxx3.com",
  "xhamster2.com",
  "xhamster3.com",
  "xhamster42.com",
  "pornhub.org",
  "rt.pornhub.com",
  "fr.pornhub.com",
  "fr.xhamster.com",
  "fr.xvideos.com",
  "sxyprn.com",
  "yespornplease.sexy",
  "perfectgirls.xxx",
  "thumbzilla.com",
  "faphouse.com",
  "zzztube.com",
  "3movs.com",
  "boyfriendtv.com",
  "gaymaletube.com",
  "badexample.com",
  "nudity.testcategory.com"
];

export const ADULT_TLDS = ["xxx", "porn", "sex", "adult", "sexy"];

const GOOGLE_SEARCH_DOMAINS = [
  "google.com",
  "google.fr",
  "google.co.uk",
  "google.de",
  "google.es",
  "google.it",
  "google.ca",
  "google.be",
  "google.ch",
  "google.ma",
  "google.dz",
  "google.tn"
];

export function getShieldProvider(providerId = "cleanbrowsing") {
  return SHIELD_PROVIDERS[providerId] || SHIELD_PROVIDERS.cleanbrowsing;
}

export function createDefaultShieldState() {
  return {
    enabled: false,
    provider: "cleanbrowsing",
    safeSearch: true,
    youtubeRestricted: false,
    noReels: true,
    lockUntilMs: null,
    updatedAtMs: 0
  };
}

export function normalizeShieldState(raw) {
  const defaults = createDefaultShieldState();
  if (!raw || typeof raw !== "object") return defaults;
  const provider = SHIELD_PROVIDERS[raw.provider] ? raw.provider : defaults.provider;
  const lockUntilMs =
    typeof raw.lockUntilMs === "number" && Number.isFinite(raw.lockUntilMs) && raw.lockUntilMs > 0
      ? raw.lockUntilMs
      : null;
  const updatedAtMs =
    typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) && raw.updatedAtMs > 0
      ? raw.updatedAtMs
      : 0;
  return {
    enabled: Boolean(raw.enabled),
    provider,
    safeSearch: raw.safeSearch !== false,
    youtubeRestricted: Boolean(raw.youtubeRestricted),
    noReels: raw.noReels !== undefined ? Boolean(raw.noReels) : true,
    lockUntilMs,
    updatedAtMs
  };
}

export function mergeShieldStates(localRaw, remoteRaw) {
  const local = normalizeShieldState(localRaw);
  const remote = normalizeShieldState(remoteRaw);
  if (remote.updatedAtMs > local.updatedAtMs) {
    return { winner: "remote", shield: remote };
  }
  if (local.updatedAtMs > remote.updatedAtMs) {
    return { winner: "local", shield: local };
  }
  return { winner: "equal", shield: local };
}

export function isShieldLocked(shield, nowMs = Date.now()) {
  if (!shield || !shield.enabled) return false;
  return typeof shield.lockUntilMs === "number" && shield.lockUntilMs > nowMs;
}

export function formatShieldLockRemaining(shield, lang = "fr", nowMs = Date.now()) {
  if (!isShieldLocked(shield, nowMs)) return "";
  const remSec = Math.max(0, Math.ceil((shield.lockUntilMs - nowMs) / 1000));
  const days = Math.floor(remSec / 86400);
  const hours = Math.floor((remSec % 86400) / 3600);
  const mins = Math.ceil((remSec % 3600) / 60);

  if (days > 0) {
    return lang === "en" ? `${days}d ${hours}h` : `${days} j ${hours} h`;
  }
  if (hours > 0) {
    return lang === "en" ? `${hours}h ${mins}m` : `${hours} h ${mins} min`;
  }
  return lang === "en" ? `${Math.max(1, mins)}m` : `${Math.max(1, mins)} min`;
}

/**
 * Checks whether a URL matches the offline Adult Shield list or explicit adult TLDs.
 */
export function shouldShieldBlockUrl(rawUrl, shield) {
  if (!shield?.enabled) {
    return { blocked: false, matchedDomain: null };
  }
  const hostname = extractHostname(rawUrl);
  if (!hostname) {
    return { blocked: false, matchedDomain: null };
  }

  for (const domain of CURATED_ADULT_DOMAINS) {
    if (matchesDomain(hostname, domain)) {
      return { blocked: true, matchedDomain: domain };
    }
  }

  const parts = hostname.split(".");
  const tld = parts[parts.length - 1] || "";
  if (ADULT_TLDS.includes(tld)) {
    return { blocked: true, matchedDomain: hostname };
  }

  return { blocked: false, matchedDomain: null };
}

/**
 * Pure evaluator for "Messages-Only Mode" (Zero Reels, Shorts, Posts & TikTok during Focus).
 */
export function evaluateSocialShieldUrl(rawUrl, shield, { focusActive = true } = {}) {
  const s = normalizeShieldState(shield);
  if (!focusActive || !s.enabled || !s.noReels || typeof rawUrl !== "string" || !rawUrl) {
    return { action: "allow", targetUrl: null, platform: null, reason: null };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { action: "allow", targetUrl: null, platform: null, reason: null };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { action: "allow", targetUrl: null, platform: null, reason: null };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || "/";

  if (matchesDomain(host, "messenger.com")) {
    return { action: "allow-dm", targetUrl: null, platform: "messenger", reason: "dm-allowed" };
  }

  if (matchesDomain(host, "instagram.com")) {
    if (/^\/(direct|accounts|challenge|api|static|ajax)(\/|$)/i.test(path)) {
      return { action: "allow-dm", targetUrl: null, platform: "instagram", reason: "dm-allowed" };
    }
    if (/^\/reels?(\/|$)/i.test(path)) {
      return {
        action: "close-reel",
        targetUrl: null,
        platform: "instagram",
        reason: "instagram-reel"
      };
    }
    return {
      action: "redirect-inbox",
      targetUrl: "https://www.instagram.com/direct/inbox/",
      platform: "instagram",
      reason: "instagram-feed-to-dm"
    };
  }

  if (matchesDomain(host, "youtube.com") || matchesDomain(host, "youtu.be")) {
    if (/^\/shorts(\/|$)/i.test(path)) {
      return {
        action: "close-reel",
        targetUrl: null,
        platform: "youtube",
        reason: "youtube-short"
      };
    }
    return { action: "allow", targetUrl: null, platform: "youtube", reason: null };
  }

  if (matchesDomain(host, "facebook.com")) {
    if (/^\/(messages|login|checkpoint|recover)(\/|$)/i.test(path)) {
      return { action: "allow-dm", targetUrl: null, platform: "facebook", reason: "dm-allowed" };
    }
    if (/^\/(reels?|watch|videos|stories)(\/|$)/i.test(path)) {
      return {
        action: "close-reel",
        targetUrl: null,
        platform: "facebook",
        reason: "facebook-reel"
      };
    }
    if (path === "/" || /^\/(home\.php|explore)(\/|$)/i.test(path)) {
      return {
        action: "redirect-inbox",
        targetUrl: "https://www.facebook.com/messages/",
        platform: "facebook",
        reason: "facebook-feed-to-dm"
      };
    }
    return { action: "allow", targetUrl: null, platform: "facebook", reason: null };
  }

  if (matchesDomain(host, "tiktok.com")) {
    return {
      action: "close-reel",
      targetUrl: null,
      platform: "tiktok",
      reason: "tiktok-reel"
    };
  }

  return { action: "allow", targetUrl: null, platform: null, reason: null };
}

/**
 * Builds Chrome MV3 declarativeNetRequest rules for the 24/7 Adult Shield.
 */
export function buildShieldRules({ shield, extensionId, focusActive = true } = {}) {
  const normalized = normalizeShieldState(shield);
  if (!normalized.enabled || !extensionId) {
    return [];
  }

  const redirectTarget = `chrome-extension://${extensionId}/src/blocked.html?reason=shield#\\0`;
  const rules = [
    {
      id: 10001,
      priority: 3,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: redirectTarget }
      },
      condition: {
        regexFilter: "^https?://.*$",
        requestDomains: CURATED_ADULT_DOMAINS,
        resourceTypes: ["main_frame"]
      }
    },
    {
      id: 10002,
      priority: 3,
      action: { type: "block" },
      condition: {
        requestDomains: CURATED_ADULT_DOMAINS,
        resourceTypes: ["sub_frame"]
      }
    },
    {
      id: 10010,
      priority: 3,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: redirectTarget }
      },
      condition: {
        regexFilter: "^https?://[^/]+\\.(xxx|porn|sex|adult|sexy)(/.*|\\?.*)?$",
        resourceTypes: ["main_frame"]
      }
    }
  ];

  if (normalized.safeSearch) {
    rules.push(
      {
        id: 11001,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "safe", value: "active" }] }
            }
          }
        },
        condition: {
          urlFilter: "/search?",
          requestDomains: GOOGLE_SEARCH_DOMAINS,
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11002,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "adlt", value: "strict" }] }
            }
          }
        },
        condition: {
          urlFilter: "||bing.com/",
          requestDomains: ["bing.com"],
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11003,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "kp", value: "1" }] }
            }
          }
        },
        condition: {
          urlFilter: "||duckduckgo.com/?",
          requestDomains: ["duckduckgo.com"],
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11004,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "vm", value: "r" }] }
            }
          }
        },
        condition: {
          urlFilter: "/search",
          requestDomains: ["search.yahoo.com"],
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11005,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "safesearch", value: "2" }] }
            }
          }
        },
        condition: {
          urlFilter: "||qwant.com/?",
          requestDomains: ["qwant.com"],
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11006,
        priority: 3,
        action: {
          type: "redirect",
          redirect: {
            transform: {
              queryTransform: { addOrReplaceParams: [{ key: "safesearch", value: "2" }] }
            }
          }
        },
        condition: {
          urlFilter: "/search",
          requestDomains: ["ecosia.org"],
          resourceTypes: ["main_frame"]
        }
      }
    );
  }

  if (normalized.youtubeRestricted) {
    rules.push({
      id: 11101,
      priority: 3,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "YouTube-Restrict", operation: "set", value: "Strict" }]
      },
      condition: {
        requestDomains: [
          "youtube.com",
          "m.youtube.com",
          "www.youtube.com",
          "youtubei.googleapis.com"
        ],
        resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
      }
    });
  }

  if (normalized.noReels && focusActive) {
    const reelRedirectTarget = `chrome-extension://${extensionId}/src/blocked.html?reason=reels#\\0`;
    rules.push(
      {
        id: 11201,
        priority: 3,
        action: { type: "allow" },
        condition: {
          regexFilter:
            "^https?://([a-z0-9-]+\\.)?(instagram\\.com/(direct|accounts|challenge)|facebook\\.com/messages|messenger\\.com)(/.*|\\?.*)?$",
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11202,
        priority: 3,
        action: {
          type: "redirect",
          redirect: { regexSubstitution: reelRedirectTarget }
        },
        condition: {
          regexFilter:
            "^https?://([a-z0-9-]+\\.)?(instagram\\.com/reels?(/|\\?|$)|youtube\\.com/shorts(/|\\?|$)|facebook\\.com/(reels?|watch|videos|stories)(/|\\?|$)|tiktok\\.com(/|\\?|$))",
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11203,
        priority: 3,
        action: {
          type: "redirect",
          redirect: { url: "https://www.instagram.com/direct/inbox/" }
        },
        condition: {
          regexFilter:
            "^https?://([a-z0-9-]+\\.)?instagram\\.com(/(\\?.*)?$|/(explore|p|stories|tv)(/.*|\\?.*)?$)",
          resourceTypes: ["main_frame"]
        }
      },
      {
        id: 11204,
        priority: 3,
        action: {
          type: "redirect",
          redirect: { url: "https://www.facebook.com/messages/" }
        },
        condition: {
          regexFilter: "^https?://([a-z0-9-]+\\.)?facebook\\.com(/(\\?.*)?$|/home\\.php(\\?.*)?$)",
          resourceTypes: ["main_frame"]
        }
      }
    );
  }

  return rules;
}

/**
 * Generates a pure Apple iOS 14+ / iPadOS encrypted Anti-Porn DNS (.mobileconfig) profile
 * so iPhone users can block adult content system-wide without any app or account.
 *
 * @param {string} [providerId]
 * @returns {string}
 */
export function buildIosMobileConfig(providerId = "cleanbrowsing") {
  const p = getShieldProvider(providerId);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key>
        <string>HTTPS</string>
        <key>ServerURL</key>
        <string>${p.dohUrl}</string>
      </dict>
      <key>OnDemandRules</key>
      <array>
        <dict>
          <key>Action</key>
          <string>Connect</string>
        </dict>
      </array>
      <key>PayloadDescription</key>
      <string>Encrypted Family DNS (${p.name}) blocking adult content across all networks</string>
      <key>PayloadDisplayName</key>
      <string>Dhirna DNS — ${p.name}</string>
      <key>PayloadIdentifier</key>
      <string>com.dhirna.shield.dns.${p.id}</string>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key>
      <string>${p.payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Blocks adult sites across Safari and all apps via ${p.name}.</string>
  <key>PayloadDisplayName</key>
  <string>Dhirna Bouclier — ${p.name}</string>
  <key>PayloadIdentifier</key>
  <string>com.dhirna.shield.profile.${p.id}</string>
  <key>PayloadOrganization</key>
  <string>Dhirna</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${p.profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
