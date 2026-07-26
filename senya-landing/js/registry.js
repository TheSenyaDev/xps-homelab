// Section registry — the dashboard widgets. Fixed page chrome (bookmarks,
// launchers, System, the weather chip) is initialised directly from main.js and
// isn't listed here.
//
// To add a new dashboard widget (RSS, stocks, …): write js/sections/foo.js
// exporting initFoo() that populates the element with id `bodyId`, add one
// entry below. It shows up in the dashboard grid and the Customize panel
// automatically — nothing else to touch.

import { internal } from "./config.js";
import { initDaily } from "./sections/daily.js";
import { initMarket } from "./sections/market.js";
import { initCrypto } from "./sections/crypto.js";

export const SECTIONS = [
  {
    id: "daily", title: "Daily", hint: "today", bodyId: "daily", bodyClass: "daily",
    init: initDaily, available: () => !!internal,
  },
  {
    id: "market", title: "Market Map", hint: "S&P 500 · finviz", bodyId: "market", bodyClass: "market",
    init: initMarket, available: () => true, wide: true,
  },
  {
    id: "crypto", title: "Crypto", hint: "CoinGecko", bodyId: "crypto", bodyClass: "crypto",
    init: initCrypto, available: () => true,
  },
];
