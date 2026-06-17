// Section registry — the single declarative source of truth for the dashboard.
// Each entry describes a section's shell (heading + body container) and wires it
// to its init function and an availability predicate. The layout manager
// (layout.js) builds shells from this in the user's saved order; the settings
// panel (settings.js) lists these to toggle/reorder them.
//
// Add a section: write js/sections/foo.js exporting initFoo() that populates the
// element with id `bodyId`, then add one entry here. Nothing else to touch —
// no markup, no main.js edits, and it shows up in the customize panel.

import { BOOKMARKS, PUBLIC_LINKS, WEATHER_LOCATIONS, internal } from "./config.js";
import { initWeather } from "./sections/weather.js";
import { initSystem } from "./sections/system.js";
import { initDaily } from "./sections/daily.js";
import { initPublic } from "./sections/public.js";
import { initBookmarks } from "./sections/bookmarks.js";
import { initSenyaApps, initServices } from "./sections/services.js";

const has = (arr) => Array.isArray(arr) && arr.length > 0;

// Default order — overridden per-user by saved preferences (layout.js). Fields:
//   id          stable key (used in storage + as data-section)
//   title       heading text
//   hint        muted suffix in the heading (optional)
//   bodyId      id of the inner container the init function populates
//   bodyClass   class on that container (drives the section's grid/layout)
//   headerExtra optional extra element appended to the heading (e.g. weather's
//               location pills) — { id, class }
//   init        the section's init function (run once, when first shown)
//   available   predicate; false → section excluded from layout + customize list
export const SECTIONS = [
  {
    id: "weather", title: "Weather", bodyId: "weather", bodyClass: "weather",
    headerExtra: { id: "weather-locs", class: "weather-locs" },
    init: initWeather, available: () => has(WEATHER_LOCATIONS),
  },
  {
    id: "system", title: "System", hint: "· live", bodyId: "system", bodyClass: "system",
    init: initSystem, available: () => !!(internal && has(internal.HOSTS)),
  },
  {
    id: "daily", title: "Daily", hint: "· today", bodyId: "daily", bodyClass: "daily",
    init: initDaily, available: () => !!internal,
  },
  {
    id: "public", title: "Public", hint: "· senya.ca", bodyId: "public", bodyClass: "grid",
    init: initPublic, available: () => has(PUBLIC_LINKS),
  },
  {
    id: "bookmarks", title: "Bookmarks", bodyId: "bookmarks", bodyClass: "grid",
    init: initBookmarks, available: () => has(BOOKMARKS),
  },
  {
    id: "senya", title: "Senya Apps", hint: "· built in-house", bodyId: "senya-apps", bodyClass: "services",
    init: initSenyaApps, available: () => !!(internal && has(internal.SENYA_APPS)),
  },
  {
    id: "services", title: "Services", hint: "· local / tailscale", bodyId: "services", bodyClass: "services",
    init: initServices, available: () => !!(internal && has(internal.SERVICES)),
  },
];
