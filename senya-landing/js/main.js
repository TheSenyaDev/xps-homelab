// Entry point. The page's markup is assembled first from the HTML components in
// /components (see js/page.js) — every init below expects its container to
// already be in the document. Bookmarks, the launcher rail, and System/Weather
// are fixed page chrome (initialised directly, not through the registry); the
// dashboard grid is built from js/registry.js by the layout manager.

import { renderPage } from "./page.js";
import { applyAll as applyScales } from "./ui-scale.js";
import { initClock } from "./sections/clock.js";
import { initSearch } from "./sections/search.js";
import { initBookmarks } from "./sections/bookmarks.js";
import { initRail } from "./rail.js";
import { initSystem } from "./sections/system.js";
import { initWeather } from "./sections/weather.js";
import { initLayout, initInfoPane } from "./layout.js";
import { initSettings } from "./settings.js";
import { internal } from "./config.js";

function run(name, fn) {
  try { fn(); } catch (e) { console.error(`[senya] "${name}" failed:`, e); }
}

applyScales();    // before the page is built, so nothing paints at the wrong size
await renderPage();

run("clock", initClock);
run("search", initSearch);
run("bookmarks", initBookmarks);
run("rail", initRail);
if (internal) {
  run("system", initSystem);
  run("info-pane", initInfoPane);
} else {
  document.getElementById("system")?.closest(".info-block")?.remove();
}
run("weather", initWeather);
run("layout", initLayout);
run("settings", initSettings);
