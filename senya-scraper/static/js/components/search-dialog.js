// Create / edit a saved search. One form for both — `editing` decides whether
// SAVE posts a new profile or patches an existing one.
//
// Markets, per-market options and per-market blocklists are all rebuilt when
// the market selection changes, and each market's values are remembered so
// unticking and re-ticking one does not discard its configuration.

import { $, el, safeJson, safeList } from "../core/dom.js";
import { api } from "../core/api.js";
import { emit } from "../core/bus.js";
import { openModal } from "../core/modal.js";
import { getSites, siteByKey } from "../core/state.js";
import { renderOptions, readOptions } from "./site-options.js";

let dlg;
let editing = null;       // the row being edited, or null when creating
let editingParams = {};   // {site: {option: value}}
let editingBlocked = {};  // {site: [names]} — blocklists are per marketplace

export function open(row = null, prefill = null) {
  editing = row;
  editingParams = row ? safeJson(row.params, {}) : {};
  editingBlocked = row ? safeJson(row.blocked_sellers, {}) : {};
  if (Array.isArray(editingBlocked)) editingBlocked = {};   // legacy flat list

  $("dlg-title").textContent = row ? "EDIT SEARCH" : "NEW SEARCH";
  $("dlg-err").hidden = true;

  const src = row || prefill || {};
  let chosen = row ? safeList(row.sites) : (Array.isArray(src.sites) ? src.sites : []);
  if (!chosen.length) chosen = [src.site || getSites()[0]?.key].filter(Boolean);
  if (chosen.includes("all")) chosen = getSites().map((s) => s.key);

  $("f-name").value = row ? row.name : "";
  $("f-query").value = src.query || "";
  $("f-condition").value = src.condition || "any";
  $("f-sort").value = src.sort || "best";
  $("f-min").value = src.min_price ?? "";
  $("f-max").value = src.max_price ?? "";
  $("f-notify").checked = row ? !!row.notify : true;

  renderSitePicker(chosen);
  sync(src.category || "", prefill?.params);
  openModal(dlg);
  $("f-query").focus();
}

function renderSitePicker(chosen) {
  $("f-sites").replaceChildren(...getSites().map((site) => {
    const cb = el("input", { type: "checkbox", value: site.key });
    cb.checked = chosen.includes(site.key);
    cb.dataset.siteKey = site.key;
    cb.addEventListener("change", () => {
      // Remember what was configured for the market being unticked, so
      // re-ticking it restores rather than resets.
      stash();
      if (!chosenSites().length) cb.checked = true;   // never leave it empty
      sync();
    });
    return el("label", { class: "opt opt-bool" }, cb, el("span", { text: site.label }));
  }));
}

const chosenSites = () =>
  [...$("f-sites").querySelectorAll("input:checked")].map((c) => c.dataset.siteKey);

/** Capture the currently rendered per-market values before re-rendering. */
function stash() {
  Object.assign(editingParams, readAllOptions());
  Object.assign(editingBlocked, readBlocked(true));
}

// Category, per-market options and blocklists all depend on the chosen markets,
// so they are rebuilt together.
function sync(category = "", overrideParams = null) {
  const keys = chosenSites();
  const first = siteByKey(keys[0]);

  const cats = first?.categories || [];
  $("f-category-row").hidden = !cats.length;
  $("f-category").replaceChildren(
    ...cats.map((c) => el("option", { value: c.key, text: c.label })));
  if (category) $("f-category").value = category;

  // One options block per chosen market that declares any.
  const host = $("f-opts");
  host.replaceChildren();
  let anyOptions = false;
  for (const key of keys) {
    const site = siteByKey(key);
    if (!site?.options?.length) continue;
    anyOptions = true;
    const body = el("div");
    renderOptions(body, site, overrideParams || editingParams[key] || {});
    host.append(el("div", { class: "opt-block", dataset: { siteKey: key } },
      el("div", { class: "opt-block-head", text: site.label }), body));
  }
  $("f-opts-wrap").hidden = !anyOptions;
  $("f-opts-legend").textContent = "Per-market options";

  renderBlockedFields(keys);
}

// One blocklist box per chosen market that exposes sellers. A market without
// seller data gets no box rather than a box that cannot work.
function renderBlockedFields(keys) {
  const host = $("f-blocked");
  host.replaceChildren();
  let any = false;
  for (const key of keys) {
    const site = siteByKey(key);
    if (!site || site.supports?.seller === false) continue;
    any = true;
    const ta = el("textarea", { rows: 2, placeholder: "one per line, or comma-separated" });
    ta.value = (editingBlocked[key] || []).join("\n");
    ta.dataset.blockedSite = key;
    host.append(el("label", { class: "blocked-row" },
      el("span", { text: site.label }), ta));
  }
  $("f-blocked-wrap").hidden = !any;
}

function readAllOptions() {
  const out = {};
  for (const block of $("f-opts").querySelectorAll(".opt-block")) {
    out[block.dataset.siteKey] = readOptions(block);
  }
  return out;
}

/** @param asLists split textareas into arrays, for stashing between renders */
function readBlocked(asLists = false) {
  const out = {};
  for (const ta of $("f-blocked").querySelectorAll("[data-blocked-site]")) {
    const key = ta.dataset.blockedSite;
    out[key] = asLists
      ? ta.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      : ta.value;
  }
  return out;
}

async function submit(e) {
  e.preventDefault();
  const payload = {
    name: $("f-name").value.trim(),
    sites: chosenSites(),
    query: $("f-query").value.trim(),
    category: $("f-category").value,
    condition: $("f-condition").value,
    sort: $("f-sort").value,
    min_price: $("f-min").value || null,
    max_price: $("f-max").value || null,
    notify: $("f-notify").checked,
    params: readAllOptions(),
    blocked_sellers: readBlocked(),
  };
  try {
    if (editing) await api.searches.update(editing.id, payload);
    else await api.searches.create(payload);
    dlg.close();
    emit("saved:changed", { created: !editing });
  } catch (err) {
    $("dlg-err").textContent = err.message;
    $("dlg-err").hidden = false;
  }
}

export function init() {
  dlg = $("dlg");
  $("dlg-cancel").addEventListener("click", () => dlg.close());
  $("dlg-form").addEventListener("submit", submit);
  // No closeOnBackdrop here on purpose: dismissing a form on a stray click
  // would discard what was typed.
}
