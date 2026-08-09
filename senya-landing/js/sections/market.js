// Market map — the S&P 500 as blocks, the way finviz draws it: one rectangle per
// company, area ∝ market cap, colour ∝ performance over the selected period,
// grouped into sector blocks.
//
// Two data sources, deliberately split by how often they change:
//   • structure (sector → ticker → market cap) — /data/market-map.json, a static
//     snapshot; index membership and caps move quarterly, not minutely. Refresh
//     it with tools/extract-map-structure.py.
//   • performance — /market/perf?st=<period>, nginx's cached proxy to finviz's
//     JSON (they send no CORS headers, so it can't be fetched directly).
//
// Layout is a squarified treemap computed here (no chart library): sectors are
// laid out in the widget's box, then each sector's tickers inside its rectangle.

import { el, fetchJSON, store } from "../utils.js";

const STRUCTURE_URL = "data/market-map.json";
const REFRESH_MS = 60 * 1000;
const PERIOD_KEY = "senya.market.period";

// finviz's `st` values, with the |%| thresholds each period is read against —
// a 2% day is a big move, a 2% year is noise, so the colour scale rescales.
const PERIODS = [
  { id: "d1", label: "1D", steps: [0.3, 1, 2, 4] },
  { id: "w1", label: "1W", steps: [0.5, 2, 4, 8] },
  { id: "w4", label: "1M", steps: [1, 3, 6, 12] },
  { id: "w13", label: "3M", steps: [2, 5, 10, 20] },
  { id: "w52", label: "1Y", steps: [3, 10, 20, 40] },
  { id: "ytd", label: "YTD", steps: [3, 10, 20, 40] },
];

// Diverging scale: red ↓ / neutral / green ↑, four steps per arm. Both arms are
// lightness-monotonic and every step holds ≥ 4.5:1 against the block label, so
// the number stays readable on any tile — colour is never the only encoding.
const DOWN = ["#45202a", "#702534", "#9a2f3e", "#c53a4a"];
const UP = ["#0e3d29", "#115434", "#136a44", "#15794c"];
const FLAT = "#232734";

function colorFor(pct, steps) {
  if (typeof pct !== "number") return "#1a1d27";
  const arm = pct >= 0 ? UP : DOWN;
  const mag = Math.abs(pct);
  if (mag < steps[0]) return FLAT;
  let i = 0;
  while (i < steps.length - 1 && mag >= steps[i + 1]) i++;
  return arm[i];
}

// ---- squarified treemap (Bruls, Huizing & van Wijk) ----
// Lays `items` ([{value, …}], descending) into the rect, returning each with
// x/y/w/h. Keeps rectangles near-square, which is what makes the map readable.
function squarify(items, x, y, w, h) {
  const out = [];
  let rest = items.filter((it) => it.value > 0);
  const total = rest.reduce((s, it) => s + it.value, 0);
  if (!total || w <= 0 || h <= 0) return out;

  let scale = (w * h) / total;
  let row = [];

  const worst = (row, len) => {
    if (!row.length || !len) return Infinity;
    const sum = row.reduce((s, it) => s + it.value * scale, 0);
    const max = Math.max(...row.map((it) => it.value * scale));
    const min = Math.min(...row.map((it) => it.value * scale));
    return Math.max((len * len * max) / (sum * sum), (sum * sum) / (len * len * min));
  };

  while (rest.length) {
    const vertical = w >= h;      // fill along the shorter side
    const len = vertical ? h : w;
    const next = rest[0];

    if (row.length && worst([...row, next], len) > worst(row, len)) {
      // Row is as square as it gets — place it and start a new one.
      const sum = row.reduce((s, it) => s + it.value * scale, 0);
      const thick = sum / len;
      let off = 0;
      for (const it of row) {
        const side = (it.value * scale) / thick;
        out.push(vertical
          ? { ...it, x, y: y + off, w: thick, h: side }
          : { ...it, x: x + off, y, w: side, h: thick });
        off += side;
      }
      if (vertical) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      row = [];
      continue;
    }
    row.push(next);
    rest = rest.slice(1);
  }

  // Flush the final row into whatever space is left.
  if (row.length) {
    const vertical = w >= h;
    const len = vertical ? h : w;
    const sum = row.reduce((s, it) => s + it.value * scale, 0);
    const thick = len ? sum / len : 0;
    let off = 0;
    for (const it of row) {
      const side = thick ? (it.value * scale) / thick : 0;
      out.push(vertical
        ? { ...it, x, y: y + off, w: thick, h: side }
        : { ...it, x: x + off, y, w: side, h: thick });
      off += side;
    }
  }
  return out;
}

const fmtPct = (p) => `${p > 0 ? "+" : ""}${p.toFixed(p >= 100 || p <= -100 ? 0 : 1)}%`;
const pctClass = (p) => (typeof p !== "number" ? "cx-flat" : p > 0 ? "cx-up" : p < 0 ? "cx-down" : "cx-flat");

