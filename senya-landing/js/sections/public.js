import { PUBLIC_LINKS } from "../config.js";
import { link, iconImg } from "../utils.js";

export function initPublic() {
  const section = document.getElementById("public-section");
  if (!section) return;
  if (!Array.isArray(PUBLIC_LINKS) || !PUBLIC_LINKS.length) {
    section.remove();
    return;
  }
  const grid = document.getElementById("public");
  for (const p of PUBLIC_LINKS) {
    const a = link(p.name, p.url, "card");
    a.prepend(iconImg(p.icon));
    grid.appendChild(a);
  }
}
