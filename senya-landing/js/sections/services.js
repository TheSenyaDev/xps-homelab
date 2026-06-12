import { internal } from "../config.js";
import { link, iconImg, fetchJSON } from "../utils.js";

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

export function initServices() {
  // Both the Senya-apps and Services lists are internal-only. Off-network
  // (public/tunnel) services.js wasn't served — hide both sections.
  if (!internal) {
    for (const id of ["senya-section", "services-section"]) {
      document.getElementById(id)?.remove();
    }
    return;
  }
  renderList("senya-apps", internal.SENYA_APPS);
  renderList("services", internal.SERVICES);
  startStatusPolling();
}

function renderList(containerId, items) {
  const wrap = document.getElementById(containerId);
  if (!wrap || !items) return;
  for (const s of items) {
    const links = el_links(s);
    const title = document.createElement("span");
    title.className = "svc-name";

    // Live up/down dot. Services with a `container` get polled; others stay
    // neutral ("unknown") since we can't see their docker state.
    const dot = document.createElement("span");
    dot.className = "svc-status unknown";
    dot.title = "status…";
    if (s.container) dot.dataset.container = s.container;

    title.append(dot, iconImg(s.icon), s.name);

    const card = document.createElement("div");
    card.className = "svc";
    card.append(title, links);
    wrap.appendChild(card);
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

async function startStatusPolling() {
  const dots = [...document.querySelectorAll(".svc-status[data-container]")];
  if (!dots.length) return;
  const tick = async () => {
    const map = await fetchStatuses();
    for (const dot of dots) applyDot(dot, map);
  };
  tick();
  setInterval(tick, STATUS_REFRESH_MS);
}

function el_links(s) {
  const links = document.createElement("div");
  links.className = "svc-links";
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
