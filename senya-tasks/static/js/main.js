// Entry point: load the data once, initialise each component, then draw.
//
// Components never import each other in a cycle. The ones that must talk
// across — a row patching a task, which reloads and redraws every view — go
// through core/bus.js; view.js is the only module that knows all the views
// exist. See core/bus.js for why.

import { reload } from "./core/actions.js";
import { $ } from "./core/dom.js";
import * as importer from "./components/import.js";
import * as prefs from "./components/prefs.js";
import * as sync from "./components/sync.js";
import * as toolbar from "./components/toolbar.js";
import { setView } from "./view.js";
import { prefs as viewPrefs } from "./core/state.js";

async function boot() {
  // Wired before the first draw so nothing can be clicked into a half-set-up
  // handler, and so `data:changed` listeners are registered before it fires.
  for (const c of [toolbar, prefs, importer, sync]) c.init?.();

  await reload();          // emits data:changed → view.js renders everything
  setView(viewPrefs.view); // restores list/calendar and draws the right one
  sync.refreshSyncStatus?.();
  $("task-title")?.focus();
}

boot();
