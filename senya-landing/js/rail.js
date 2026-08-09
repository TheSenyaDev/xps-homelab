// Rail: condensed launchers for Senya Apps / Services / Public, replacing the
// old js/sections/services.js + js/sections/public.js (safe to delete both —
// this file supersedes their rendering and status polling). Collapsed to just
// icons + a status dot by default; expand (chevron) or click a row for name,
// port, address and container detail. Also drives the top-bar health badge.

import { internal, PUBLIC_LINKS } from "./config.js";
import { el, link, iconImg, fetchJSON, store } from "./utils.js";

const STATUS_REFRESH_MS = 15000;
const EXPANDED_KEY = "senya.rail.expanded"; // remembered across reloads
const FILTER_KEY = "senya.rail.filter";     // "all" or a section key, likewise
const ALL = "all";
const STATUS_SOURCES = ["/stats/xps/containers"];
const UP = new Set(["running", "healthy"]);
const WARN = new Set(["starting", "restarting", "unhealthy", "created", "paused"]);

// Rows are sorted by name here rather than in services.js, so a service added
// to that file lands in the right place on its own instead of depending on
// where it was pasted. Copies the arrays — sorting in place would reorder
// window.SENYA_INTERNAL for anything else reading it.
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const sorted = (items) => [...items].sort(byName);

function sectionsData() {
  const s = [];
  if (internal?.SENYA_APPS?.length) s.push({ key: "senya", name: "Senya Apps", mono: "SA", items: sorted(internal.SENYA_APPS) });
  if (internal?.SERVICES?.length) s.push({ key: "services", name: "Services", mono: "SV", items: sorted(internal.SERVICES) });
  if (PUBLIC_LINKS?.length) s.push({ key: "public", name: "Public", mono: "PB", items: sorted(PUBLIC_LINKS) });
  return s;
}

