// Entry point: load what every component needs, then wire them up.
//
// Components never import each other in a cycle — the ones that must talk
// across (a card opening the item panel, the panel blocking a seller) go
// through core/bus.js. See that file for why.

import { $ } from "./core/dom.js";
import { api } from "./core/api.js";
import { on } from "./core/bus.js";
import { setSites } from "./core/state.js";

import * as itemPanel from "./components/item-panel.js";
import * as results from "./components/results.js";
import * as savedList from "./components/saved-list.js";
import * as searchBar from "./components/search-bar.js";
import * as searchDialog from "./components/search-dialog.js";
import * as settings from "./components/settings.js";

async function boot() {
  // Loaded first: the site list drives the market pickers, the capability flags
  // and the per-market option controls, so nothing can render before it.
  setSites(await api.sites().catch(() => []));

  for (const c of [results, searchBar, savedList, searchDialog, itemPanel, settings]) {
    c.init();
  }

  // SAVE in the bar opens the profile dialog prefilled from the live search —
  // wired here rather than inside either component so neither has to import
  // the other.
  $("save").addEventListener("click", () =>
    searchDialog.open(null, searchBar.formPayload()));

  // Toggling a market in Settings changes what the pickers should offer.
  on("sites:changed", () => searchBar.populateSitePicker());

  searchBar.populateSitePicker();
  await savedList.load();
  $("q").focus();
}

boot();
