// ============================================================
//  PUBLIC-SAFE config. This file is served to everyone, so it
//  contains NO internal IPs. Internal data lives in services.js,
//  which nginx only serves to LAN / Tailscale clients.
// ============================================================

const BOOKMARKS = [
  { name: "Proton Mail", url: "https://mail.proton.me" },
  { name: "GitHub", url: "https://github.com" },
  { name: "Claude", url: "https://claude.ai" },
  { name: "ChatGPT", url: "https://chat.openai.com" },
  { name: "YouTube", url: "https://youtube.com" },
  { name: "Reddit", url: "https://reddit.com" },
  { name: "Cloudflare", url: "https://dash.cloudflare.com" },
  { name: "Tailscale", url: "https://login.tailscale.com/admin" },
  { name: "Wikipedia", url: "https://wikipedia.org" },
  { name: "Hacker News", url: "https://news.ycombinator.com" },
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

function renderBookmarks() {
  const grid = document.getElementById("bookmarks");
  for (const b of BOOKMARKS) grid.appendChild(link(b.name, b.url, "card"));
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
    title.textContent = s.name;
    const links = document.createElement("div");
    links.className = "svc-links";
    links.appendChild(link("local", `http://${internal.LOCAL_IP}:${s.port}`, "pill"));
    links.appendChild(link("ts", `http://${internal.TAILSCALE_IP}:${s.port}`, "pill ts"));
    card.append(title, links);
    wrap.appendChild(card);
  }
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
renderServices();
setupEngines();
handleSearch();
tickClock();
setInterval(tickClock, 10000);
