// The item panel: everything the search returned for one listing, plus an
// on-demand fetch of its own page.
//
// Opens from a `item:open` event rather than a direct call, so the result grid
// does not have to import this.

import { $, el, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { money, priceText } from "../core/format.js";
import { closeOnBackdrop, openModal } from "../core/modal.js";
import { getCurrentSearch, siteByKey, siteLabel } from "../core/state.js";

let dlg, current = null;

// Only what this listing actually has — an empty row is worse than no row.
function facts(item) {
  return [
    ["Seller", item.seller || item.seller_name],
    ["Location", item.location],
    ["Shipping", item.shipping],
    ["Posted", item.posted_at],
    ["Was", item.extra?.was_price],
    ["Market", siteLabel(item.site)],
  ].filter(([, v]) => v);
}

function renderFacts(rows) {
  $("item-facts").replaceChildren(
    ...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
}

function renderChips(item, marks) {
  const out = [`<span class="chip site">${esc(siteLabel(item.site))}</span>`];
  if (marks.blocked) out.push('<span class="chip blocked">BLOCKED</span>');
  if (marks.isNew) out.push('<span class="chip new">NEW</span>');
  if (item.condition) out.push(`<span class="chip cond">${esc(item.condition)}</span>`);
  if (item.extra?.best_offer) out.push('<span class="chip offer">OBO</span>');
  $("item-chips").innerHTML = out.join("");
}

// Blocking needs a saved search to store it on, and a market that exposes a
// seller at all.
function paintBlockButton(item, marks) {
  const btn = $("item-block");
  const usable = getCurrentSearch() && item.seller_name &&
                 siteByKey(item.site)?.supports?.seller !== false;
  btn.hidden = !usable;
  if (!usable) return;

  const blocked = !!marks.blocked;
  const market = siteLabel(item.site).toUpperCase();
  btn.textContent = `${blocked ? "UNBLOCK" : "BLOCK"} ${item.seller_name} ON ${market}`;
  btn.classList.toggle("danger", !blocked);
  btn.onclick = () => {
    dlg.close();
    emit("seller:block", { name: item.seller_name, site: item.site, unblock: blocked });
  };
}

export function open({ item, marks = {} }) {
  current = item;
  $("item-title").textContent = item.title;
  $("item-open").href = item.url;
  $("item-open").textContent = `OPEN ON ${siteLabel(item.site).toUpperCase()} ↗`;

  const was = marks.was != null
    ? `<span class="was">${money(marks.was, item.currency)}</span>` : "";
  $("item-price").innerHTML = `${esc(priceText(item))}${was}`;

  renderChips(item, marks);
  renderFacts(facts(item));

  $("item-img").src = item.image || "";
  $("item-img").hidden = !item.image;
  $("item-thumbs").replaceChildren();

  $("item-desc-wrap").hidden = true;
  $("item-desc").textContent = "";
  $("item-detail-msg").textContent = "";

  const btn = $("item-detail");
  btn.hidden = !siteByKey(item.site)?.supports?.detail;
  btn.disabled = false;
  btn.textContent = "LOAD FULL DETAILS";

  paintBlockButton(item, marks);
  openModal(dlg);
}

async function loadDetail() {
  if (!current) return;
  const btn = $("item-detail");
  btn.disabled = true;
  btn.textContent = "LOADING…";
  $("item-detail-msg").textContent = "fetching the listing page…";

  try {
    const d = await api.detail(current.site, current.url);
    if (d.description) {
      $("item-desc").textContent = d.description;
      $("item-desc-wrap").hidden = false;
    }
    if (d.specs) renderFacts([...facts(current), ...Object.entries(d.specs)]);
    if (d.photos?.length) {
      $("item-img").src = d.photos[0];
      $("item-img").hidden = false;
      $("item-thumbs").replaceChildren(...d.photos.slice(0, 8).map((src) =>
        el("img", { src, loading: "lazy", onclick: () => { $("item-img").src = src; } })));
    }
    const got = ["description", "specs", "photos"].filter((k) => d[k]);
    $("item-detail-msg").textContent =
      got.length ? `Loaded ${got.join(", ")}.` : "That page had nothing extra.";
    btn.textContent = "RELOAD DETAILS";
  } catch (err) {
    $("item-detail-msg").textContent = err.message;
    btn.textContent = "LOAD FULL DETAILS";
  } finally {
    btn.disabled = false;
  }
}

export function init() {
  dlg = $("item-dlg");
  $("item-close").addEventListener("click", () => dlg.close());
  $("item-detail").addEventListener("click", loadDetail);
  // Read-only, so a stray click costs nothing — unlike the forms.
  closeOnBackdrop(dlg);
  on("item:open", open);
}
