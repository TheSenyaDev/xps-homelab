// Per-widget stored config: size, plus whatever settings a widget declares.
//
//   {"tasks": {"w": 2, "h": 2, "categories": "3,7"}}
//
// A leaf module on purpose. layout.js imports the registry, and a widget needs
// to read its own config — so if this lived in layout.js the graph would be
// layout → registry → widget → layout. ES modules tolerate that only because
// the calls happen after evaluation; one top-level read would break it. Keeping
// storage separate means neither side has to know about the other.
//
// Raw values only: the registry's defaults are layered on by whoever knows them
// (layout.js for size, the widget itself for its own settings).

import { store } from "./utils.js";

const KEY = "senya.widgets";

function readAll() {
  try {
    const v = JSON.parse(store.get(KEY, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

let widgets = readAll();

/** Stored values for one widget, without defaults. */
export const getRaw = (id) => widgets[id] || {};

/** Merge a patch in and persist. */
export function setRaw(id, patch) {
  widgets[id] = { ...(widgets[id] || {}), ...patch };
  store.set(KEY, JSON.stringify(widgets));
}

/** A widget's config with its own defaults applied — what a widget should use. */
export const configFor = (id, defaults = {}) => ({ ...defaults, ...getRaw(id) });
