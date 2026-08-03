# Fedora PC — host stats

Makes the Fedora PC show up on the [Senya Landing](../senya-landing) System
section as a third card next to **XPS** and **TrueNAS**, with the same metrics:
CPU, RAM, SSD, Temp, and CPU Power.

## How it fits together

```
Fedora PC                            XPS (192.168.2.100)
──────────                           ───────────────────
glances    :61208 ──┐
                    ├──── LAN ────►  senya-landing nginx  ──►  /stats/fedora/*
power-api  :8081  ──┘                (internal-only proxy)     rendered by
                                                               js/sections/system.js
```

The landing page never talks to the Fedora box directly — nginx on the XPS
reverse-proxies it same-origin under `/stats/fedora/`, so the page keeps its
strict `connect-src 'self'` CSP and the Fedora address is never exposed to the
public Cloudflare tunnel (non-internal `Host` → 404).

## Deploy

### 1. Find the Fedora box's IP

```bash
ssh fedora-local "hostname -I; tailscale ip -4"
```

Take the `192.168.2.x` address (use the `100.x` Tailscale one instead if the box
isn't always on the same LAN).

### 2. Put this repo on the Fedora box and start the stack

The compose file mounts `../power-api/server.py`, so clone the **whole repo**,
not just this folder:

```bash
ssh fedora-local
git clone <this-repo> ~/xps-homelab
cd ~/xps-homelab/fedora
docker compose up -d
```

> Fedora ships **podman**, not docker. Either install Docker CE
> (`sudo dnf install docker-ce docker-compose-plugin && sudo systemctl enable --now docker`)
> or substitute `podman-compose up -d` and delete the `docker.sock` volume line
> from `docker-compose.yaml`.

### 3. Open the firewall

Fedora runs **firewalld** with everything closed by default — this is the most
common reason the card stays "offline" even though both containers are healthy.

```bash
sudo firewall-cmd --permanent --add-port=61208/tcp
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --reload
```

### 4. Verify from the Fedora box, then from the XPS

```bash
# on the Fedora box
curl -s localhost:61208/api/4/cpu | head -c 200
curl -s localhost:8081

# from the XPS — proves the firewall step worked
curl -s http://<FEDORA_IP>:61208/api/4/cpu | head -c 200
curl -s http://<FEDORA_IP>:8081
```

`power-api` takes ~1s to answer: it samples the RAPL counter twice a second
apart to compute watts. That's expected, not a hang.

### 5. Point nginx at it and rebuild the landing page

Edit the two marked `set` lines in
[`../senya-landing/nginx.conf`](../senya-landing/nginx.conf) (search for
`<-- Fedora IP`) and replace `192.168.2.101` with the real address, then:

```bash
cd ~/xps-homelab/senya-landing   # on the XPS
docker compose up -d --build
```

The `Fedora` entry in [`../senya-landing/services.js`](../senya-landing/services.js)
`HOSTS` is already in place, so the card appears as soon as the proxy resolves.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Card shows **offline** | firewalld (step 3), or the wrong IP in `nginx.conf` |
| CPU sits near **0%** | `pid: host` missing — glances only sees itself |
| **Temp** and **CPU Power** rows missing | RAPL unreadable. AMD CPUs have no `intel-rapl`; see below |
| `/stats/fedora/*` returns **404** | You're hitting the page over the public tunnel — this proxy is LAN/Tailscale-only by design |
| glances 500s on containers | SELinux blocking `docker.sock`, or podman in use — drop that volume line |

**AMD CPUs:** `power-api` reads `/sys/class/powercap/intel-rapl`, which doesn't
exist on AMD. The card still degrades cleanly on its own — `system.js` only
renders `CPU Power` when a numeric `power_w` comes back, and `Temp` falls back
to the hottest Glances sensor (`k10temp`). Nothing breaks and no empty row
appears. If you'd rather skip the useless request every 5s, drop `power: true`
from the Fedora entry in `services.js` and delete the `power-api` service here.

## Adding the icon

The card falls back to `_default.svg` until you drop a `fedora.png` into
[`../senya-landing/icons/`](../senya-landing/icons) (source:
[dashboardicons.com](https://dashboardicons.com)). The filename must match the
`icon: "fedora"` key in `services.js`.
