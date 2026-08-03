// ============================================================
//  PUBLIC-SAFE config — served to everyone. NO internal IPs here;
//  those live in /services.js (window.SENYA_INTERNAL), which nginx
//  serves only to LAN / Tailscale clients.
// ============================================================

// `icon` = filename (without .png) in /icons. Missing → _default.svg fallback.
export const BOOKMARKS = [
  { name: "Proton Mail", url: "https://mail.proton.me", icon: "proton-mail" },
  { name: "GitHub", url: "https://github.com", icon: "github-light" },
  { name: "Claude", url: "https://claude.ai", icon: "claude-ai" },
  { name: "ChatGPT", url: "https://chat.openai.com", icon: "openai" },
  { name: "YouTube", url: "https://youtube.com", icon: "youtube" },
  { name: "Reddit", url: "https://reddit.com", icon: "reddit" },
  { name: "Cloudflare", url: "https://dash.cloudflare.com", icon: "cloudflare" },
  { name: "Tailscale", url: "https://login.tailscale.com/admin", icon: "tailscale" },
  { name: "Wikipedia", url: "https://wikipedia.org", icon: "wikipedia" },
  { name: "Hacker News", url: "https://news.ycombinator.com", icon: "hacker-news" },
];

// Weather locations (public-safe). First entry is the default. Look up a city's
// coordinates at https://open-meteo.com (or just search "<city> lat long").
export const WEATHER_LOCATIONS = [
  { name: "Toronto", lat: 43.6532, lon: -79.3832 },
  { name: "Montreal", lat: 45.5019, lon: -73.5674 },
  { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
];

// Crypto widget: CoinGecko coin ids (the slug in coingecko.com/en/coins/<id>),
// shown ordered by market cap. `CRYPTO_VS` is the quote currency.
export const CRYPTO_COINS = [
  "bitcoin", "ethereum", "solana", "ripple", "cardano", "chainlink", "dogecoin", "monero",
];
export const CRYPTO_VS = "usd";

// Publicly reachable subdomains (Cloudflare tunnel). Public-safe → shown on and
// off network. Add an entry here when you expose a new service at <x>.senya.ca.
export const PUBLIC_LINKS = [
  { name: "Home", url: "https://home.senya.ca", icon: "homepage" },
  { name: "Glances", url: "https://glances.senya.ca", icon: "glances" },
  { name: "Authelia", url: "https://auth.senya.ca", icon: "authelia" },
  { name: "whoami", url: "https://whoami.senya.ca", icon: "traefik" },
];

// Internal config from /services.js — present only on LAN / Tailscale.
export const internal = window.SENYA_INTERNAL || null;

// SearXNG sits on the same host as this page, but that host answers on both a
// LAN and a Tailscale address — and only one of them is reachable at a time.
// Send the search to whichever address the page itself was loaded from, so a
// search off-network doesn't land on an unreachable 192.168.x URL. For any
// other hostname (MagicDNS name, localhost) reuse it as-is, keeping the port
// and path from the configured URL.
function searxngUrl() {
  if (!internal?.SEARXNG) return null;
  const here = location.hostname;
  if (here === internal.LOCAL_IP) return internal.SEARXNG;
  if (here === internal.TAILSCALE_IP) return internal.SEARXNG_TS || internal.SEARXNG;
  try {
    const u = new URL(internal.SEARXNG);
    u.hostname = here;
    return u.href;
  } catch {
    return internal.SEARXNG;
  }
}

const searxng = searxngUrl();

export const SEARCH_ENGINES = {
  google: "https://www.google.com/search?q=",
  ...(searxng ? { searxng } : {}),
};
