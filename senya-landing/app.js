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

// Weather locations (public-safe — shown on/off network). Edit this list; the
// first is the default. Find coordinates for a city at https://open-meteo.com.
const WEATHER_LOCATIONS = [
  { name: "Toronto", lat: 43.6532, lon: -79.3832 },
  { name: "Montreal", lat: 45.5019, lon: -73.5674 },
  { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
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
    // External (Cloudflare tunnel) link, only when the service is exposed publicly.
    if (s.ext && internal.PUBLIC_DOMAIN) {
      links.appendChild(link("ext", `https://${s.ext}.${internal.PUBLIC_DOMAIN}`, "pill ext"));
    }
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

// ------------------------------------------------------------
//  Weather — Open-Meteo (no API key, CORS-enabled). The CSP connect-src
//  allows https://api.open-meteo.com. Coordinates come from WEATHER_LOCATIONS.
// ------------------------------------------------------------

const WEATHER_KEY = "senya.weatherLoc";

// WMO weather code → { icon, label }. `day` picks sun/moon for clear sky.
function wmo(code, day = true) {
  const C = (icon, label) => ({ icon, label });
  switch (code) {
    case 0: return C(day ? "☀️" : "🌙", "Clear");
    case 1: return C(day ? "🌤️" : "🌙", "Mainly clear");
    case 2: return C("⛅", "Partly cloudy");
    case 3: return C("☁️", "Overcast");
    case 45: case 48: return C("🌫️", "Fog");
    case 51: case 53: case 55: return C("🌦️", "Drizzle");
    case 56: case 57: return C("🌧️", "Freezing drizzle");
    case 61: case 63: case 65: return C("🌧️", "Rain");
    case 66: case 67: return C("🌧️", "Freezing rain");
    case 71: case 73: case 75: return C("🌨️", "Snow");
    case 77: return C("🌨️", "Snow grains");
    case 80: case 81: case 82: return C("🌦️", "Showers");
    case 85: case 86: return C("🌨️", "Snow showers");
    case 95: return C("⛈️", "Thunderstorm");
    case 96: case 99: return C("⛈️", "Thunderstorm, hail");
    default: return C("❓", "—");
  }
}

function weatherURL(loc) {
  const p = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_gusts_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max",
    timezone: "auto",
    forecast_days: "7",
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

function wxStat(label, value) {
  const c = document.createElement("div");
  c.className = "wx-stat";
  const l = document.createElement("span"); l.className = "wx-stat-label"; l.textContent = label;
  const v = document.createElement("span"); v.className = "wx-stat-val"; v.textContent = value;
  c.append(l, v);
  return c;
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function loadWeather(loc, wrap) {
  wrap.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "offline-msg";
  loading.textContent = "Loading weather…";
  wrap.appendChild(loading);
  try {
    const data = await fetchJSON(weatherURL(loc));
    const cur = data.current;
    const d = data.daily;
    const w = wmo(cur.weather_code, cur.is_day === 1);
    wrap.replaceChildren();

    // Current conditions
    const now = document.createElement("div");
    now.className = "wx-now";
    const main = document.createElement("div");
    main.className = "wx-main";
    const icon = document.createElement("div"); icon.className = "wx-icon"; icon.textContent = w.icon;
    const tw = document.createElement("div");
    const temp = document.createElement("div"); temp.className = "wx-temp"; temp.textContent = `${Math.round(cur.temperature_2m)}°`;
    const cond = document.createElement("div"); cond.className = "wx-cond";
    cond.textContent = `${w.label} · feels ${Math.round(cur.apparent_temperature)}°`;
    tw.append(temp, cond);
    main.append(icon, tw);

    const stats = document.createElement("div");
    stats.className = "wx-stats";
    stats.append(
      wxStat("Humidity", `${cur.relative_humidity_2m}%`),
      wxStat("Wind", `${Math.round(cur.wind_speed_10m)} km/h`),
      wxStat("Gusts", `${Math.round(cur.wind_gusts_10m)} km/h`),
      wxStat("Rain today", `${d.precipitation_probability_max[0] ?? 0}%`),
      wxStat("UV", `${Math.round(d.uv_index_max[0])}`),
      wxStat("Sun", `${hhmm(d.sunrise[0])}–${hhmm(d.sunset[0])}`),
    );
    now.append(main, stats);

    // 7-day forecast strip
    const days = document.createElement("div");
    days.className = "wx-days";
    for (let i = 0; i < d.time.length; i++) {
      const dd = wmo(d.weather_code[i], true);
      const cell = document.createElement("div");
      cell.className = "wx-day";
      const dow = document.createElement("div"); dow.className = "wx-dow";
      dow.textContent = i === 0 ? "Today" : new Date(d.time[i] + "T00:00").toLocaleDateString([], { weekday: "short" });
      const di = document.createElement("div"); di.className = "wx-dicon"; di.textContent = dd.icon; di.title = dd.label;
      const hl = document.createElement("div"); hl.className = "wx-hl";
      const hi = document.createElement("span"); hi.className = "hi"; hi.textContent = `${Math.round(d.temperature_2m_max[i])}°`;
      const lo = document.createElement("span"); lo.className = "lo"; lo.textContent = `${Math.round(d.temperature_2m_min[i])}°`;
      hl.append(hi, lo);
      const pp = document.createElement("div"); pp.className = "wx-pp"; pp.textContent = `💧${d.precipitation_probability_max[i] ?? 0}%`;
      cell.append(dow, di, hl, pp);
      days.append(cell);
    }

    wrap.append(now, days);
  } catch (e) {
    wrap.replaceChildren();
    const msg = document.createElement("div");
    msg.className = "offline-msg";
    msg.textContent = "Weather unavailable";
    wrap.appendChild(msg);
  }
}

function renderWeather() {
  if (!Array.isArray(WEATHER_LOCATIONS) || !WEATHER_LOCATIONS.length) {
    document.getElementById("weather-section").remove();
    return;
  }
  const wrap = document.getElementById("weather");
  const locsEl = document.getElementById("weather-locs");
  let current = localStorage.getItem(WEATHER_KEY) || WEATHER_LOCATIONS[0].name;
  if (!WEATHER_LOCATIONS.some((l) => l.name === current)) current = WEATHER_LOCATIONS[0].name;

  const locOf = (name) => WEATHER_LOCATIONS.find((l) => l.name === name);
  const select = (name) => {
    current = name;
    localStorage.setItem(WEATHER_KEY, name);
    locsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === name));
    loadWeather(locOf(name), wrap);
  };

  // Location selector pills (only when there's more than one).
  if (WEATHER_LOCATIONS.length > 1) {
    for (const loc of WEATHER_LOCATIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wx-loc" + (loc.name === current ? " active" : "");
      b.textContent = loc.name;
      b.addEventListener("click", () => select(loc.name));
      locsEl.appendChild(b);
    }
  }
  loadWeather(locOf(current), wrap);
  setInterval(() => loadWeather(locOf(current), wrap), 15 * 60 * 1000); // refresh every 15 min
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
renderWeather();
renderSystem();
renderServices();
setupEngines();
handleSearch();
tickClock();
setInterval(tickClock, 10000);
