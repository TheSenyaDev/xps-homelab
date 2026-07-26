// Live host stats from each host's Glances REST API, which nginx reverse-proxies
// same-origin under /stats/<key>/ (internal only). Config in services.js → HOSTS.

import { internal } from "../config.js";
import { el, iconImg, fetchJSON } from "../utils.js";

const REFRESH_MS = 5000;

const fmtGB = (bytes) => (bytes / 1073741824).toFixed(bytes >= 1073741824 * 100 ? 0 : 1);

// Hottest temperature sensor reading (°C), or null if none reported.
function pickTemp(sensors) {
  if (!Array.isArray(sensors)) return null;
  const temps = sensors.filter(
    (s) => (s.unit === "C" || String(s.type).startsWith("temperature")) && typeof s.value === "number"
  );
  return temps.length ? temps.reduce((a, b) => (b.value > a.value ? b : a)) : null;
}

// Largest mounted filesystem — the data disk / pool on most boxes.
const pickDisk = (fs) => (Array.isArray(fs) && fs.length ? fs.reduce((a, b) => (b.size > a.size ? b : a)) : null);

// One row per storage pool — for hosts (e.g. TrueNAS) with multiple pools.
// TrueNAS pools mount at /mnt/<pool>, with child datasets at /mnt/<pool>/…
// sharing the pool's free space. ZFS reports each dataset's own `used` and the
// shared `free`, so true pool usage = Σ(dataset used) + sharedFree. We sum used
// across a pool's datasets and take the (consistent) free, which avoids the
// misleading ~0% a pool root shows when its data lives in child datasets.
// Pseudo/bind mounts (/etc/resolv.conf, …) aren't under /mnt, so they're
// ignored. Sorted largest-first; returns {label, used, size, percent}.
function allDisks(fs) {
  if (!Array.isArray(fs)) return [];
  const pools = new Map();
  for (const d of fs) {
    const m = /^\/mnt\/([^/]+)/.exec(d.mnt_point || "");
    if (!m || typeof d.used !== "number") continue;
    const p = pools.get(m[1]) || { label: m[1], used: 0, free: 0 };
    p.used += d.used;
    p.free = Math.max(p.free, d.free || 0); // shared pool-free, same across datasets
    pools.set(m[1], p);
  }
  return [...pools.values()]
    .map((p) => {
      const size = p.used + p.free;
      return { ...p, size, percent: size ? (p.used / size) * 100 : 0 };
    })
    .sort((a, b) => b.size - a.size);
}

// `pct` drives the progress bar (0–100). Pass null for values with no natural
// scale (e.g. watts) to render just the label + value, no bar.
function metricRow(label, value, pct) {
  const head = el("div", { class: "metric-head" },
    el("span", { class: "metric-label", text: label }),
    el("span", { class: "metric-val", text: value }));
  if (typeof pct !== "number") return el("div", { class: "metric" }, head);

  const fill = el("div", { class: "bar-fill" });
  const p = Math.max(0, Math.min(100, pct));
  fill.style.width = p + "%";
  if (p >= 90) fill.classList.add("hot");
  else if (p >= 75) fill.classList.add("warm");
  return el("div", { class: "metric" }, head, el("div", { class: "bar" }, fill));
}

