// ============================================================
//  PUBLIC-SAFE config. This file is served to everyone, so it
//  contains NO internal IPs. Internal data lives in services.js,
//  which nginx only serves to LAN / Tailscale clients.
// ============================================================

// `icon` = filename (without .png) in /icons. Missing → _default.svg fallback.
const BOOKMARKS = [
  { name: "Proton Mail", url: "https://mail.proton.me", icon: "proton-mail" },
  { name: "GitHub", url: "https://github.com", icon: "github-light" },
  { name: "Claude", url: "https://claude.ai", icon: "claude-ai" },
  { name: "ChatGPT", url: "https://chat.openai.com", icon: "openai" },
  { name: "YouTube", url: "https://youtube.com", icon: "youtube" },
  { name: "Reddit", url: "https://reddit.com", icon: "reddit" },
  { name: "Cloudflare", url: "https://dash.cloudflare.com", icon: "cloudflare" },
  { name: "Tailscale", url: "https://login.tailscale.com/admin", icon: "tailscale" },
  { name: "Wikipedia", url: "https://wikipedia.org", icon: "wikipedia" },
  { name: "Hacker News", url: "https://news.ycombinator.com", icon: "hacker-news" },
];

// Present only when services.js loaded (i.e. we're on LAN / Tailscale).
const internal = window.SENYA_INTERNAL || null;

const SEARCH_ENGINES = { google: "https://www.google.com/search?q=" };
if (internal) SEARCH_ENGINES.searxng = internal.SEARXNG;

// ------------------------------------------------------------

const REL = "noopener noreferrer";

function link(name, url, cls) {
  const a = document.createElement("a");
  a.href = url;
  a.textContent = name;
  a.target = "_blank";
  a.rel = REL;
  if (cls) a.className = cls;
  return a;
}

const DEFAULT_ICON = "icons/_default.svg";

// Build an <img> for a local icon. `slug` -> icons/<slug>.png; if absent or the
// file 404s, fall back to the default icon. The error handler is attached in JS
// (not an inline onerror attribute) so it complies with the strict CSP.
function iconImg(slug) {
  const img = document.createElement("img");
  img.className = "ico";
  img.alt = "";
  img.loading = "lazy";
  img.src = slug ? `icons/${slug}.png` : DEFAULT_ICON;
  img.addEventListener("error", function onErr() {
    img.removeEventListener("error", onErr); // avoid loop if default is missing
    img.src = DEFAULT_ICON;
  });
  return img;
}

function renderBookmarks() {
  const grid = document.getElementById("bookmarks");
  for (const b of BOOKMARKS) {
    const a = link(b.name, b.url, "card");
    a.prepend(iconImg(b.icon));
    grid.appendChild(a);
  }
}

function renderServices() {
  const section = document.getElementById("services-section");
  // Off-network (public/tunnel): services.js wasn't served — hide the section.
  if (!internal) {
    section.remove();
    return;
  }
  const wrap = document.getElementById("services");
  for (const s of internal.SERVICES) {
    const card = document.createElement("div");
    card.className = "svc";
    const title = document.createElement("span");
    title.className = "svc-name";
    title.append(iconImg(s.icon), s.name);
    const links = document.createElement("div");
    links.className = "svc-links";
    links.appendChild(link("local", `http://${internal.LOCAL_IP}:${s.port}`, "pill"));
    links.appendChild(link("ts", `http://${internal.TAILSCALE_IP}:${s.port}`, "pill ts"));
    card.append(title, links);
    wrap.appendChild(card);
  }
}

// ------------------------------------------------------------
//  System stats — pulled from each host's Glances REST API, which
//  nginx reverse-proxies same-origin under /stats/<key>/ (internal only).
// ------------------------------------------------------------

const STATS_REFRESH_MS = 5000;

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function fmtGB(bytes) {
  return (bytes / 1073741824).toFixed(bytes >= 1073741824 * 100 ? 0 : 1);
}

// Hottest temperature sensor reading (°C), or null if none reported.
function pickTemp(sensors) {
  if (!Array.isArray(sensors)) return null;
  const temps = sensors.filter(
    (s) => (s.unit === "C" || String(s.type).startsWith("temperature")) &&
           typeof s.value === "number"
  );
  if (!temps.length) return null;
  return temps.reduce((a, b) => (b.value > a.value ? b : a));
}

