// SenyaDaily "today" widget. Reads today's note + tracker values from the daily
// app via the same-origin /daily/ proxy (internal only). Display + open link.

import { internal } from "../config.js";
import { el, fetchJSON, link } from "../utils.js";

const REFRESH_MS = 60 * 1000;

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Format a stored value for display, per the tracker's type.
function fmtValue(t, v) {
  if (t.type === "check") return "✓";
  if (t.type === "rating") {
    const n = Math.max(0, Math.min(5, parseInt(v, 10) || 0));
    return "★".repeat(n) + "☆".repeat(5 - n);
  }
  if (t.type === "number") return t.unit ? `${v} ${t.unit}` : `${v}`;
  return v.length > 40 ? v.slice(0, 40) + "…" : v; // text
}

async function load(wrap) {
  try {
    const [trackers, day] = await Promise.all([
      fetchJSON("/daily/api/trackers"),
      fetchJSON(`/daily/api/days/${todayISO()}`),
    ]);
    const byId = new Map(trackers.map((t) => [String(t.id), t]));
    const date = new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

    const head = el("div", { class: "daily-head" },
      el("span", { class: "daily-date", text: date }),
      link("open", `http://${location.hostname}:8001`, "pill"));

    const chips = el("div", { class: "daily-chips" });
    const entries = day.entries || {};
    const ids = Object.keys(entries).filter((id) => byId.has(id));
    if (ids.length) {
      for (const id of ids) {
        const t = byId.get(id);
        chips.append(el("span", { class: "daily-chip", title: t.name },
          el("span", { class: "daily-chip-ico", text: t.icon || "•" }),
          el("span", { text: t.name }),
          el("span", { class: "daily-chip-val", text: fmtValue(t, entries[id]) })));
      }
    } else {
      chips.append(el("span", { class: "offline-msg", text: "Nothing logged yet" }));
    }

    const card = el("div", { class: "daily-card" }, head, chips);
    const note = (day.note || "").trim().replace(/\s+/g, " ");
    if (note) {
      card.append(el("div", { class: "daily-note", text: note.length > 140 ? note.slice(0, 140) + "…" : note }));
    }
    wrap.replaceChildren(card);
  } catch (e) {
    console.error("[senya] daily failed:", e);
    wrap.replaceChildren(el("div", { class: "offline-msg", text: "SenyaDaily unavailable" }));
  }
}

export function initDaily() {
  const section = document.getElementById("daily-section");
  if (!section) return;
  // The /daily/ proxy is gated to LAN/Tailscale, so this is internal-only.
  if (!internal) {
    section.remove();
    return;
  }
  const wrap = document.getElementById("daily");
  load(wrap);
  setInterval(() => load(wrap), REFRESH_MS);
}
