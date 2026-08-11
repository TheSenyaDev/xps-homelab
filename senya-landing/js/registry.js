// Section registry — the dashboard widgets. Fixed page chrome (bookmarks,
// launchers, System, the weather chip) is initialised directly from main.js and
// isn't listed here.
//
// To add a new dashboard widget (RSS, stocks, …): write js/sections/foo.js
// exporting initFoo() that populates the element with id `bodyId`, add one
// entry below. It shows up in the dashboard grid and the Customize panel
// automatically — nothing else to touch.
//
// Optional per-widget config, rendered by the Customize drawer:
//   settings        an array of {key, label, type, default, …}, or a function
//                   returning one (use a function when the choices come from an
//                   API, as the Tasks categories do). Types: select · multi ·
//                   number · text.
//   onConfigChange  called with the new config when a setting changes; a widget
//                   that declares settings needs this or it will not refresh.
// Size (width in columns, height in rows) is offered for every widget without
// being declared.

import { internal } from "./config.js";
import { initDaily } from "./sections/daily.js";
import { initTasks, onTasksConfigChange, tasksSettings } from "./sections/tasks.js";
import { initMarket } from "./sections/market.js";
import { initCrypto } from "./sections/crypto.js";

export const SECTIONS = [
  {
    id: "daily", title: "Daily", hint: "today", bodyId: "daily", bodyClass: "daily",
    init: initDaily, available: () => !!internal,
  },
  {
    id: "tasks", title: "Tasks", hint: "open", bodyId: "tasks", bodyClass: "tasks",
    init: initTasks, available: () => !!internal,
    // Resolved when the widget is expanded in Customize — the category list
    // comes from the API, so it must be fetched rather than declared.
    settings: tasksSettings, onConfigChange: onTasksConfigChange,
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
