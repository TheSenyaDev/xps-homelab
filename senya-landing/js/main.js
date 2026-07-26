// Entry point. Bookmarks, the launcher rail, and System/Weather are fixed page
// chrome (initialised directly, not through the registry); the dashboard grid
// is built from js/registry.js by the layout manager.

import { initClock } from "./sections/clock.js";
import { initSearch } from "./sections/search.js";
import { initBookmarks } from "./sections/bookmarks.js";
import { initRail } from "./rail.js";
import { initSystem } from "./sections/system.js";
import { initWeather } from "./sections/weather.js";
import { initLayout } from "./layout.js";
import { initSettings } from "./settings.js";
import { internal } from "./config.js";

function run(name, fn) {
  try { fn(); } catch (e) { console.error(`[senya] "${name}" failed:`, e); }
}

run("clock", initClock);
run("search", initSearch);
run("bookmarks", initBookmarks);
run("rail", initRail);
if (internal) run("system", initSystem); else document.getElementById("system")?.closest(".info-block")?.remove();
run("weather", initWeather);
run("layout", initLayout);
run("settings", initSettings);
