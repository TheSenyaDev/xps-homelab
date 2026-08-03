// Two independent size knobs, because they do different jobs:
//
//   • Font — scales type only. Every font-size in the stylesheets is written as
//     calc(<px> * var(--fs)), so this grows the text inside the existing dense
//     chrome. Cheap to nudge a notch when the 9px monospace is too small; push
//     it far and text starts crowding its boxes, which is the trade you're
//     making by not moving the boxes.
//   • Zoom — scales the whole page (type, padding, row heights, the rail, the
//     info pane) via root `zoom`, so proportions are preserved. This is the one
//     to reach for when everything is simply too small.
//
// Both persist per-browser and apply before first paint from main.js.

import { store } from "./utils.js";

const FONT_KEY = "senya.fontScale";
const ZOOM_KEY = "senya.uiZoom";
const LEGACY_KEY = "senya.uiScale"; // the single knob these two replaced

export const LIMITS = {
  // Font is capped tighter than zoom: past ~130% the tabular rows can't hold
  // their labels, and zoom is the better tool at that point.
  font: { min: 0.85, max: 1.4, step: 0.05 },
  zoom: { min: 0.8, max: 1.6, step: 0.05 },
};

const clamp = (kind, v) => {
  const { min, max, step } = LIMITS[kind];
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
};

const read = (key, kind) => {
  const v = parseFloat(store.get(key, "1"));
  return Number.isFinite(v) ? clamp(kind, v) : 1;
};

export const getFont = () => read(FONT_KEY, "font");
export const getZoom = () => read(ZOOM_KEY, "zoom");

export function applyFont(scale = getFont()) {
  const v = clamp("font", scale);
  document.documentElement.style.setProperty("--fs", String(v));
  return v;
}

export function applyZoom(scale = getZoom()) {
  const v = clamp("zoom", scale);
  // `zoom` reflows rather than stretching (unlike transform: scale()), so
  // nothing overlaps and fixed elements stay anchored.
  document.documentElement.style.zoom = v === 1 ? "" : String(v);
  return v;
}

export function setFont(scale) {
  const v = applyFont(scale);
  store.set(FONT_KEY, String(v));
  return v;
}

export function setZoom(scale) {
  const v = applyZoom(scale);
  store.set(ZOOM_KEY, String(v));
  return v;
}

export function applyAll() {
  // One-time migration: the old combined "text size" was a zoom, so carry it
  // over to the zoom knob and retire the old key.
  const legacy = store.get(LEGACY_KEY, null);
  if (legacy !== null && store.get(ZOOM_KEY, null) === null) {
    store.set(ZOOM_KEY, legacy);
    store.set(LEGACY_KEY, "");
  }
  applyFont();
  applyZoom();
}
