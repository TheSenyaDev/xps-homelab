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
    // Across markets only the canonical orderings mean anything — a
    // site-specific key like eBay's price+shipping has no Facebook equivalent.
    // Per-market sorts and options are set on a saved profile instead.
    setSorts([
      { key: "best", label: "Best match" },
      { key: "price-asc", label: "Cheapest" },
      { key: "price-desc", label: "Dearest" },
      { key: "newest", label: "Newly listed" },
    ]);
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
  setSorts(site.sorts || []);
  $("sort").disabled = !sup.sort;
  $("condition").disabled = !sup.condition;
  $("min_price").disabled = $("max_price").disabled = !sup.price_range;

  const cats = site.categories || [];
  $("category").hidden = !cats.length;
  $("category").replaceChildren(
    ...cats.map((c) => el("option", { value: c.key, text: c.label })));

  renderOptions($("site-opts"), site);
}

// Preserves the current choice across a market change when that market offers
// the same ordering, so switching sites does not silently reset you to Best.
function setSorts(sorts) {
  const previous = $("sort").value;
  $("sort").replaceChildren(
    ...sorts.map((s) => el("option", { value: s.key, text: s.label })));
  if (sorts.some((s) => s.key === previous)) $("sort").value = previous;
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
