// Entry point. The header bits (clock, search) are fixed; the dashboard sections
// are built from the registry by the layout manager, each section's init() run
// in isolation so one failing piece never blanks the rest of the page.

import { initClock } from "./sections/clock.js";
import { initSearch } from "./sections/search.js";
import { initLayout } from "./layout.js";
import { initSettings } from "./settings.js";

function run(name, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`[senya] "${name}" failed:`, e);
  }
}

run("clock", initClock);
run("search", initSearch);
run("layout", initLayout); // builds dashboard sections + runs their inits
run("settings", initSettings);
