// Create / edit a saved search, in two views over the same profile.
//
// FORM — name, query and price apply to every market; everything else is per
// market, chosen with a dropdown, because markets disagree about what exists.
// eBay separates "cheapest" from "cheapest + shipping" and has "ending
// soonest"; Facebook has neither, and no condition filter at all. A shared set
// of controls could only ever offer the intersection.
//
// TEXT — the profile as the JSON actually stored, verifiable before saving. A
// nested structure is faster to review and bulk-edit as text than through a
// form, and VERIFY runs the same validation the form does, so the two cannot
// disagree.

import { $, el, safeJson, safeList } from "../core/dom.js";
import { api } from "../core/api.js";
import { emit } from "../core/bus.js";
import { openModal } from "../core/modal.js";
import { getSites, siteByKey } from "../core/state.js";
import { renderOptions, readOptions } from "./site-options.js";

let dlg;
let editing = null;
let market = null;        // which market's criteria are on screen
let criteria = {};        // {site: {sort, condition, category}}
let params = {};          // {site: {option: value}}
let blocked = {};         // {site: [names]}

const CONDITIONS = [["any", "Any"], ["new", "New"], ["used", "Used"]];

export function open(row = null, prefill = null) {
  editing = row;
  criteria = row ? safeJson(row.criteria, {}) : {};
  params = row ? safeJson(row.params, {}) : (prefill?.params || {});
  blocked = row ? safeJson(row.blocked_sellers, {}) : {};
  if (Array.isArray(blocked)) blocked = {};       // legacy flat list

  $("dlg-title").textContent = row ? "EDIT SEARCH" : "NEW SEARCH";
  $("dlg-err").hidden = true;
  showTab("form");

  const src = row || prefill || {};
  let chosen = row ? safeList(row.sites) : (Array.isArray(src.sites) ? src.sites : []);
  if (!chosen.length) chosen = [src.site || getSites()[0]?.key].filter(Boolean);
  if (chosen.includes("all")) chosen = getSites().map((s) => s.key);

  $("f-name").value = row ? row.name : "";
  $("f-query").value = src.query || "";
  $("f-min").value = src.min_price ?? "";
  $("f-max").value = src.max_price ?? "";
  $("f-notify").checked = row ? !!row.notify : true;

  renderMarketPicker(chosen);
  // A live search being turned into a profile carries one sort for its market.
  if (prefill?.sort && chosen.length === 1) {
    criteria[chosen[0]] = { ...(criteria[chosen[0]] || {}), sort: prefill.sort,
                            condition: prefill.condition, category: prefill.category };
  }
  market = chosen[0];
  syncMarketPane();
  openModal(dlg);
  $("f-query").focus();
}

// ---- markets ----

function renderMarketPicker(chosen) {
  $("f-sites").replaceChildren(...getSites().map((site) => {
    const cb = el("input", { type: "checkbox", value: site.key });
    cb.checked = chosen.includes(site.key);
    cb.dataset.siteKey = site.key;
    cb.addEventListener("change", () => {
      stash();
      if (!chosenSites().length) cb.checked = true;   // never leave it empty
      if (!chosenSites().includes(market)) market = chosenSites()[0];
      syncMarketPane();
    });
    return el("label", { class: "opt opt-bool" }, cb, el("span", { text: site.label }));
  }));
}

const chosenSites = () =>
  [...$("f-sites").querySelectorAll("input:checked")].map((c) => c.dataset.siteKey);

