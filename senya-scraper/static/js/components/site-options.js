// Renders a site's declared options into controls, and reads them back.
//
// Shared by the search bar and the profile dialog so the two can never drift.
// There is no per-site code here and none should be added: the server describes
// what a market can filter by, this turns that description into inputs.

import { el } from "../core/dom.js";

/**
 * @param host   container to fill
 * @param site   a /api/sites entry, or null to clear
 * @param values current values, keyed by option key
 */
export function renderOptions(host, site, values = {}) {
  host.replaceChildren();
  const opts = site?.options || [];
  host.hidden = !opts.length;
  if (!opts.length) return;

  for (const o of opts) {
    const val = values[o.key] !== undefined ? values[o.key] : o.default;
    const label = el("span", { text: o.label });
    let input;

    if (o.type === "choice") {
      input = el("select", {},
        ...o.choices.map((c) => el("option", { value: c.value, text: c.label })));
      input.value = val ?? o.choices[0]?.value;
    } else if (o.type === "bool") {
      input = el("input", { type: "checkbox" });
      input.checked = !!val;
    } else {
      input = el("input", { type: o.type === "number" ? "number" : "text" });
      if (val != null) input.value = val;
    }

    input.dataset.optKey = o.key;
    input.dataset.optType = o.type;

    // Checkbox reads left-to-right; everything else is label-then-control.
    const wrap = el("label", { class: `opt opt-${o.type}`, title: o.help || "" },
      ...(o.type === "bool" ? [input, label] : [label, input]));
    host.append(wrap);
  }
}

/** {option: value} for one rendered group. */
export function readOptions(host) {
  const out = {};
  for (const input of host.querySelectorAll("[data-opt-key]")) {
    out[input.dataset.optKey] =
      input.dataset.optType === "bool" ? input.checked
      : input.dataset.optType === "number" ? (input.value === "" ? null : Number(input.value))
      : input.value;
  }
  return out;
}
