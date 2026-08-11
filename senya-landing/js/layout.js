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
import { getRaw, setRaw } from "./widget-config.js";

const ORDER_KEY = "senya.sections.order";
const HIDDEN_KEY = "senya.sections.hidden";
// Width is in grid columns and height in grid rows. CSS clamps a span larger
// than the grid, so a 4-wide widget on a 2-column screen simply fills the row
// rather than breaking the layout — no JS resize handling needed.
export const SIZE_LIMITS = { w: { min: 1, max: 4 }, h: { min: 1, max: 3 } };

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

const clamp = (n, { min, max }) => Math.max(min, Math.min(max, n));

/** A widget's stored config, with the registry's defaults filled in. */
export function getWidgetConfig(id) {
  const s = byId.get(id);
  const saved = getRaw(id);
  const cfg = {
    // `wide: true` in the registry is the old way of saying "full width"; it
    // becomes the default width rather than a separate mechanism.
    w: clamp(saved.w ?? (s?.wide ? SIZE_LIMITS.w.max : 1), SIZE_LIMITS.w),
    h: clamp(saved.h ?? 1, SIZE_LIMITS.h),
  };
  for (const spec of s?.settings || []) {
    cfg[spec.key] = saved[spec.key] !== undefined ? saved[spec.key] : spec.default;
  }
  return cfg;
}

/**
 * Merge a patch into a widget's config.
 *
 * Size changes are pure CSS, so they apply instantly. Anything else is a
 * setting the widget owns, so it is told to refresh — a widget that declares
 * settings must export onConfigChange, or its own controls would go stale.
 */
export function setWidgetConfig(id, patch) {
  setRaw(id, patch);
  const node = built.get(id);
  if (node) applySize(node, getWidgetConfig(id));
  const sizeOnly = Object.keys(patch).every((k) => k === "w" || k === "h");
  if (!sizeOnly) byId.get(id)?.onConfigChange?.(getWidgetConfig(id));
}

function applySize(node, cfg) {
  node.style.setProperty("--w", cfg.w);
  node.style.setProperty("--h", cfg.h);
  // A widget taller than one row scrolls its body rather than stretching the
  // row, so one long list cannot drag the whole grid out of shape.
  node.dataset.tall = cfg.h > 1 ? "true" : "false";
}

// Build a section's shell (heading + empty body container) and run its init once.
function ensureBuilt(id) {
  if (built.has(id)) return built.get(id);
  const s = byId.get(id);
  const h2 = el("h2", { text: s.title });
  if (s.hint) h2.append(" ", el("span", { class: "hint", text: s.hint }));
  if (s.headerExtra) h2.append(" ", el("span", { id: s.headerExtra.id, class: s.headerExtra.class }));

  // `wide: true` in the registry → the section spans every grid column (for
  // widgets like the market map that need room to be readable).
  const node = el("section", {
    id: `${s.id}-section`, "data-section": s.id,
  }, h2, el("div", { id: s.bodyId, class: s.bodyClass }));
  applySize(node, getWidgetConfig(id));
  // The heading is the drag handle, so a widget can be moved where you see it
  // rather than only from the Customize list.
  h2.addEventListener("pointerdown", (e) => startWidgetDrag(e, node));
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

// ---- drag to move, on the dashboard itself ----
//
// Pointer Events rather than HTML5 drag-and-drop, which never fires on touch.
// A small movement threshold keeps an ordinary click on the heading (or on a
// control inside it) from starting a drag.

let dragNode = null;
let dragFrom = null;

function startWidgetDrag(e, node) {
  // Never hijack a click on something interactive in the header.
  if (e.target.closest("a, button, select, input")) return;
  if (e.button !== 0 && e.pointerType === "mouse") return;

  dragNode = node;
  dragFrom = { x: e.clientX, y: e.clientY, moved: false };
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  handle.addEventListener("pointermove", onWidgetMove);
  handle.addEventListener("pointerup", endWidgetDrag);
  handle.addEventListener("pointercancel", endWidgetDrag);
}

function onWidgetMove(e) {
  if (!dragNode) return;
  if (!dragFrom.moved) {
    if (Math.hypot(e.clientX - dragFrom.x, e.clientY - dragFrom.y) < 6) return;
    dragFrom.moved = true;
    dragNode.classList.add("dragging");
    document.body.classList.add("widget-dragging");
  }
  e.preventDefault();

  // Drop before whichever visible sibling the pointer has passed the middle of.
  // Compared on both axes because the dashboard is a grid, not a list.
  const others = [...dash.children].filter((n) => n !== dragNode && !n.hidden);
  const target = others.find((n) => {
    const b = n.getBoundingClientRect();
    return e.clientY < b.bottom && e.clientX < b.left + b.width / 2
        || e.clientY < b.top + b.height / 2;
  });
  if (target) dash.insertBefore(dragNode, target);
  else dash.appendChild(dragNode);
}

function endWidgetDrag(e) {
  const handle = e.currentTarget;
  handle.releasePointerCapture?.(e.pointerId);
  handle.removeEventListener("pointermove", onWidgetMove);
  handle.removeEventListener("pointerup", endWidgetDrag);
  handle.removeEventListener("pointercancel", endWidgetDrag);
  if (!dragNode) return;
  const moved = dragFrom.moved;
  dragNode.classList.remove("dragging");
  document.body.classList.remove("widget-dragging");
  dragNode = null;
  if (!moved) return;                     // a click, not a drag
  // Hidden sections keep their place in `order`, so rebuild from the DOM and
  // splice them back where they were rather than dropping them to the end.
  const visible = [...dash.children].map((n) => n.dataset.section).filter(Boolean);
  const next = [];
  for (const id of order) {
    if (hidden.has(id)) next.push(id);
    else next.push(visible.shift());
  }
  order = next.filter(Boolean);
  persist();
  render();
}

// ---- API for the settings panel ----

// Current sections in display order, with title + hidden flag.
export function getSectionsState() {
  return order.map((id) => ({ id, title: byId.get(id).title, hidden: hidden.has(id) }));
}

/**
 * A widget's settings schema, resolved.
 *
 * `settings` may be a function — the Tasks widget builds its category list from
 * the API — so this awaits whatever the registry gives and always returns an
 * array.
 */
export async function getWidgetSchema(id) {
  const spec = byId.get(id)?.settings;
  if (!spec) return [];
  const resolved = typeof spec === "function" ? await spec() : spec;
  return Array.isArray(resolved) ? resolved : [];
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

// ---- Info pane (right column) ----

const INFO_COLLAPSED_KEY = "senya.infopane.collapsed";

// Narrows the right column to a strip that keeps each metric's bar but drops
// its label and value — system health stays glanceable while the dashboard
// gets the width back. The choice is remembered across reloads.
export function initInfoPane() {
  const pane = document.querySelector(".info-pane");
  const toggle = document.getElementById("info-toggle");
  if (!pane || !toggle) return;

  const apply = (collapsed) => {
    pane.dataset.collapsed = String(collapsed);
    toggle.textContent = collapsed ? "‹" : "›";
    const label = collapsed ? "Expand system panel" : "Collapse system panel";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    store.set(INFO_COLLAPSED_KEY, String(collapsed));
  };

  apply(store.get(INFO_COLLAPSED_KEY, "false") === "true");
  toggle.addEventListener("click", () => apply(pane.dataset.collapsed !== "true"));
}