/** Capture what is on screen before switching markets or re-rendering. */
function stash() {
  if (!market) return;
  criteria[market] = {
    sort: $("f-sort").value,
    condition: $("f-condition").value,
    category: $("f-category").value,
  };
  params[market] = readOptions($("f-opts"));
  blocked[market] = $("f-blocked").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

// ---- the per-market pane ----

function syncMarketPane() {
  const keys = chosenSites();
  $("f-market").replaceChildren(...keys.map((k) =>
    el("option", { value: k, text: siteByKey(k)?.label || k })));
  $("f-market").value = market;

  const site = siteByKey(market);
  if (!site) return;
  const c = criteria[market] || {};
  const sup = site.supports || {};

  // Sorts are whatever this market declares — not a shared list.
  const sorts = site.sorts || [];
  $("f-sort").replaceChildren(...sorts.map((s) =>
    el("option", { value: s.key, text: s.label })));
  $("f-sort").value = sorts.some((s) => s.key === c.sort) ? c.sort : (sorts[0]?.key || "best");

  $("f-condition-row").hidden = sup.condition === false;
  $("f-condition").replaceChildren(...CONDITIONS.map(([v, t]) =>
    el("option", { value: v, text: t })));
  $("f-condition").value = c.condition || "any";

  const cats = site.categories || [];
  $("f-category-row").hidden = !cats.length;
  $("f-category").replaceChildren(...cats.map((x) =>
    el("option", { value: x.key, text: x.label })));
  if (c.category) $("f-category").value = c.category;

  renderOptions($("f-opts"), site, params[market] || {});

  // No seller data means a blocklist could not match anything.
  $("f-blocked-row").hidden = sup.seller === false;
  $("f-blocked").value = (blocked[market] || []).join("\n");
}

// ---- tabs ----

function showTab(which) {
  const isText = which === "text";
  $("pane-form").hidden = isText;
  $("pane-text").hidden = !isText;
  $("dlg-verify").hidden = !isText;
  $("tab-form").classList.toggle("is-on", !isText);
  $("tab-text").classList.toggle("is-on", isText);
}

/** The profile as JSON — built from the form so the text always matches it. */
function currentDoc() {
  stash();
  const keys = chosenSites();
  const pick = (obj) => Object.fromEntries(keys.map((k) => [k, obj[k]]).filter(([, v]) => v));
  return {
    name: $("f-name").value.trim() || $("f-query").value.trim(),
    query: $("f-query").value.trim(),
    sites: keys,
    min_price: $("f-min").value === "" ? null : Number($("f-min").value),
    max_price: $("f-max").value === "" ? null : Number($("f-max").value),
    notify: $("f-notify").checked,
    criteria: pick(criteria),
    params: pick(params),
    blocked_sellers: pick(blocked),
  };
}

function showErrors(list) {
  const host = $("text-errors");
  host.replaceChildren(...list.map((e) => el("li", { text: e })));
  host.hidden = !list.length;
}

async function verify() {
  const res = await api.validateText($("f-text").value).catch((e) => ({ ok: false, errors: [e.message] }));
  showErrors(res.errors || []);
  if (res.ok) {
    showErrors([]);
    $("dlg-err").textContent = "Valid — formatting and every market check out.";
    $("dlg-err").hidden = false;
    $("dlg-err").classList.add("ok-msg");
  } else {
    $("dlg-err").hidden = true;
  }
  return res.ok;
}

// ---- save ----

async function submit(e) {
  e.preventDefault();
  $("dlg-err").classList.remove("ok-msg");
  const usingText = !$("pane-text").hidden;

  try {
    if (usingText) {
      // Text is authoritative when that tab is open, and is validated server
      // side by the same code the form uses.
      if (!editing) {
        const res = await api.validateText($("f-text").value);
        if (!res.ok) return showErrors(res.errors);
        await api.searches.create(JSON.parse($("f-text").value));
      } else {
        const res = await api.saveText(editing.id, $("f-text").value);
        if (!res.ok) return showErrors(res.errors || []);
      }
    } else if (editing) {
      await api.searches.update(editing.id, currentDoc());
    } else {
      await api.searches.create(currentDoc());
    }
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
  $("dlg-verify").addEventListener("click", verify);

  $("f-market").addEventListener("change", () => {
    stash();
    market = $("f-market").value;
    syncMarketPane();
  });

  $("tab-form").addEventListener("click", () => showTab("form"));
  $("tab-text").addEventListener("click", async () => {
    // Prefer the stored text when editing, so what you see is byte-for-byte
    // what is saved rather than a re-serialisation of the form.
    let text;
    if (editing) {
      text = await api.searchText(editing.id).then((r) => r.text).catch(() => null);
    }
    $("f-text").value = text ?? JSON.stringify(currentDoc(), null, 2);
    showErrors([]);
    showTab("text");
  });
  // No closeOnBackdrop: dismissing a form on a stray click discards the edit.
}
