// Global text size. The page is laid out in px throughout (dense tabular chrome
// where padding, row heights and column widths are tuned to the type), so
// scaling only the font would cram text into boxes built for the old size.
// Scaling the root instead grows everything together — text, padding, borders,
// the rail, the info pane — which is what "bigger text" actually needs to mean
// here. Applied before first paint from main.js, changed live from Customize.

import { store } from "./utils.js";

const KEY = "senya.uiScale";
export const MIN = 0.8;
export const MAX = 1.6;
export const STEP = 0.05;

const clamp = (v) => Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));

export function getScale() {
  const v = parseFloat(store.get(KEY, "1"));
  return Number.isFinite(v) ? clamp(v) : 1;
}

export function applyScale(scale = getScale()) {
  const v = clamp(scale);
  // `zoom` scales layout as well as type — unlike transform: scale(), it reflows
  // rather than stretching, so nothing overlaps and fixed elements stay put.
  document.documentElement.style.zoom = v === 1 ? "" : String(v);
  return v;
}

export function setScale(scale) {
  const v = applyScale(scale);
  store.set(KEY, String(v));
  return v;
}
