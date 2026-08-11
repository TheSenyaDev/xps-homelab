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
// A 12-column grid, so the useful fractions all land on a column boundary:
// halves at 6, thirds at 4, quarters at 3. Snapping to columns is what makes a
// free drag feel deliberate rather than approximate.
export const COLS = 12;
export const SIZE_LIMITS = { w: { min: 2, max: COLS }, h: { min: 1, max: 4 } };
export const DEFAULT_W = COLS / 2;

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
    w: clamp(saved.w ?? (s?.wide ? COLS : DEFAULT_W), SIZE_LIMITS.w),
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

  // Window-style edges: right for width, bottom for height, corner for both.
  for (const axis of ["x", "y", "xy"]) {
    const grip = el("span", {
      class: `resize-grip grip-${axis}`, "aria-hidden": "true",
    });
    grip.addEventListener("pointerdown", (e) => startResize(e, node, axis));
    node.appendChild(grip);
  }
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

// ---- direct manipulation on the dashboard ----
//
// Two gestures, both Pointer Events (HTML5 drag never fires on touch):
//
//   move    — drag a widget by its heading. A placeholder occupies the target
//             slot during the drag, so you are choosing a position you can see
//             rather than guessing where it will land on release.
//   resize  — drag a widget's right or bottom edge, like a window. Width snaps
//             to grid columns and height to rows, so a free drag still produces
//             a layout that lines up.
//
// After a move, the affected row is rebalanced so its widgets share the width
// evenly — drop a third widget into a row of two and all three become thirds.

const cssCols = () =>
  parseInt(getComputedStyle(dash).getPropertyValue("--dash-cols"), 10) || COLS;

/** Widgets grouped into visual rows, by walking widths until they fill. */
function rowsOf(nodes) {
  const cols = cssCols();
  const rows = [];
  let row = [], used = 0;
  for (const n of nodes) {
    const w = Math.min(getWidgetConfig(n.dataset.section).w, cols);
    if (used + w > cols && row.length) { rows.push(row); row = []; used = 0; }
    row.push(n);
    used += w;
  }
  if (row.length) rows.push(row);
  return rows;
}

/**
 * Give every widget in `row` an equal share of the width.
 *
 * The remainder goes to the leftmost widgets, so 12/5 becomes 3,3,2,2,2 rather
 * than a row that does not quite fill. This is what makes dropping into a row
 * of two produce thirds.
 */
function balanceRow(row) {
  const cols = cssCols();
  if (!row.length || row.length > cols) return;
  const base = Math.floor(cols / row.length);
  if (base < SIZE_LIMITS.w.min) return;   // too many to share; leave them be
  let extra = cols - base * row.length;
  for (const node of row) {
    const w = base + (extra-- > 0 ? 1 : 0);
    setRaw(node.dataset.section, { w });
    applySize(node, getWidgetConfig(node.dataset.section));
  }
}

let drag = null;      // {node, placeholder, moved}
let resize = null;    // {node, id, axis, startX, startY, startW, startH, unit}

function startWidgetDrag(e, node) {
  if (e.target.closest("a, button, select, input")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  drag = { node, from: { x: e.clientX, y: e.clientY }, moved: false, placeholder: null };
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) < 6) return;
    drag.moved = true;
    // The placeholder inherits the dragged widget's span so the preview is the
    // real footprint, not a generic gap.
    const cfg = getWidgetConfig(drag.node.dataset.section);
    drag.placeholder = el("div", { class: "widget-placeholder" });
    drag.placeholder.style.setProperty("--w", cfg.w);
    drag.placeholder.style.setProperty("--h", cfg.h);
    drag.node.classList.add("dragging");
    document.body.classList.add("widget-dragging");
    dash.insertBefore(drag.placeholder, drag.node);
    drag.node.style.display = "none";     // out of flow; the placeholder stands in
  }
  e.preventDefault();

  const targets = [...dash.children].filter(
    (n) => n !== drag.node && n !== drag.placeholder && !n.hidden);
  // Insert before the first widget whose centre the pointer has passed, reading
  // the grid in rows: below it entirely, or on the same row and to its left.
  const before = targets.find((n) => {
    const b = n.getBoundingClientRect();
    if (e.clientY < b.top) return true;
    if (e.clientY > b.bottom) return false;
    return e.clientX < b.left + b.width / 2;
  });
  if (before) dash.insertBefore(drag.placeholder, before);
  else dash.appendChild(drag.placeholder);
}