// Largest mounted filesystem — the data disk / pool on most boxes.
function pickDisk(fs) {
  if (!Array.isArray(fs) || !fs.length) return null;
  return fs.reduce((a, b) => (b.size > a.size ? b : a));
}

function metricRow(label, value, pct) {
  const row = document.createElement("div");
  row.className = "metric";
  const head = document.createElement("div");
  head.className = "metric-head";
  const l = document.createElement("span");
  l.className = "metric-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "metric-val";
  v.textContent = value;
  head.append(l, v);
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  if (typeof pct === "number") {
    const p = Math.max(0, Math.min(100, pct));
    fill.style.width = p + "%";
    if (p >= 90) fill.classList.add("hot");
    else if (p >= 75) fill.classList.add("warm");
  }
  bar.appendChild(fill);
  row.append(head, bar);
  return row;
}

async function refreshHost(host, body) {
  try {
    const [cpu, mem, fs, sensors] = await Promise.all([
      fetchJSON(`/stats/${host.key}/cpu`),
      fetchJSON(`/stats/${host.key}/mem`),
      fetchJSON(`/stats/${host.key}/fs`),
      fetchJSON(`/stats/${host.key}/sensors`).catch(() => []),
    ]);
    body.replaceChildren();
    body.classList.remove("offline");

    body.appendChild(metricRow("CPU", `${Math.round(cpu.total)}%`, cpu.total));
    body.appendChild(
      metricRow("RAM", `${fmtGB(mem.used)} / ${fmtGB(mem.total)} GB`, mem.percent)
    );
    const disk = pickDisk(fs);
    if (disk) {
      body.appendChild(
        metricRow(
          "SSD",
          `${fmtGB(disk.used)} / ${fmtGB(disk.size)} GB`,
          disk.percent
        )
      );
    }
    const temp = pickTemp(sensors);
    if (temp) {
      body.appendChild(metricRow("Temp", `${Math.round(temp.value)}°C`, temp.value));
    }
  } catch (e) {
    body.replaceChildren();
    body.classList.add("offline");
    const msg = document.createElement("span");
    msg.className = "offline-msg";
    msg.textContent = "offline";
    body.appendChild(msg);
  }
}

function renderSystem() {
  const section = document.getElementById("system-section");
  if (!internal || !Array.isArray(internal.HOSTS) || !internal.HOSTS.length) {
    section.remove();
    return;
  }
  const wrap = document.getElementById("system");
  const bodies = [];
  for (const host of internal.HOSTS) {
    const card = document.createElement("div");
    card.className = "host";
    const title = document.createElement("div");
    title.className = "host-name";
    title.append(iconImg(host.icon), host.name);
    const body = document.createElement("div");
    body.className = "host-body";
    const loading = document.createElement("span");
    loading.className = "offline-msg";
    loading.textContent = "…";
    body.appendChild(loading);
    card.append(title, body);
    wrap.appendChild(card);
    bodies.push([host, body]);
  }
  const tick = () => bodies.forEach(([h, b]) => refreshHost(h, b));
  tick();
  setInterval(tick, STATS_REFRESH_MS);
}

function setupEngines() {
  // SearXNG is internal-only; drop the option when off-network.
  if (!internal) {
    const sx = document.querySelector('label[data-engine="searxng"]');
    if (sx) sx.remove();
    document.querySelector('input[name="engine"][value="google"]').checked = true;
  }
}

function handleSearch() {
  document.getElementById("search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("q").value.trim();
    if (!q) return;
    const sel = document.querySelector('input[name="engine"]:checked');
    const engine = sel ? sel.value : "google";
    window.location.href = (SEARCH_ENGINES[engine] || SEARCH_ENGINES.google) + encodeURIComponent(q);
  });
}

function tickClock() {
  document.getElementById("clock").textContent =
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

renderBookmarks();
renderSystem();
renderServices();
setupEngines();
handleSearch();
tickClock();
setInterval(tickClock, 10000);
