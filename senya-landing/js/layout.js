// Layout manager — builds the dashboard from the section registry in the user's
// saved order, honours per-section show/hide, and applies live changes from the
// settings panel without re-initialising sections.
//
// Lifecycle model: a section's shell is built and its init() run lazily, the
// first time it becomes visible. After that the <section> node is reused — when
// hidden it stays in the DOM with the `hidden` attribute (so re-showing is
// instant and never re-fetches or stacks intervals), and reordering just moves
// the existing nodes. Sections hidden at startup never run until first shown, so
// they don't poll in the background.

import { SECTIONS } from "./registry.js";
import { el, store } from "./utils.js";

const ORDER_KEY = "senya.sections.order";
const HIDDEN_KEY = "senya.sections.hidden";

// Only sections whose config makes them available (e.g. internal-only sections
// are dropped off-network). Everything below operates on this subset.
const available = SECTIONS.filter((s) => s.available());
const byId = new Map(available.map((s) => [s.id, s]));

const readJSON = (key, fallback) => {
  try { const v = JSON.parse(store.get(key, "")); return Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
};

// Saved order, sanitised: drop unknown/unavailable ids, then append any newly
// available sections that weren't saved yet (so new sections appear at the end).
function loadOrder() {
  const saved = readJSON(ORDER_KEY, []).filter((id) => byId.has(id));
  for (const s of available) if (!saved.includes(s.id)) saved.push(s.id);
  return saved;
}

let order = loadOrder();
let hidden = new Set(readJSON(HIDDEN_KEY, []).filter((id) => byId.has(id)));
const built = new Map(); // id -> <section> node (built lazily on first show)
let dash = null;

function persist() {
  store.set(ORDER_KEY, JSON.stringify(order));
  store.set(HIDDEN_KEY, JSON.stringify([...hidden]));
}

// Build a section's shell (heading + empty body container) and run its init once.
function ensureBuilt(id) {
  if (built.has(id)) return built.get(id);
  const s = byId.get(id);
  const h2 = el("h2", { text: s.title });
  if (s.hint) h2.append(" ", el("span", { class: "hint", text: s.hint }));
  if (s.headerExtra) h2.append(" ", el("span", { id: s.headerExtra.id, class: s.headerExtra.class }));

  const node = el("section", { id: `${s.id}-section`, "data-section": s.id },
    h2, el("div", { id: s.bodyId, class: s.bodyClass }));
  built.set(id, node);
  dash.appendChild(node);
  try { s.init(); } catch (e) { console.error(`[senya] section "${id}" failed:`, e); }
  return node;
}

// Reconcile the DOM with the current order/hidden state. Visible sections are
// built on demand and re-appended in order (appendChild moves existing nodes, so
// this both creates and reorders); hidden sections get the `hidden` attribute.
function render() {
  for (const id of order) {
    if (hidden.has(id)) {
      built.get(id) && (built.get(id).hidden = true);
      continue;
    }
    const node = ensureBuilt(id);
    node.hidden = false;
    dash.appendChild(node);
  }
}

export function initLayout() {
  dash = document.getElementById("dashboard");
  if (dash) render();
}

// ---- API for the settings panel ----

// Current sections in display order, with title + hidden flag.
export function getSectionsState() {
  return order.map((id) => ({ id, title: byId.get(id).title, hidden: hidden.has(id) }));
}

export function setHidden(id, isHidden) {
  if (!byId.has(id)) return;
  if (isHidden) hidden.add(id); else hidden.delete(id);
  persist();
  render();
}

// Apply a new order (array of ids); missing ids are appended to keep integrity.
export function setOrder(newOrder) {
  const next = newOrder.filter((id) => byId.has(id));
  for (const s of available) if (!next.includes(s.id)) next.push(s.id);
  order = next;
  persist();
  render();
}