export function initRail() {
  const rail = document.getElementById("rail");
  const toggle = document.getElementById("rail-toggle");
  const nav = document.getElementById("rail-nav");
  const itemsWrap = document.getElementById("rail-items");
  if (!rail) return;

  const sections = sectionsData();
  if (!sections.length) { rail.hidden = true; return; }

  // Everything, grouped by type, is the default view; the tabs narrow it to one
  // type. Whichever you picked last is what you get next time.
  const stored = store.get(FILTER_KEY, ALL);
  let active = stored === ALL || sections.some((s) => s.key === stored) ? stored : ALL;
  let expanded = store.get(EXPANDED_KEY, "false") === "true";
  let selected = null; // "<section>:<name>" of the row showing inline detail
  let lastMap = null;
  const statusDots = new Map(); // container name -> dot element

  // However you left it — chevron or a row click that expanded it — is how it
  // comes back next reload.
  function setExpanded(v) {
    expanded = v;
    rail.dataset.expanded = String(expanded);
    toggle.textContent = expanded ? "‹" : "›";
    store.set(EXPANDED_KEY, String(expanded));
  }
  setExpanded(expanded);
  toggle.addEventListener("click", () => setExpanded(!expanded));

  function setActive(key) {
    active = key;
    selected = null;
    store.set(FILTER_KEY, key);
    renderNav();
    renderItems();
  }

  function renderNav() {
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    const tabs = [{ key: ALL, mono: "ALL", name: "All services", count: total },
      ...sections.map((s) => ({ key: s.key, mono: s.mono, name: s.name, count: s.items.length }))];

    nav.replaceChildren(...tabs.map((t) => {
      const tab = el("div", { class: "rail-tab" + (t.key === active ? " active" : "") },
        el("span", { class: "rail-tab-mono", text: t.mono }),
        el("span", { class: "rail-tab-name", text: t.name }),
        el("span", { class: "rail-tab-count", text: String(t.count) }));
      tab.title = t.name;
      tab.addEventListener("click", () => setActive(t.key));
      return tab;
    }));
  }

  // Every way to reach a service, as clickable links: LAN, Tailscale, and — for
  // services with an `ext` subdomain — the public tunnel. Items that carry a
  // ready-made `url` (the Public section) just get that one. Each opens in a new
  // window; the port is the service's, or the host's default web port.
  function addrLinks(it) {
    const port = it.port ? `:${it.port}` : "";
    const rows = [];

    if (it.url) {
      rows.push(["url", it.url, it.url.replace(/^https?:\/\//, "")]);
    } else {
      const lan = it.localIp || internal?.LOCAL_IP;
      const ts = it.tsIp || internal?.TAILSCALE_IP;
      if (lan) rows.push(["lan", `http://${lan}${port}`, `${lan}${port}`]);
      if (ts) rows.push(["ts", `http://${ts}${port}`, `${ts}${port}`]);
    }
    if (it.ext && internal?.PUBLIC_DOMAIN) {
      const host = `${it.ext}.${internal.PUBLIC_DOMAIN}`;
      rows.push(["ext", `https://${host}`, host]);
    }
    if (!rows.length) return [el("div", { class: "addr", text: "—" })];

    return rows.map(([kind, href, text]) => {
      const a = link(text, href, `addr-link addr-${kind}`);
      a.title = href;
      a.prepend(el("span", { class: "addr-tag", text: kind.toUpperCase() }));
      // Don't let opening a link collapse the row's detail.
      a.addEventListener("click", (e) => e.stopPropagation());
      return a;
    });
  }

  function itemRow(section, it) {
    // Keyed by the item's own section, not the active tab, so a row's open
    // detail survives switching between "All" and that section.
    const id = `${section.key}:${it.name}`;
    const dot = el("span", { class: "rail-dot" });
    if (it.container) statusDots.set(it.container, dot);
    const row = el("div", { class: "rail-row" + (selected === id ? " selected" : "") },
      iconImg(it.icon), el("span", { class: "rail-name", text: it.name }),
      el("span", { class: "rail-port", text: it.port ? String(it.port) : "—" }), dot);
    row.title = it.name;
    row.addEventListener("click", () => {
      setExpanded(true);
      selected = selected === id ? null : id;
      renderItems();
    });
    const wrap = el("div", {}, row);
    if (selected === id && expanded) {
      wrap.append(el("div", { class: "rail-detail" },
        el("div", { class: "status", text: it.container ? "…" : "unknown" }),
        ...addrLinks(it),
        it.container ? el("div", { class: "container", text: it.container }) : null));
    }
    return wrap;
  }

  function renderItems() {
    statusDots.clear();
    const shown = active === ALL ? sections : sections.filter((s) => s.key === active);
    const nodes = [];
    for (const section of shown) {
      // Headers only earn their space when more than one type is on screen.
      if (shown.length > 1) {
        nodes.push(el("div", { class: "rail-group", title: section.name },
          el("span", { class: "rail-group-mono", text: section.mono }),
          el("span", { class: "rail-group-name", text: section.name }),
          el("span", { class: "rail-group-count", text: String(section.items.length) })));
      }
      nodes.push(...section.items.map((it) => itemRow(section, it)));
    }
    itemsWrap.replaceChildren(...nodes);
    applyDots(lastMap);
  }

  renderNav();
  renderItems();

  // ---- container status polling (shared with health badge) ----

  async function fetchStatuses() {
    const results = await Promise.allSettled(STATUS_SOURCES.map((u) => fetchJSON(u)));
    const map = new Map();
    let anyOk = false;
    for (const r of results) {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
      anyOk = true;
      for (const c of r.value) if (c?.name) map.set(c.name, String(c.status || "").toLowerCase());
    }
    return anyOk ? map : null;
  }

  function stateOf(name, map) {
    if (map === null) return "unknown";
    const status = map.get(name);
    if (status === undefined) return "down";
    if (UP.has(status)) return "up";
    if (WARN.has(status)) return "warn";
    return "down";
  }

  function applyDots(map) {
    for (const [name, dot] of statusDots) {
      const st = stateOf(name, map);
      dot.style.background = st === "up" ? "#10b981" : st === "warn" ? "#f59e0b" : st === "down" ? "#ef4444" : "#4b515f";
    }
    const detail = itemsWrap.querySelector(".rail-detail .status");
    if (detail && selected) {
      const [key, name] = selected.split(":");
      const it = sections.find((s) => s.key === key)?.items.find((x) => x.name === name);
      if (it?.container) { const st = stateOf(it.container, map); detail.textContent = st; detail.style.color = st === "up" ? "#10b981" : st === "warn" ? "#f59e0b" : st === "down" ? "#ef4444" : "#4b515f"; }
    }
    updateHealth(map);
  }

  function updateHealth(map) {
    const dotEl = document.getElementById("health-dot");
    const textEl = document.getElementById("health-text");
    if (!dotEl || !textEl) return;
    const withContainer = [...(internal?.SENYA_APPS || []), ...(internal?.SERVICES || [])].filter((it) => it.container);
    let down = 0, warn = 0;
    for (const it of withContainer) {
      const st = stateOf(it.container, map);
      if (st === "down") down++; else if (st === "warn") warn++;
    }
    dotEl.style.background = down ? "#ef4444" : warn ? "#f59e0b" : "#10b981";
    textEl.textContent = down ? `${down} down · ${warn} warn` : `${withContainer.length} up`;
  }

  async function tick() { lastMap = await fetchStatuses(); applyDots(lastMap); }
  tick();
  setInterval(tick, STATUS_REFRESH_MS);
}
