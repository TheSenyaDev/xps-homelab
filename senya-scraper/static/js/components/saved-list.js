// The sidebar: saved profiles, running one, and the seller-block flow.
//
// Owns "which saved search is on screen", so it is what listens for
// `seller:block` from a card or the item panel and re-runs afterwards.

import { $, el, esc, safeList } from "../core/dom.js";
import { api } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { getCurrentSearch, setCurrentSearch, setLastRun, siteLabel } from "../core/state.js";
import * as dialog from "./search-dialog.js";
import {
  clearResults, paintBlockedToggle, renderRun, setStatus, statusLine,
} from "./results.js";

// A one-line summary of the criteria, so a profile is identifiable without
// opening it. Only the parts actually set are shown.
function summary(row) {
  const chosen = safeList(row.sites);
  const bits = [chosen.length > 1 ? `${chosen.length} markets`
                                  : esc(chosen[0] || row.site)];
  if (row.min_price != null || row.max_price != null) {
    bits.push(`$${row.min_price ?? 0}–${row.max_price ?? "∞"}`);
  }
  if (row.condition && row.condition !== "any") bits.push(esc(row.condition));
  return bits.join(" · ");
}

function row(saved) {
  const li = el("li");
  li.innerHTML = `
    <span class="nm">${esc(saved.name)}</span>
    <span class="crit">${summary(saved)}</span>
    <span class="meta">
      <span>${saved.live_count ?? 0} listings</span>
      <span class="acts">
        <button class="edit" title="Edit">✎</button>
        <button class="del" title="Delete">✕</button>
      </span>
    </span>`;

  li.querySelector(".edit").addEventListener("click", (e) => {
    e.stopPropagation();
    dialog.open(saved);
  });
  li.querySelector(".del").addEventListener("click", async (e) => {
    e.stopPropagation();
    await api.searches.remove(saved.id);
    emit("saved:changed", { deleted: true });
  });
  li.addEventListener("click", () => run(saved));
  return li;
}

export async function load() {
  const rows = await api.searches.list().catch(() => []);
  $("saved").replaceChildren(...rows.map(row));
}

export async function run(saved) {
  setCurrentSearch(saved);
  clearResults();
  setStatus(`running “${esc(saved.name)}”…`);
  try {
    const data = await api.searches.run(saved.id);
    const newUids = new Set(data.new.map((i) => i.uid));
    const drops = new Map(data.price_drops.map((i) => [i.uid, i.was]));

    const extra = [];
    if (newUids.size) extra.push(`<span class="k">${newUids.size}</span> new`);
    if (drops.size) extra.push(`<span class="k">${drops.size}</span> price drop${drops.size > 1 ? "s" : ""}`);
    if (data.hidden) extra.push(`<span class="k">${data.hidden}</span> hidden (blocked)`);
    setStatus(statusLine(data, extra));

    setLastRun({ data, newUids, drops });
    paintBlockedToggle(data);
    renderRun();
    load();
  } catch (err) {
    setStatus(esc(err.message), true);
  }
}

// `site` is required, not inferred: the same name on two marketplaces is two
// unrelated sellers, so a block must say which one it means.
async function blockSeller({ name, site, unblock = false }) {
  const saved = getCurrentSearch();
  if (!saved || !name || !site) return;
  try {
    await api.searches.block(saved.id, name, site, unblock);
    setStatus(`${unblock ? "Unblocked" : "Blocked"} <span class="k">${esc(name)}</span>` +
              ` on ${esc(siteLabel(site))} — re-running…`);
    run(saved);
  } catch (err) {
    setStatus(esc(err.message), true);
  }
}

export function init() {
  $("new").addEventListener("click", () => dialog.open());
  on("seller:block", blockSeller);
  // One event covers create, edit and delete, so the message follows the
  // payload rather than assuming a save.
  on("saved:changed", ({ created, deleted } = {}) => {
    load();
    if (deleted) setStatus("Deleted.");
    else if (created) setStatus("Saved. Run it any time to see what changed.");
    else setStatus("Updated.");
  });
}