function endDrag(e) {
  const handle = e.currentTarget;
  handle.releasePointerCapture?.(e.pointerId);
  handle.removeEventListener("pointermove", onDragMove);
  handle.removeEventListener("pointerup", endDrag);
  handle.removeEventListener("pointercancel", endDrag);
  if (!drag) return;
  const { node, placeholder, moved } = drag;
  drag = null;
  node.classList.remove("dragging");
  document.body.classList.remove("widget-dragging");
  node.style.display = "";
  if (!moved) return;                     // a click, not a drag

  dash.insertBefore(node, placeholder);
  placeholder.remove();
  commitOrder();
  // Rebalance the row it landed in, which is what turns a row of two into
  // thirds when a third arrives.
  const row = rowsOf([...dash.children].filter((n) => !n.hidden))
    .find((r) => r.includes(node));
  if (row) balanceRow(row);
  render();
}

/** Rebuild `order` from the DOM, keeping hidden sections where they were. */
function commitOrder() {
  const visible = [...dash.children]
    .map((n) => n.dataset.section)
    .filter((id) => id && byId.has(id));
  const next = [];
  for (const id of order) next.push(hidden.has(id) ? id : visible.shift());
  order = next.filter(Boolean);
  persist();
}

// ---- resize ----

function startResize(e, node, axis) {
  e.preventDefault();
  e.stopPropagation();
  const id = node.dataset.section;
  const cfg = getWidgetConfig(id);
  // One column's width in pixels, so a pointer delta converts to a column
  // count. Measured from the grid itself rather than assumed, since the column
  // count changes with the breakpoint.
  const unit = dash.getBoundingClientRect().width / cssCols();
  resize = {
    node, id, axis, startX: e.clientX, startY: e.clientY,
    startW: cfg.w, startH: cfg.h, unit,
    rowUnit: node.getBoundingClientRect().height / Math.max(cfg.h, 1),
  };
  node.classList.add("resizing");
  document.body.classList.add("widget-resizing");
  e.currentTarget.setPointerCapture(e.pointerId);
  e.currentTarget.addEventListener("pointermove", onResizeMove);
  e.currentTarget.addEventListener("pointerup", endResize);
  e.currentTarget.addEventListener("pointercancel", endResize);
}

function onResizeMove(e) {
  if (!resize) return;
  const patch = {};
  if (resize.axis !== "y") {
    // Math.round, not floor: the widget snaps to the nearest column boundary,
    // so the edge follows the pointer instead of lagging a column behind it.
    const dw = Math.round((e.clientX - resize.startX) / resize.unit);
    patch.w = Math.max(SIZE_LIMITS.w.min,
                       Math.min(cssCols(), resize.startW + dw));
  }
  if (resize.axis !== "x") {
    const dh = Math.round((e.clientY - resize.startY) / resize.rowUnit);
    patch.h = Math.max(SIZE_LIMITS.h.min,
                       Math.min(SIZE_LIMITS.h.max, resize.startH + dh));
  }
  const cfg = getWidgetConfig(resize.id);
  if (patch.w === cfg.w && patch.h === cfg.h) return;   // still in the same cell
  setRaw(resize.id, patch);
  applySize(resize.node, getWidgetConfig(resize.id));
}

function endResize(e) {
  const handle = e.currentTarget;
  handle.releasePointerCapture?.(e.pointerId);
  handle.removeEventListener("pointermove", onResizeMove);
  handle.removeEventListener("pointerup", endResize);
  handle.removeEventListener("pointercancel", endResize);
  if (!resize) return;
  resize.node.classList.remove("resizing");
  document.body.classList.remove("widget-resizing");
  resize = null;
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
