// Crypto prices from CoinGecko's free API — no key, CORS-enabled, so it's
// fetched directly (the CSP allows https://api.coingecko.com, same arrangement
// as the weather API). Which coins to show: CRYPTO_COINS in js/config.js.
//
// One row per coin: symbol + name, price, 24h change, market cap. Rows are
// ordered by market cap, and the 24h column is coloured by sign — with the sign
// printed too, so the colour is never carrying the meaning alone.

import { CRYPTO_COINS, CRYPTO_VS } from "../config.js";
import { el, fetchJSON } from "../utils.js";

const REFRESH_MS = 60 * 1000; // free tier is rate-limited; once a minute is plenty

const CURRENCY = { usd: "$", cad: "$", eur: "€", gbp: "£" };

// Crypto spans nine orders of magnitude — $0.000018 to $120,000 — so the number
// of decimals follows the size rather than being fixed.
function fmtPrice(v, vs) {
  const sym = CURRENCY[vs] || "";
  if (!Number.isFinite(v)) return "—";
  const digits = v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return sym + v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtCap(v) {
  if (!Number.isFinite(v)) return "—";
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
  for (const [size, suffix] of units) {
    if (v >= size) return (v / size).toFixed(v / size >= 100 ? 0 : 1) + suffix;
  }
  return String(Math.round(v));
}

function row(c, vs) {
  const chg = c.price_change_percentage_24h;
  const dir = !Number.isFinite(chg) ? "flat" : chg > 0 ? "up" : chg < 0 ? "down" : "flat";
  return el("a", {
    class: "cx-row", href: `https://www.coingecko.com/en/coins/${c.id}`,
    target: "_blank", rel: "noopener noreferrer", title: `${c.name} · market cap ${fmtCap(c.market_cap)}`,
  },
    el("span", { class: "cx-sym", text: (c.symbol || "").toUpperCase() }),
    el("span", { class: "cx-name", text: c.name }),
    el("span", { class: "cx-price", text: fmtPrice(c.current_price, vs) }),
    el("span", { class: `cx-chg cx-${dir}`, text: Number.isFinite(chg) ? `${chg > 0 ? "+" : ""}${chg.toFixed(1)}%` : "—" }),
    el("span", { class: "cx-cap", text: fmtCap(c.market_cap) }));
}

export function initCrypto() {
  const wrap = document.getElementById("crypto");
  if (!wrap) return;
  const vs = (CRYPTO_VS || "usd").toLowerCase();

  const url = "https://api.coingecko.com/api/v3/coins/markets?" + new URLSearchParams({
    vs_currency: vs,
    ids: CRYPTO_COINS.join(","),
    order: "market_cap_desc",
    per_page: String(CRYPTO_COINS.length),
    page: "1",
    price_change_percentage: "24h",
  });

  async function load() {
    try {
      const coins = await fetchJSON(url);
      if (!Array.isArray(coins) || !coins.length) throw new Error("no coins returned");
      wrap.replaceChildren(
        el("div", { class: "cx-head" },
          el("span", { class: "cx-sym", text: "Coin" }),
          el("span", { class: "cx-name", text: "" }),
          el("span", { class: "cx-price", text: vs.toUpperCase() }),
          el("span", { class: "cx-chg", text: "24h" }),
          el("span", { class: "cx-cap", text: "Cap" })),
        ...coins.map((c) => row(c, vs)));
    } catch (e) {
      console.error("[senya] crypto load failed:", e);
      wrap.replaceChildren(el("div", { class: "offline-msg", text: "Crypto prices unavailable" }));
    }
  }

  wrap.replaceChildren(el("div", { class: "offline-msg", text: "Loading prices…" }));
  load();
  setInterval(load, REFRESH_MS);
}
