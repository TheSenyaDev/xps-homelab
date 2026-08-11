// The result grid: cards, their marks, and the "show blocked" re-render.
//
// Knows nothing about saved searches or the item panel — a click emits
// `item:open` and something else decides what that means.

import { $, el, esc } from "../core/dom.js";
import { emit } from "../core/bus.js";
import { money, priceText } from "../core/format.js";
import { getCurrentSearch, getLastRun, isMultiSite, siteLabel } from "../core/state.js";

let multiSite = false;

function chips(item, marks) {
  const out = [];
  if (marks.blocked) out.push('<span class="chip blocked">BLOCKED</span>');
  if (marks.isNew) out.push('<span class="chip new">NEW</span>');
  if (marks.was != null) out.push('<span class="chip drop">DROP</span>');
  // Only worth the space when results are mixed; on a single-market search
  // every card would carry the same badge.
  if (multiSite) out.push(`<span class="chip site">${esc(siteLabel(item.site))}</span>`);
  if (item.condition) out.push(`<span class="chip cond">${esc(item.condition)}</span>`);
  if (item.location) out.push(`<span class="chip ship">${esc(item.location)}</span>`);
  if (item.extra?.best_offer) out.push('<span class="chip offer">OBO</span>');
  if (item.shipping) out.push(`<span class="chip ship">${esc(item.shipping)}</span>`);
  return out.join("");
}

function sellerRow(item) {
  if (!item.seller) return "";
  // Blocking needs a saved search to store it on.
  const btn = (getCurrentSearch() && item.seller_name)
    ? `<button class="block" title="Hide ${esc(item.seller_name)} from this search">⊘</button>`
    : "";
  return `<div class="seller">${esc(item.seller)}${btn}</div>`;
}

export function card(item, marks = {}) {
  const node = el("article", { class: `card${marks.blocked ? " is-blocked" : ""}` });
  const was = marks.was != null
    ? `<span class="was">${money(marks.was, item.currency)}</span>` : "";

  node.innerHTML = `
    <div class="thumb">${
      item.image
        ? `<img src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '<span class="none">no image</span>'}</div>
    <div class="body">
      <a class="title" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
      <div class="price">${esc(priceText(item))}${was}</div>
      <div class="row">${chips(item, marks)}</div>
      ${sellerRow(item)}
    </div>`;

  node.querySelector(".block")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    emit("seller:block", { name: item.seller_name, site: item.site });
  });

  // Anywhere but a link or button opens the panel; the title link still goes
  // straight to the listing, which is what a link is for.
  node.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    emit("item:open", { item, marks });
  });
  return node;
}

export function render(items, { newUids = new Set(), drops = new Map(),
                                blockedUids = new Set() } = {}) {
  const grid = $("grid");
  multiSite = isMultiSite(items);
  grid.replaceChildren();
  if (!items.length) {
    setStatus("No listings matched.");
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of items) {
    frag.append(card(item, {
      isNew: newUids.has(item.uid),
      was: drops.get(item.uid),
      blocked: blockedUids.has(item.uid),
    }));
  }
  grid.append(frag);
}

export function setStatus(msg, isError = false) {
  const node = $("status");
  node.classList.toggle("err", isError);
  node.innerHTML = msg;
}

// A combined search can half-succeed, so the status line must be able to say
// "here are results, and also this market is down" at once.
export function statusLine(data, extra = []) {
  const bits = [`<span class="k">${data.count ?? data.total ?? 0}</span> listings`];
  if ((data.sites || []).length > 1) bits.push(`${data.sites.length} markets`);
  bits.push(...extra);
  let line = bits.join(" · ");
  for (const e of data.errors || []) {
    line += `<div class="warn">⚠ ${esc(e.label)}: ${esc(e.error)}</div>`;
  }
  return line;
}

export function clearResults() {
  $("grid").replaceChildren();
  $("show-blocked-wrap").hidden = true;
}

/** Re-render the last saved-search run from memory, honouring the toggle. */
export function renderRun() {
  const run = getLastRun();
  if (!run) return;
  const { data, newUids, drops } = run;
  const blocked = data.blocked_listings || [];
  const blockedUids = new Set(blocked.map((i) => i.uid));
  const items = $("show-blocked").checked ? [...data.results, ...blocked] : data.results;

  // New and discounted first — the whole reason for re-running. Blocked ones
  // sink to the bottom so revealing them never buries the results.
  const rank = (i) => (blockedUids.has(i.uid) ? 3
                     : newUids.has(i.uid) ? 0
                     : drops.has(i.uid) ? 1 : 2);
  render([...items].sort((a, b) => rank(a) - rank(b)), { newUids, drops, blockedUids });
}

export function paintBlockedToggle(data) {
  const n = (data.blocked_listings || []).length;
  $("show-blocked-wrap").hidden = !n;
  $("blocked-count").textContent = n ? `(${n})` : "";
}

export function init() {
  $("show-blocked").addEventListener("change", renderRun);
}
