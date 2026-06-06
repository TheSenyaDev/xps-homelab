import { BOOKMARKS } from "../config.js";
import { link, iconImg } from "../utils.js";

export function initBookmarks() {
  const grid = document.getElementById("bookmarks");
  if (!grid) return;
  for (const b of BOOKMARKS) {
    const a = link(b.name, b.url, "card");
    a.prepend(iconImg(b.icon));
    grid.appendChild(a);
  }
}
