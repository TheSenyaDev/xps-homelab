const tailscaleMap = {
  3002: "http://100.121.230.17:3002",
  3001: "http://100.121.230.17:3001",
  9000: "http://100.121.230.17:9000",
  9090: "http://100.121.230.17:9090",
  5230: "http://100.121.230.17:5230",
  3456: "http://100.121.230.17:3456",
  8080: "http://100.121.230.17:8080",
  4000: "http://100.121.230.17:4000",
  61208: "http://100.121.230.17:61208",
  3000: "http://100.121.230.17:3000",
  3003: "http://100.121.230.17:3003",
  5232: "http://100.121.230.17:5232",
};

function addTailscaleButtons() {
  const links = document.querySelectorAll('a[href*="192.168.2.100"]');
  links.forEach((link) => {
    const card = link.closest("li") || link.parentElement;
    if (!card || card.dataset.tsAdded) return;
    card.dataset.tsAdded = "true";

    const match = link.href.match(/:(\d+)/);
    if (!match) return;
    const port = match[1];
    const tsUrl = tailscaleMap[port];
    if (!tsUrl) return;

    // Prevent the original link from navigating
    link.addEventListener("click", (e) => e.preventDefault());
    link.style.cursor = "default";

    card.style.position = "relative";

    const wrapper = document.createElement("div");
    wrapper.className = "ts-btn-wrapper";

    const localBtn = document.createElement("a");
    localBtn.href = link.href;
    localBtn.target = "_blank";
    localBtn.rel = "noopener";
    localBtn.className = "ts-btn ts-btn-local";
    localBtn.textContent = "Local";
    localBtn.addEventListener("click", (e) => e.stopPropagation());

    const tsBtn = document.createElement("a");
    tsBtn.href = tsUrl;
    tsBtn.target = "_blank";
    tsBtn.rel = "noopener";
    tsBtn.className = "ts-btn ts-btn-tailscale";
    tsBtn.textContent = "Tailscale";
    tsBtn.addEventListener("click", (e) => e.stopPropagation());

    wrapper.appendChild(localBtn);
    wrapper.appendChild(tsBtn);
    card.appendChild(wrapper);
  });
}

const observer = new MutationObserver(addTailscaleButtons);
observer.observe(document.body, { childList: true, subtree: true });
addTailscaleButtons();
