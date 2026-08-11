// Customize panel: show/hide and reorder dashboard sections. Opens as a side
// drawer on desktop and a bottom sheet on mobile (pure CSS, toggled by the
// `settings-open` body class). Reordering uses Pointer Events so it works with
// both mouse and touch — HTML5 drag-and-drop doesn't fire on touch.

import { el } from "./utils.js";
import {
  SIZE_LIMITS, getSectionsState, getWidgetConfig, getWidgetSchema,
  setHidden, setOrder, setWidgetConfig,
} from "./layout.js";
import { getFont, setFont, getZoom, setZoom, LIMITS } from "./ui-scale.js";

export function initSettings() {
  const btn = document.getElementById("settings-btn");
  const panel = document.getElementById("settings");
  const list = document.getElementById("settings-list");
  const backdrop = document.getElementById("settings-backdrop");
  const scaleWrap = document.getElementById("settings-scale");
  if (!btn || !panel || !list) return;

  // ---- size controls: font and zoom, independent ----

  let paintScale = () => {};
  if (scaleWrap) {
    // Two identical −/value/+/reset rows over different setters.
    const knob = (name, hint, get, set, limits) => {
      const value = el("span", { class: "scale-value" });
      const paint = () => { value.textContent = `${Math.round(get() * 100)}%`; };
      const bump = (d) => { set(get() + d); paint(); };
      const range = `${Math.round(limits.min * 100)}–${Math.round(limits.max * 100)}%`;

      const row = el("div", { class: "set-row set-scale" },
        el("span", { class: "set-name" },
          name, el("span", { class: "set-sub", text: hint })),
        el("div", { class: "scale-ctl" },
          el("button", { type: "button", class: "scale-btn", title: `Smaller (${range})`, "aria-label": `Decrease ${name}`, text: "−", onclick: () => bump(-limits.step) }),
          value,
          el("button", { type: "button", class: "scale-btn", title: `Bigger (${range})`, "aria-label": `Increase ${name}`, text: "+", onclick: () => bump(limits.step) }),
          el("button", { type: "button", class: "scale-reset", title: "Back to 100%", text: "reset", onclick: () => { set(1); paint(); } })));
      return { row, paint };
    };

    const font = knob("Font", "text only", getFont, setFont, LIMITS.font);
    const zoom = knob("Zoom", "whole page", getZoom, setZoom, LIMITS.zoom);
    scaleWrap.replaceChildren(font.row, zoom.row);
    paintScale = () => { font.paint(); zoom.paint(); }; // re-read on open
    paintScale();
  }

  const isOpen = () => document.body.classList.contains("settings-open");
  const open = () => { document.body.classList.add("settings-open"); panel.setAttribute("aria-hidden", "false"); paintScale(); renderList(); };
  const close = () => { document.body.classList.remove("settings-open"); panel.setAttribute("aria-hidden", "true"); };

  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  backdrop?.addEventListener("click", close);
  document.getElementById("settings-close")?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });

  // ---- list rendering ----

  function renderList() {
    list.replaceChildren(...getSectionsState().map(rowFor));
  }

  function rowFor(s) {
    const handle = el("span", { class: "set-handle", title: "Drag to reorder", "aria-hidden": "true", text: "⠿" });

    const toggle = el("input", { type: "checkbox", class: "set-toggle" });
    toggle.checked = !s.hidden;
    toggle.addEventListener("change", () => setHidden(s.id, !toggle.checked));

    // Size and any settings the widget declares live behind a disclosure, so
    // the list stays a list until you want to configure something.
    const body = el("div", { class: "set-widget", hidden: true });
    const expander = el("button", {
      type: "button", class: "set-expand", title: "Size and settings",
      "aria-expanded": "false", text: "▸",
    });
    expander.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      expander.textContent = open ? "▾" : "▸";
      expander.setAttribute("aria-expanded", String(open));
      if (open) fillWidgetBody(s.id, body);
    });

    const row = el("li", { class: "set-row", "data-id": s.id },
      handle,
      el("span", { class: "set-name", text: s.title }),
      expander,
      el("label", { class: "set-switch" }, toggle, el("span", { class: "set-track" })));

    handle.addEventListener("pointerdown", (e) => startDrag(e, row));
    return el("li", { class: "set-item", "data-id": s.id }, row, body);
  }

  // ---- per-widget size + settings ----

  // Built on first expand rather than up front: a widget's choices can need a
  // network call (the Tasks categories), and paying for that for every widget
  // whenever the drawer opens would be wasteful.
  async function fillWidgetBody(id, body) {
    const cfg = getWidgetConfig(id);
    body.replaceChildren(
      stepper("Width", "columns", cfg.w, SIZE_LIMITS.w, (v) => setWidgetConfig(id, { w: v })),
      stepper("Height", "rows", cfg.h, SIZE_LIMITS.h, (v) => setWidgetConfig(id, { h: v })));

    let schema = [];
    try {
      schema = await getWidgetSchema(id);
    } catch {
      body.append(el("div", { class: "set-sub", text: "Settings unavailable." }));
      return;
    }
    for (const spec of schema) {
      body.append(settingRow(id, spec, cfg[spec.key]));
    }
  }

  function stepper(name, unit, value, limits, onChange) {
    const out = el("span", { class: "scale-value", text: String(value) });
    let current = value;
    const bump = (d) => {
      const next = Math.max(limits.min, Math.min(limits.max, current + d));
      if (next === current) return;
      current = next;
      out.textContent = String(current);
      onChange(current);
    };
    return el("div", { class: "set-row set-scale" },
      el("span", { class: "set-name" }, name, el("span", { class: "set-sub", text: unit })),
      el("div", { class: "scale-ctl" },
        el("button", { type: "button", class: "scale-btn", text: "−", "aria-label": `Fewer ${unit}`, onclick: () => bump(-1) }),
        out,
        el("button", { type: "button", class: "scale-btn", text: "+", "aria-label": `More ${unit}`, onclick: () => bump(1) })));
  }

  // A widget declares its settings; this renders them. No widget-specific code
  // here, so adding a setting is one entry in the registry.
  function settingRow(id, spec, value) {
    let input;
    if (spec.type === "select" || spec.type === "multi") {
      input = el("select", { class: "set-input" },
        ...(spec.choices || []).map((c) =>
          el("option", { value: String(c.value), text: c.label })));
      if (spec.type === "multi") input.multiple = true;
      const chosen = spec.type === "multi"
        ? String(value ?? "").split(",").filter(Boolean)
        : [String(value ?? spec.default ?? "")];
      for (const opt of input.options) opt.selected = chosen.includes(opt.value);
      input.addEventListener("change", () => {
        const picked = [...input.selectedOptions].map((o) => o.value);
        setWidgetConfig(id, { [spec.key]: spec.type === "multi" ? picked.join(",") : picked[0] });
      });
    } else {
      input = el("input", {
        class: "set-input", type: spec.type === "number" ? "number" : "text",
        ...(spec.min != null ? { min: spec.min } : {}),
        ...(spec.max != null ? { max: spec.max } : {}),
      });
      input.value = value ?? spec.default ?? "";
      input.addEventListener("change", () => {
        setWidgetConfig(id, {
          [spec.key]: spec.type === "number" ? Number(input.value) : input.value,
        });
      });
    }
    return el("div", { class: `set-row set-widget-row${spec.type === "multi" ? " tall" : ""}` },
      el("span", { class: "set-name" }, spec.label,
        spec.help ? el("span", { class: "set-sub", text: spec.help }) : null),
      input);
  }

  // ---- pointer-drag reorder ----

  let dragRow = null;

  function startDrag(e, row) {
    e.preventDefault();
    dragRow = row.closest(".set-item") || row;
    row.classList.add("dragging");
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // Slot the dragged row before whichever sibling its midpoint has passed.
  function onMove(e) {
    if (!dragRow) return;
    const rows = [...list.querySelectorAll(".set-item:not(.dragging)")];
    const after = rows.find((r) => {
      const box = r.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) list.insertBefore(dragRow, after);
    else list.appendChild(dragRow);
  }

  function endDrag(e) {
    if (!dragRow) return;
    const handle = e.currentTarget;
    handle.releasePointerCapture?.(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", endDrag);
    handle.removeEventListener("pointercancel", endDrag);
    dragRow.classList.remove("dragging");
    dragRow = null;
    setOrder([...list.querySelectorAll(".set-item")].map((r) => r.dataset.id));
  }
}
