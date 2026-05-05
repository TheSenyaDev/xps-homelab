# Dashboard

A self-hosted home dashboard running on Docker, accessible at `http://192.168.2.100:3000`.

---

## Services

### Homarr
**Port:** 3000
**Folder:** `homarr/`

The main dashboard UI. Displays all services, system stats, and container status. Configured via the web UI; config is persisted in `homarr/configs/`, icons in `homarr/icons/`, and data in `homarr/data/`.

---

### Glances
**Port:** 61208
**Folder:** `glances/`

System monitor that runs with host PID access to read CPU, memory, disk, network, sensors, and fan speeds. Used as the data source for temperature readings on the Homarr dashboard.

---

### Portainer
**Port:** 9000
**Folder:** `portainer/`

Docker container management UI. Allows viewing, starting, stopping, and inspecting all running containers.

---

### Uptime Kuma
**Port:** 3001
**Folder:** `uptime-kuma/`

Service uptime and availability monitor. Tracks whether services are up and sends alerts on downtime.

---

### Obsidian Remote
**Port:** 8080
**Folder:** `obsidian/`

Runs Obsidian (the note-taking app) in the browser via a remote desktop container. Vaults are stored in `obsidian/vaults/` on the host.

---

### Power API
**Port:** 8081
**Folder:** `power-api/`

A small Python HTTP server that reads Intel RAPL energy counters from `/sys/class/powercap/intel-rapl` to calculate real-time CPU power draw in watts. Also exposes battery percentage and charge status. Used by the Homarr power widget.

---

### Tailscale API
**Port:** 8082
**Folder:** `tailscale-api/`

A small Python HTTP server that reads from the local Tailscale daemon socket (`/var/run/tailscale/tailscaled.sock`) and exposes VPN status as JSON. Returns current state, Tailscale IP, DNS name, and peer online/total counts. Used by the Homarr Tailscale widget.

---

### Grafana
**Port:** 3002
**Folder:** `grafana/`

Metrics visualization and dashboarding. Queries the Power API and Tailscale API directly using the **Infinity** data source plugin (bundled via `GF_INSTALL_PLUGINS`), which can fetch and parse arbitrary JSON endpoints. Dashboards and data source config are persisted in `grafana/data/`.

See [How Grafana works with the custom APIs](#how-grafana-works-with-the-custom-apis) below for setup instructions.

---

## How Grafana works with the custom APIs

### Architecture

```
power-api   (:8081) ─┐
                      ├─► Infinity datasource ─► Grafana panels ─► Homarr iframe
tailscale-api (:8082) ┘
```

Grafana itself does not scrape or store data — it queries your APIs live each time a panel loads. The **Infinity plugin** is a generic data source that can hit any HTTP endpoint and map JSON fields to graph/stat values.

### First-time setup

1. Go to `http://192.168.2.100:3002` and log in with `admin` / the password from your `.env`
2. Go to **Connections → Data sources → Add new data source**
3. Search for **Infinity** and select it
4. Name it `Power API`, set the base URL to `http://power-api:8081` (uses Docker's internal DNS), click **Save & Test**
5. Repeat for Tailscale API: name `Tailscale API`, base URL `http://tailscale-api:8082`

> The containers can reach each other by service name because they're on the same Docker Compose network.

### Building a panel (example: CPU watts)

1. **Dashboards → New → New dashboard → Add visualization**
2. Select the **Infinity** data source
3. Set **Type** → `JSON`, **Method** → `GET`, **URL** → `http://power-api:8081`
4. Under **Columns**, map the JSON field (e.g. `cpu_watts`) to a value column
5. Set the visualization to **Stat** or **Gauge**, set unit to `Watts`
6. Repeat for other fields: `battery_percent`, `charging`, `tailscale_ip`, `peers_online`, etc.

### Embedding in Homarr

Once your Grafana dashboard is built, you can embed individual panels as iframes in Homarr:

1. In Grafana, open a panel → **Share → Embed** and copy the iframe URL
2. In Homarr edit mode, add a widget → **iFrame** → paste the URL

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description |
|---|---|
| `TZ` | Timezone (e.g. `America/Toronto`) |
| `GRAFANA_ADMIN_USER` | Admin username for Grafana |
| `GRAFANA_ADMIN_PASSWORD` | Admin password for Grafana |

---

## Docker commands

```bash
# Start everything
docker compose up -d

# Stop everything
docker compose down

# Restart everything
docker compose restart

# See logs
docker compose logs -f

# Update all images
docker compose pull && docker compose up -d

# Recreate all services
docker compose up -d --force-recreate

# Restart a single service
docker compose up -d --force-recreate <service-name>
```