async function refreshHost(host, body) {
  try {
    const [cpu, mem, fs, sensors, power, gpu] = await Promise.all([
      fetchJSON(`/stats/${host.key}/cpu`),
      fetchJSON(`/stats/${host.key}/mem`),
      fetchJSON(`/stats/${host.key}/fs`),
      fetchJSON(`/stats/${host.key}/sensors`).catch(() => []),
      host.power ? fetchJSON(`/stats/${host.key}/power`).catch(() => null) : Promise.resolve(null),
      host.gpu ? fetchJSON(`/stats/${host.key}/gpu`).catch(() => null) : Promise.resolve(null),
    ]);
    body.classList.remove("offline");
    body.replaceChildren(metricRow("CPU", `${Math.round(cpu.total)}%`, cpu.total));
    body.append(metricRow("RAM", `${fmtGB(mem.used)} / ${fmtGB(mem.total)} GB`, mem.percent));

    if (host.allDisks) {
      for (const d of allDisks(fs)) {
        body.append(metricRow(d.label, `${fmtGB(d.used)} / ${fmtGB(d.size)} GB`, d.percent));
      }
    } else {
      const disk = pickDisk(fs);
      if (disk) body.append(metricRow("SSD", `${fmtGB(disk.used)} / ${fmtGB(disk.size)} GB`, disk.percent));
    }

    // Prefer the power-api's x86_pkg_temp (matches Grafana); fall back to the
    // hottest Glances sensor only when there's no power-api on this host.
    const tempC = power && typeof power.cpu_temp_c === "number"
      ? power.cpu_temp_c
      : pickTemp(sensors)?.value;
    if (typeof tempC === "number") body.append(metricRow("Temp", `${Math.round(tempC)}°C`, tempC));

    // NVIDIA GPU temp, from the nvidia-api (`gpu: true` hosts only). The
    // proprietary driver exports no hwmon entry, so this never shows up in the
    // Glances sensors list above. nvidia-api answers 200 with {"error": ...}
    // when nvidia-smi fails, so check the field rather than the status.
    if (gpu && typeof gpu.temp_c === "number") {
      body.append(metricRow("GPU Temp", `${Math.round(gpu.temp_c)}°C`, gpu.temp_c));
    }

    if (power && typeof power.power_w === "number") {
      body.append(metricRow("CPU Power", `${power.power_w.toFixed(1)} W`, null));
    }
  } catch {
    body.classList.add("offline");
    body.replaceChildren(el("span", { class: "offline-msg", text: "offline" }));
  }
}

// Only one address popup is open at a time, page-wide.
let openAddrPopup = null;
function closeAddrPopup() {
  if (!openAddrPopup) return;
  openAddrPopup.pop.hidden = true;
  openAddrPopup.chip.classList.remove("open");
  openAddrPopup.chip.setAttribute("aria-expanded", "false");
  openAddrPopup = null;
}
document.addEventListener("click", closeAddrPopup);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAddrPopup(); });

// Small address chip beside a host name. Clicking it opens a little popup with
// the actual address — clicking that copies it. `kind` is "lan" or "ts".
function addrChip(kind, label, address) {
  const chip = el("button", {
    type: "button", class: `addr-chip addr-${kind}`,
    title: `${label} address`, "aria-expanded": "false", "aria-label": `Show ${label} address`,
  }, el("span", { class: "addr-chip-label", text: label }));

  const value = el("button", { type: "button", class: "addr-pop-val", title: "Click to copy", text: address });
  const pop = el("div", { class: "addr-pop", hidden: "" },
    el("span", { class: "addr-pop-label", text: label }), value);

  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openAddrPopup?.chip === chip;
    closeAddrPopup();
    if (wasOpen) return;
    pop.hidden = false;
    chip.classList.add("open");
    chip.setAttribute("aria-expanded", "true");
    openAddrPopup = { chip, pop };
  });

  value.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      return; // clipboard blocked (non-secure context) — the address is still readable
    }
    value.classList.add("copied");
    setTimeout(() => value.classList.remove("copied"), 1200);
  });
  pop.addEventListener("click", (e) => e.stopPropagation());

  return el("span", { class: "addr-chip-wrap" }, chip, pop);
}

function hostName(host) {
  const name = el("div", { class: "host-name" }, iconImg(host.icon), el("span", { text: host.name }));
  const addrs = el("div", { class: "host-addrs" });
  const lan = host.ip || internal.LOCAL_IP;
  if (lan) addrs.append(addrChip("lan", "LAN", lan));
  if (host.ts) addrs.append(addrChip("ts", "TS", host.ts));
  if (addrs.children.length) name.append(addrs);
  return name;
}

export function initSystem() {
  const wrap = document.getElementById("system");
  if (!wrap) return;
  const bodies = [];
  for (const host of internal.HOSTS) {
    const body = el("div", { class: "host-body" }, el("span", { class: "offline-msg", text: "…" }));
    wrap.append(el("div", { class: "host" }, hostName(host), body));
    bodies.push([host, body]);
  }

  const tick = () => bodies.forEach(([h, b]) => refreshHost(h, b));
  tick();
  setInterval(tick, REFRESH_MS);
}
