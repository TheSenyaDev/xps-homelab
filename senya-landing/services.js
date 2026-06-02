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
  SERVICES: [
    { name: "Homepage", port: 3010 },
    { name: "Homarr", port: 3000 },
    { name: "Grafana", port: 3002 },
    { name: "Portainer", port: 9000 },
    { name: "Glances", port: 61208 },
    { name: "Uptime Kuma", port: 3001 },
    { name: "Prometheus", port: 9090 },
    { name: "SearXNG", port: 4000 },
    { name: "Obsidian", port: 8080 },
    { name: "Claude (Chromium)", port: 3003 },
    { name: "Baikal", port: 5232 },
    { name: "Memos", port: 5230 },
    { name: "Vikunja", port: 3456 },
    { name: "SenyaTasks", port: 8000 },
  ],
};