// Sector roll-up behind the hover panel: the sector's own performance plus its
// biggest constituents.
//
// The headline number is **cap-weighted**, not a plain mean — it has to be, or it
// wouldn't agree with the map it sits on. The treemap sizes every block by market
// cap, so a move in a mega-cap is what actually moves the sector, whereas an
// equal-weight average lets the smallest member shout as loudly as the largest.
// Tickers with no quote are left out of the weighting rather than counted as 0%,
// so a data gap can't drag the sector toward flat.
const TOP_N = 10;

function sectorStats(sector, perf) {
  const rows = sector.tickers.map((t) => ({ ...t, pct: perf[t.t] }));
  const cap = rows.reduce((s, r) => s + r.v, 0);
  const priced = rows.filter((r) => typeof r.pct === "number");
  const pricedCap = priced.reduce((s, r) => s + r.v, 0);
  return {
    cap,
    count: rows.length,
    missing: rows.length - priced.length,
    weighted: pricedCap ? priced.reduce((s, r) => s + r.v * r.pct, 0) / pricedCap : null,
    top: [...rows].sort((a, b) => b.v - a.v).slice(0, TOP_N),
  };
}

export function initMarket() {
  const wrap = document.getElementById("market");
  if (!wrap) return;

  let period = PERIODS.find((p) => p.id === store.get(PERIOD_KEY, "w1")) || PERIODS[1];
  let structure = null;   // [{sector, tickers:[{t,n,i,v}]}]
  let perf = null;        // {TICKER: pct}

  const tabs = el("div", { class: "mk-tabs" });
  const canvas = el("div", { class: "mk-canvas" }, el("div", { class: "offline-msg", text: "Loading map…" }));
  const legend = el("div", { class: "mk-legend" });
  wrap.replaceChildren(el("div", { class: "mk-head" }, tabs, legend), canvas);

  function renderTabs() {
    tabs.replaceChildren(...PERIODS.map((p) =>
      el("button", {
        type: "button", class: "mk-tab" + (p.id === period.id ? " active" : ""), text: p.label,
        onclick: () => { period = p; store.set(PERIOD_KEY, p.id); renderTabs(); renderLegend(); load(); },
      })));
  }

  // The scale, spelled out — so a colour can always be read back as a number.
  function renderLegend() {
    const cells = [];
    for (let i = DOWN.length - 1; i >= 0; i--) {
      cells.push(el("span", { class: "mk-key", style: `background:${DOWN[i]}`, title: `≤ −${period.steps[i]}%` }));
    }
    cells.push(el("span", { class: "mk-key", style: `background:${FLAT}`, title: "flat" }));
    for (let i = 0; i < UP.length; i++) {
      cells.push(el("span", { class: "mk-key", style: `background:${UP[i]}`, title: `≥ +${period.steps[i]}%` }));
    }
    legend.replaceChildren(
      el("span", { class: "mk-legend-end", text: `−${period.steps.at(-1)}%` }),
      ...cells,
      el("span", { class: "mk-legend-end", text: `+${period.steps.at(-1)}%` }));
  }

  // ---- sector hover panel ----
  // Lives on <body> with position:fixed: .mk-canvas is overflow:hidden, so a
  // panel parented inside it would be clipped by the very box it overhangs.
  const pop = el("div", { class: "mk-pop", hidden: "" });
  document.body.append(pop);
  let openSector = null;   // sector name, so a redraw can re-anchor and keep it
  let showTimer = 0, hideTimer = 0;

  const clearTimers = () => { clearTimeout(showTimer); clearTimeout(hideTimer); };

  function hidePop() {
    clearTimers();
    pop.hidden = true;
    openSector = null;
  }

  function fillPop(sector) {
    const s = sectorStats(sector, perf);
    const rows = s.top.map((r) =>
      el("div", { class: "mk-pop-row" },
        el("span", { class: "mk-pop-t", text: r.t }),
        el("span", { class: "mk-pop-n", text: r.n, title: `${r.n} · ${r.i}` }),
        el("span", { class: "mk-pop-w", text: `${((r.v / s.cap) * 100).toFixed(1)}%` }),
        el("span", {
          class: `mk-pop-p ${pctClass(r.pct)}`,
          text: typeof r.pct === "number" ? fmtPct(r.pct) : "—",
        })));

    pop.replaceChildren(
      el("div", { class: "mk-pop-head" },
        el("span", { class: "mk-pop-name", text: sector.sector }),
        el("span", {
          class: `mk-pop-agg ${pctClass(s.weighted)}`,
          text: typeof s.weighted === "number" ? fmtPct(s.weighted) : "no data",
        })),
      el("div", {
        class: "mk-pop-sub",
        text: `cap-weighted · ${period.label} · ${s.count} companies`
          + (s.missing ? ` · ${s.missing} unpriced` : ""),
      }),
      el("div", { class: "mk-pop-cols" },
        el("span", { text: `top ${Math.min(TOP_N, s.count)} by market cap` }),
        el("span", { class: "mk-pop-w", text: "weight" }),
        el("span", { class: "mk-pop-p", text: period.label })),
      el("div", { class: "mk-pop-rows" }, ...rows));
  }

  // Anchor under the label, then clamp into the viewport; flip above if the
  // panel would run off the bottom.
  function placePop(anchor) {
    const a = anchor.getBoundingClientRect();
    pop.hidden = false;
    const p = pop.getBoundingClientRect();
    const margin = 8;
    let left = a.left;
    left = Math.min(left, window.innerWidth - p.width - margin);
    left = Math.max(margin, left);
    let top = a.bottom + 4;
    if (top + p.height > window.innerHeight - margin) {
      const above = a.top - p.height - 4;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - p.height - margin);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function showPop(sector, anchor) {
    if (!perf) return;
    openSector = sector.sector;
    fillPop(sector);
    placePop(anchor);
  }

  // Hovering the panel keeps it up, so you can read (or scroll) it without it
  // vanishing the moment the pointer leaves the label.
  pop.addEventListener("mouseenter", clearTimers);
  pop.addEventListener("mouseleave", () => { hideTimer = setTimeout(hidePop, 160); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePop(); });
  window.addEventListener("scroll", () => { if (openSector) hidePop(); }, { passive: true });

  function wireSectorLabel(label, sector) {
    label.tabIndex = 0;
    label.addEventListener("mouseenter", () => {
      clearTimers();
      showTimer = setTimeout(() => showPop(sector, label), 90);  // ignore sweeps
    });
    label.addEventListener("mouseleave", () => {
      clearTimeout(showTimer);
      hideTimer = setTimeout(hidePop, 160);
    });
    label.addEventListener("focus", () => showPop(sector, label));
    label.addEventListener("blur", () => { hideTimer = setTimeout(hidePop, 160); });
    // Touch has no hover: tap the label to toggle the same panel.
    label.addEventListener("click", (e) => {
      e.preventDefault();
      if (openSector === sector.sector) hidePop();
      else { clearTimers(); showPop(sector, label); }
    });
  }

  function draw() {
    if (!structure || !perf) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;

    // Sector rectangles first, sized by the market cap they contain.
    const sectors = structure
      .map((s) => ({ ...s, value: s.tickers.reduce((sum, t) => sum + t.v, 0) }))
      .sort((a, b) => b.value - a.value);

    const nodes = [];
    const labels = new Map();   // sector name -> its label element, for re-anchoring
    for (const sec of squarify(sectors, 0, 0, w, h)) {
      const box = el("div", { class: "mk-sector", style: `left:${sec.x}px;top:${sec.y}px;width:${sec.w}px;height:${sec.h}px` });
      if (sec.h > 26 && sec.w > 54) {
        const label = el("div", {
          class: "mk-sector-name", text: sec.sector,
          title: `${sec.sector} — hover for its top ${TOP_N} and sector performance`,
        });
        wireSectorLabel(label, sec);
        labels.set(sec.sector, label);
        box.append(label);
      }
      nodes.push(box);

      // Tickers inside the sector, leaving room for its label strip.
      const pad = sec.h > 26 && sec.w > 54 ? 13 : 1;
      const items = sec.tickers.map((t) => ({ ...t, value: t.v }));
      for (const b of squarify(items, 1, pad, Math.max(0, sec.w - 2), Math.max(0, sec.h - pad - 1))) {
        const pct = perf[b.t];
        const tile = el("a", {
          class: "mk-tile", href: `https://finviz.com/quote.ashx?t=${b.t}`,
          target: "_blank", rel: "noopener noreferrer",
          title: `${b.t} · ${b.n}\n${b.i}\n${typeof pct === "number" ? fmtPct(pct) : "no data"}`,
          style: `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:${colorFor(pct, period.steps)}`,
        });
        // Only label a tile that can actually hold the text.
        if (b.w > 30 && b.h > 15) {
          tile.append(el("span", { class: "mk-t", text: b.t }));
          if (b.h > 27 && typeof pct === "number") tile.append(el("span", { class: "mk-p", text: fmtPct(pct) }));
        }
        box.append(tile);
      }
    }
    canvas.replaceChildren(...nodes);

    // A redraw (60s refresh, or a resize) throws away the element the panel was
    // anchored to. Re-point it at the new one and refresh the numbers rather
    // than yanking it out from under someone mid-read.
    if (openSector) {
      const sector = sectors.find((s) => s.sector === openSector);
      const label = labels.get(openSector);
      if (sector && label) showPop(sector, label);
      else hidePop();
    }
  }

  async function load() {
    try {
      if (!structure) structure = await fetchJSON(STRUCTURE_URL);
      const data = await fetchJSON(`/market/perf?st=${period.id}`);
      perf = data.nodes || data;
      draw();
    } catch (e) {
      console.error("[senya] market map failed:", e);
      canvas.replaceChildren(el("div", { class: "offline-msg", text: "Market data unavailable" }));
    }
  }

  renderTabs();
  renderLegend();
  load();
  setInterval(load, REFRESH_MS);

  // The widget shares a responsive grid — re-lay the blocks when its cell resizes.
  if (window.ResizeObserver) {
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(canvas);
  }
}
