import { internal } from "../config.js";
import { el, link, iconImg, fetchJSON } from "../utils.js";

// How often to re-poll container states.
const STATUS_REFRESH_MS = 15000;

// Glances containers plugins, same-origin via nginx (/stats/<host>/containers).
// We union every host so a service on any box gets a state. To track containers
// on another host, install Glances there with the containers plugin, add a
// matching /stats/<host>/ proxy in nginx.conf, then add its URL here.
const STATUS_SOURCES = ["/stats/xps/containers"];

// Glances `status` strings → our dot state.
const UP = new Set(["running", "healthy"]);
const WARN = new Set(["starting", "restarting", "unhealthy", "created", "paused"]);

// Two registry entries (Senya Apps, Services) share one status poller. The Senya
// and Services lists may be built at different times (lazy mount), so the poller
// re-queries the DOM each tick and is started only once.
export function initSenyaApps() {
  renderList("senya-apps", internal?.SENYA_APPS);
  startStatusPolling();
}

export function initServices() {
  renderList("services", internal?.SERVICES);
  startStatusPolling();
}

function renderList(containerId, items) {
  const wrap = document.getElementById(containerId);
  if (!wrap || !items) return;
  for (const s of items) {
    // Live up/down dot, pinned to the icon tile's corner. Services with a
    // `container` get polled; others stay neutral ("unknown") since we can't
    // see their docker state.
    const dot = el("span", { class: "svc-status unknown", title: "status…" });
    if (s.container) dot.dataset.container = s.container;

    // Icon tile frames the favicon and carries the status dot.
    const icon = el("div", { class: "svc-icon" }, iconImg(s.icon), dot);
    const head = el("div", { class: "svc-head" }, icon,
      el("span", { class: "svc-name", title: s.name, text: s.name }));

    wrap.appendChild(el("div", { class: "svc" }, head, el_links(s)));
  }
}

// ----- container status -----

// Fetch + merge the container lists from all hosts into name → status. Returns
// null only if EVERY source failed (so we can show "unknown" instead of "down").
async function fetchStatuses() {
  const results = await Promise.allSettled(STATUS_SOURCES.map((u) => fetchJSON(u)));
  const map = new Map();
  let anyOk = false;
  for (const r of results) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    anyOk = true;
    for (const c of r.value) {
      if (c && c.name) map.set(c.name, String(c.status || "").toLowerCase());
    }
  }
  return anyOk ? map : null;
}

function applyDot(dot, map) {
  const name = dot.dataset.container;
  dot.classList.remove("up", "down", "warn", "unknown");
  if (!name) { dot.classList.add("unknown"); dot.title = "no container"; return; }
  if (map === null) { dot.classList.add("unknown"); dot.title = "status unavailable"; return; }
  const status = map.get(name); // undefined → Glances only lists running, so it's stopped
  if (status === undefined) { dot.classList.add("down"); dot.title = "stopped"; return; }
  if (UP.has(status)) { dot.classList.add("up"); dot.title = "running"; }
  else if (WARN.has(status)) { dot.classList.add("warn"); dot.title = status; }
  else { dot.classList.add("down"); dot.title = status || "stopped"; }
}

let polling = false;
function startStatusPolling() {
  if (polling) return; // shared across both lists — start once
  polling = true;
  const tick = async () => {
    // Re-query each tick so dots added by a lazily-mounted list get updated too.
    const dots = [...document.querySelectorAll(".svc-status[data-container]")];
    if (!dots.length) return;
    const map = await fetchStatuses();
    for (const dot of dots) applyDot(dot, map);
  };
  tick();
  setInterval(tick, STATUS_REFRESH_MS);
}

function el_links(s) {
  const links = el("div", { class: "svc-links" });
  // Services on another host override the default IPs; omit `port` for the
  // host's default web port (80).
  const localIp = s.localIp || internal.LOCAL_IP;
  const tsIp = s.tsIp || internal.TAILSCALE_IP;
  const port = s.port ? `:${s.port}` : "";
  links.appendChild(link("local", `http://${localIp}${port}`, "pill"));
  links.appendChild(link("ts", `http://${tsIp}${port}`, "pill ts"));
  // External (Cloudflare tunnel) link, only when the service is exposed publicly.
  if (s.ext && internal.PUBLIC_DOMAIN) {
    links.appendChild(link("ext", `https://${s.ext}.${internal.PUBLIC_DOMAIN}`, "pill ext"));
  }
  return links;
}
