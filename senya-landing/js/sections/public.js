import { PUBLIC_LINKS } from "../config.js";
import { link, iconImg } from "../utils.js";

export function initPublic() {
  const grid = document.getElementById("public");
  if (!grid) return;
  for (const p of PUBLIC_LINKS) {
    const a = link(p.name, p.url, "card");
    a.prepend(iconImg(p.icon));
    grid.appendChild(a);
  }
}
