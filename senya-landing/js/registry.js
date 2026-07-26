// Section registry — Daily is the only default dashboard widget; everything
// else (bookmarks, launchers/services, System, Weather) is fixed page chrome
// initialised directly from main.js, not through this list.
//
// To add a new dashboard widget (RSS, stocks, …): write js/sections/foo.js
// exporting initFoo() that populates the element with id `bodyId`, add one
// entry below. It shows up in the dashboard grid and the Customize panel
// automatically — nothing else to touch.

import { internal } from "./config.js";
import { initDaily } from "./sections/daily.js";

export const SECTIONS = [
  {
    id: "daily", title: "Daily", hint: "today", bodyId: "daily", bodyClass: "daily",
    init: initDaily, available: () => !!internal,
  },
];
