// The top bar: live search, and the controls that depend on the chosen market.
//
// A live search persists nothing, so it has no blocklist and no saved-search
// context — that is the sidebar's job.

import { $, el } from "../core/dom.js";
import { api } from "../core/api.js";
import { getSites, setCurrentSearch, setLastRun, siteByKey } from "../core/state.js";
import { renderOptions, readOptions } from "./site-options.js";
import { clearResults, render, setStatus, statusLine } from "./results.js";

export function formPayload() {
  return {
    query: $("q").value.trim(),
    sites: $("site").value === "all" ? "all" : [$("site").value],
    category: $("category").value,
    sort: $("sort").value,
    condition: $("condition").value,
    min_price: $("min_price").value || null,
    max_price: $("max_price").value || null,
    params: readOptions($("site-opts")),
  };
}

// Markets advertise what they can filter by, so a market without price
// filtering shows a disabled box rather than a control that quietly does
// nothing. Driven entirely by /api/sites.
export function applySiteCapabilities() {
  const key = $("site").value;

  if (key === "all") {
    // Only the filters every market honours make sense across all of them;
    // per-market options are configured on a saved profile instead.
    $("sort").disabled = false;
    $("condition").disabled = false;
    $("min_price").disabled = $("max_price").disabled = false;
    $("category").hidden = true;
    renderOptions($("site-opts"), null);
    return;
  }

  const site = siteByKey(key);
  if (!site) return;
  const sup = site.supports || {};
  $("sort").disabled = !sup.sort;
  $("condition").disabled = !sup.condition;
  $("min_price").disabled = $("max_price").disabled = !sup.price_range;

  const cats = site.categories || [];
  $("category").hidden = !cats.length;
  $("category").replaceChildren(
    ...cats.map((c) => el("option", { value: c.key, text: c.label })));

  renderOptions($("site-opts"), site);
}

export function populateSitePicker() {
  const options = [{ key: "all", label: "All markets" }, ...getSites()];
  $("site").replaceChildren(
    ...options.map((s) => el("option", { value: s.key, text: s.label })));
  applySiteCapabilities();
}

async function submit(e) {
  e.preventDefault();
  const payload = formPayload();
  if (!payload.query) return;

  // A live search has no profile, so nothing here belongs to a saved run.
  setCurrentSearch(null);
  setLastRun(null);
  clearResults();
  setStatus("searching…");

  try {
    const data = await api.search(payload);
    setStatus(statusLine(data));
    render(data.results);
  } catch (err) {
    setStatus(err.message, true);
  }
}

export function init() {
  $("search-form").addEventListener("submit", submit);
  $("site").addEventListener("change", applySiteCapabilities);
}
