// The settings dialog.
//
// Every control is built from /api/settings' schema: the server owns what
// exists, this owns how it looks. Adding a setting server-side needs no change
// here.

import { $, el, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { emit } from "../core/bus.js";
import { openModal } from "../core/modal.js";
import { setSites } from "../core/state.js";

let dlg;

function control(spec, value) {
  let input;
  if (spec.type === "choice") {
    input = el("select", {},
      ...spec.choices.map((c) => el("option", { value: c.value, text: c.label })));
    input.value = value ?? spec.default;
  } else if (spec.type === "bool") {
    input = el("input", { type: "checkbox" });
    input.checked = !!value;
  } else {
    input = el("input", { type: spec.type === "number" ? "number" : "text" });
    if (spec.type === "number") input.step = "any";
    input.value = value ?? spec.default ?? "";
  }
  input.dataset.setKey = spec.key;
  input.dataset.setType = spec.type;
  return input;
}

function settingRow(spec, value) {
  const name = el("span", { class: "set-name" }, el("span", { text: spec.label }));
  // A switch that is declared but not yet read by anything says so, rather than
  // looking functional.
  if (spec.inert) name.append(el("span", { class: "set-inert", text: "not wired" }));
  if (spec.help) name.append(el("span", { class: "set-help", text: spec.help }));

  const input = control(spec, value);
  return el("label", { class: `set-row set-${spec.type}` },
    ...(spec.type === "bool" ? [input, name] : [name, input]));
}

function renderSchema(schema, values) {
  const groups = [];
  for (const spec of schema) {
    let g = groups.find((x) => x.name === spec.group);
    if (!g) groups.push((g = { name: spec.group, items: [] }));
    g.items.push(spec);
  }
  $("settings-body").replaceChildren(...groups.map((g) =>
    el("fieldset", { class: "opts" },
      el("legend", { text: g.name }),
      ...g.items.map((spec) => settingRow(spec, values[spec.key])))));
}

// Show what the transport is actually doing, so the fingerprint settings are
// verifiable rather than taken on faith.
async function paintStatus() {
  const h = await api.health().catch(() => null);
  if (!h) return;
  const ok = h.http.impersonates_tls;
  const rows = Object.entries(h.fetchers || {})
    .map(([k, v]) => `${k}: ${v.tls_target} · ${v.min_interval}–${v.max_interval ?? "fixed"}s`)
    .join(" · ");
  $("settings-status").innerHTML =
    `<span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} TLS/HTTP2 impersonation via ` +
    `${esc(h.http.backend)}</span>` +
    (rows ? `<br><span class="dim">${esc(rows)}</span>` : "");
}

export async function open() {
  $("settings-err").hidden = true;
  $("settings-body").replaceChildren();
  $("settings-status").textContent = "loading…";
  openModal(dlg);
  try {
    const { schema, values } = await api.settings.read();
    renderSchema(schema, values);
    await paintStatus();
  } catch (err) {
    $("settings-err").textContent = err.message;
    $("settings-err").hidden = false;
    $("settings-status").textContent = "";
  }
}

async function submit(e) {
  e.preventDefault();
  const payload = {};
  for (const input of $("settings-body").querySelectorAll("[data-set-key]")) {
    payload[input.dataset.setKey] =
      input.dataset.setType === "bool" ? input.checked
      : input.dataset.setType === "number" ? (input.value === "" ? null : Number(input.value))
      : input.value;
  }
  try {
    const res = await api.settings.write(payload);
    $("settings-status").textContent = res.changed.length
      ? `Applied ${res.changed.length} change${res.changed.length > 1 ? "s" : ""}.`
      : "No changes.";
    await paintStatus();
    // Markets may have been toggled, which changes what "All markets" means.
    setSites(await api.sites().catch(() => []));
    emit("sites:changed");
  } catch (err) {
    $("settings-err").textContent = err.message;
    $("settings-err").hidden = false;
  }
}

export function init() {
  dlg = $("settings-dlg");
  $("open-settings").addEventListener("click", open);
  $("settings-close").addEventListener("click", () => dlg.close());
  $("settings-form").addEventListener("submit", submit);
}
