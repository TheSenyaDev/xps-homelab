// Weather via Open-Meteo (no API key, CORS-enabled). The CSP connect-src allows
// https://api.open-meteo.com. Coordinates come from WEATHER_LOCATIONS (config.js).

import { WEATHER_LOCATIONS } from "../config.js";
import { el, fetchJSON, store } from "../utils.js";

const KEY = "senya.weatherLoc";
const REFRESH_MS = 15 * 60 * 1000;

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
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max",
    timezone: "auto",
    forecast_days: "7",
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

const wxStat = (label, value) =>
  el("div", { class: "wx-stat" },
    el("span", { class: "wx-stat-label", text: label }),
    el("span", { class: "wx-stat-val", text: value }));

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function currentCard(cur, d) {
  const w = wmo(cur.weather_code, cur.is_day === 1);
  return el("div", { class: "wx-now" },
    el("div", { class: "wx-main" },
      el("div", { class: "wx-icon", text: w.icon }),
      el("div", {},
        el("div", { class: "wx-temp", text: `${Math.round(cur.temperature_2m)}°` }),
        el("div", { class: "wx-cond", text: `${w.label} · feels ${Math.round(cur.apparent_temperature)}°` }))),
    el("div", { class: "wx-stats" },
      wxStat("Humidity", `${cur.relative_humidity_2m}%`),
      wxStat("Wind", `${Math.round(cur.wind_speed_10m)} km/h`),
      wxStat("Gusts", `${Math.round(cur.wind_gusts_10m)} km/h`),
      wxStat("Rain today", `${d.precipitation_probability_max[0] ?? 0}%`),
      wxStat("UV", `${Math.round(d.uv_index_max[0])}`),
      wxStat("Sun", `${hhmm(d.sunrise[0])}–${hhmm(d.sunset[0])}`)));
}

// Horizontally-scrollable next-24-hours breakdown, starting at the current hour.
function hourlyStrip(h) {
  if (!h || !Array.isArray(h.time)) return null;
  const fromHour = Date.now() - 3600 * 1000; // keep the current hour in view
  let start = h.time.findIndex((t) => new Date(t).getTime() >= fromHour);
  if (start < 0) start = 0;
  const end = Math.min(start + 24, h.time.length);

  const track = el("div", { class: "wx-hours-track" });
  for (let i = start; i < end; i++) {
    const hh = wmo(h.weather_code[i], h.is_day[i] === 1);
    const label = i === start ? "Now" : new Date(h.time[i]).toLocaleTimeString([], { hour: "numeric" });
    track.append(el("div", { class: "wx-hour" },
      el("div", { class: "wx-htime", text: label }),
      el("div", { class: "wx-hicon", title: hh.label, text: hh.icon }),
      el("div", { class: "wx-htemp", text: `${Math.round(h.temperature_2m[i])}°` }),
      el("div", { class: "wx-hpp", text: `💧${h.precipitation_probability[i] ?? 0}%` })));
  }
  return el("div", { class: "wx-hours" }, track);
}

function forecastStrip(d) {
  const strip = el("div", { class: "wx-days" });
  for (let i = 0; i < d.time.length; i++) {
    const dd = wmo(d.weather_code[i], true);
    const dow = i === 0 ? "Today" : new Date(d.time[i] + "T00:00").toLocaleDateString([], { weekday: "short" });
    strip.append(el("div", { class: "wx-day" },
      el("div", { class: "wx-dow", text: dow }),
      el("div", { class: "wx-dicon", title: dd.label, text: dd.icon }),
      el("div", { class: "wx-hl" },
        el("span", { class: "hi", text: `${Math.round(d.temperature_2m_max[i])}°` }),
        el("span", { class: "lo", text: `${Math.round(d.temperature_2m_min[i])}°` })),
      el("div", { class: "wx-pp", text: `💧${d.precipitation_probability_max[i] ?? 0}%` })));
  }
  return strip;
}

async function load(loc, wrap) {
  wrap.replaceChildren(el("div", { class: "offline-msg", text: "Loading weather…" }));
  try {
    const data = await fetchJSON(weatherURL(loc));
    const parts = [
      currentCard(data.current, data.daily),
      hourlyStrip(data.hourly),
      forecastStrip(data.daily),
    ].filter(Boolean);
    wrap.replaceChildren(...parts);
  } catch (e) {
    console.error("[senya] weather load failed:", e);
    wrap.replaceChildren(el("div", { class: "offline-msg", text: "Weather unavailable" }));
  }
}

export function initWeather() {
  const section = document.getElementById("weather-section");
  if (!section) return;
  if (!Array.isArray(WEATHER_LOCATIONS) || !WEATHER_LOCATIONS.length) {
    section.remove();
    return;
  }

  const wrap = document.getElementById("weather");
  const locsEl = document.getElementById("weather-locs");
  const locOf = (name) => WEATHER_LOCATIONS.find((l) => l.name === name) || WEATHER_LOCATIONS[0];

  let current = store.get(KEY, WEATHER_LOCATIONS[0].name);
  if (!WEATHER_LOCATIONS.some((l) => l.name === current)) current = WEATHER_LOCATIONS[0].name;

  const select = (name) => {
    current = name;
    store.set(KEY, name);
    locsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === name));
    load(locOf(name), wrap);
  };

  // Location selector pills (only when there's more than one).
  if (WEATHER_LOCATIONS.length > 1) {
    for (const loc of WEATHER_LOCATIONS) {
      locsEl.append(el("button", {
        type: "button",
        class: "wx-loc" + (loc.name === current ? " active" : ""),
        text: loc.name,
        onclick: () => select(loc.name),
      }));
    }
  }

  load(locOf(current), wrap);
  setInterval(() => load(locOf(current), wrap), REFRESH_MS);
}
