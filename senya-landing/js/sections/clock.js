export function initClock() {
  const tick = () => {
    const c = document.getElementById("clock");
    if (c) c.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  tick();
  setInterval(tick, 10000);
}
