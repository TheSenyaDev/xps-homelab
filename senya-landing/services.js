// ============================================================
//  INTERNAL data — nginx serves this file ONLY to LAN / Tailscale
//  clients (gated by Host header). Public/tunnel requests get 404,
//  so these IPs/ports are never disclosed externally.
//  Edit your services here.
// ============================================================
window.SENYA_INTERNAL = {
  LOCAL_IP: "192.168.2.100",
  TAILSCALE_IP: "100.121.230.17",
  SEARXNG: "http://192.168.2.100:4000/search?q=",
  // Parent domain for services exposed through the Cloudflare tunnel. A service
  // with an `ext` field below gets an extra "ext" link to https://<ext>.<domain>.
  PUBLIC_DOMAIN: "senya.ca",
  // Live system stats. Each host runs Glances (`-w`, port 61208); nginx
  // reverse-proxies it same-origin under /stats/<key>/ (see nginx.conf), gated
  // to LAN/Tailscale only. `key` must match the proxy location in nginx.conf.
  // Adding a host: install Glances on it, add a matching /stats/<key>/ block in
  // nginx.conf pointing at its address, then add an entry here.
  // `power: true` → host also exposes the power-api (proxied at /stats/<key>/power)
  // for RAPL CPU watts and the accurate x86_pkg_temp CPU temperature.
  // `allDisks: true` → list every storage pool/drive (e.g. a NAS) instead of
  // just the largest filesystem. Requires Glances to actually see the pools
  // (on TrueNAS SCALE: mount the host's /mnt into the Glances app, read-only).
  HOSTS: [
    { name: "XPS", key: "xps", icon: "dell", power: true },
    { name: "TrueNAS", key: "truenas", icon: "truenas", allDisks: true },
  ],
  // `icon` = filename (without .png) in /icons, sourced from dashboardicons.com
  // via fetch-icons.sh. Omit `icon` (or point to a missing file) → _default.svg.
  // `ext` = the Cloudflare subdomain if the service is exposed publicly; adds an
  // "ext" link to https://<ext>.<PUBLIC_DOMAIN>. Omit it for LAN/TS-only services.
  // `localIp`/`tsIp` override the default IPs for services on another host;
  // omit `port` to use the host's default web port (80).
  // Custom-built, in-house apps (own section on the landing page). Same shape as
  // SERVICES below; no `icon` → _default.svg.
  // `container` = docker container_name; the landing page shows a live up/down dot
  // by matching it against the Glances containers list (/stats/xps/containers).
  // Omit `container` for things that aren't a local container (remote host, etc.)
  // → the dot shows neutral "unknown".
  SENYA_APPS: [
    { name: "SenyaTasks", port: 8000, container: "senyatasks" },
    { name: "SenyaDaily", port: 8001, container: "senya-daily" },
    { name: "SenyaFinance", port: 8002, container: "senya-finance" },
    { name: "SenyaNotes", port: 8003, container: "senya-notes" },
    { name: "SenyaBoox", port: 8004, container: "senya-boox" },
  ],
  SERVICES: [
    { name: "Homepage", port: 3010, icon: "homepage", container: "homepage" },
    { name: "Homarr", port: 3000, icon: "homarr", container: "homarr" },
    { name: "Grafana", port: 3002, icon: "grafana", container: "grafana" },
    { name: "Portainer", port: 9000, icon: "portainer", container: "portainer" },
    { name: "Glances", port: 61208, icon: "glances", ext: "glances", container: "glances" },
    { name: "Uptime Kuma", port: 3001, icon: "uptime-kuma", container: "uptime-kuma" },
    { name: "Prometheus", port: 9090, icon: "prometheus", container: "prometheus" },
    { name: "SearXNG", port: 4000, icon: "searxng", container: "searxng" },
    { name: "Obsidian", port: 8080, icon: "obsidian", container: "obsidian-remote" },
    { name: "Claude (Chromium)", port: 3003, icon: "claude-ai", container: "claude" },
    { name: "Baikal", port: 5232, icon: "baikal", container: "baikal" },
    { name: "Vaultwarden", port: 8222, icon: "vaultwarden", container: "vaultwarden" },
    { name: "Memos", port: 5230, icon: "memos", container: "memos" },
    { name: "Vikunja", port: 3456, icon: "vikunja", container: "vikunja" },
    { name: "Firefly III", port: 3005, icon: "firefly-iii", container: "firefly" },
    { name: "Firefly Importer", port: 3006, icon: "firefly-iii", container: "firefly-importer" },
    { name: "Miniflux", port: 3007, icon: "miniflux", container: "miniflux" },
    { name: "Jellyfin", port: 30013, icon: "jellyfin", localIp: "192.168.2.82", tsIp: "100.112.73.95" },
    { name: "TrueNAS", icon: "truenas", localIp: "192.168.2.82", tsIp: "100.112.73.95" },
  ],
};
