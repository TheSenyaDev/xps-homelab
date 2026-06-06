import { internal } from "../config.js";
import { link, iconImg } from "../utils.js";

export function initServices() {
  const section = document.getElementById("services-section");
  if (!section) return;
  // Off-network (public/tunnel): services.js wasn't served — hide the section.
  if (!internal) {
    section.remove();
    return;
  }

  const wrap = document.getElementById("services");
  for (const s of internal.SERVICES) {
    const links = el_links(s);
    const title = document.createElement("span");
    title.className = "svc-name";
    title.append(iconImg(s.icon), s.name);

    const card = document.createElement("div");
    card.className = "svc";
    card.append(title, links);
    wrap.appendChild(card);
  }
}

function el_links(s) {
  const links = document.createElement("div");
  links.className = "svc-links";
  links.appendChild(link("local", `http://${internal.LOCAL_IP}:${s.port}`, "pill"));
  links.appendChild(link("ts", `http://${internal.TAILSCALE_IP}:${s.port}`, "pill ts"));
  // External (Cloudflare tunnel) link, only when the service is exposed publicly.
  if (s.ext && internal.PUBLIC_DOMAIN) {
    links.appendChild(link("ext", `https://${s.ext}.${internal.PUBLIC_DOMAIN}`, "pill ext"));
  }
  return links;
}
