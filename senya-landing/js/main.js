// Entry point. Wires up every section. Each section runs in isolation so one
// failing piece (e.g. weather can't reach the API) never blanks the rest of the
// page — the old single-file app halted everything after the first throw.

import { initViews } from "./views.js";
import { initClock } from "./sections/clock.js";
import { initSearch } from "./sections/search.js";
import { initBookmarks } from "./sections/bookmarks.js";
import { initPublic } from "./sections/public.js";
import { initWeather } from "./sections/weather.js";
import { initSystem } from "./sections/system.js";
import { initServices } from "./sections/services.js";

function run(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`[senya] section "${name}" failed:`, e);
  }
}

run("views", initViews);
run("clock", initClock);
run("search", initSearch);
run("bookmarks", initBookmarks);
run("public", initPublic);
run("weather", initWeather);
run("system", initSystem);
run("services", initServices);
