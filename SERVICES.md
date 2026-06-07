# Homelab Services

## Senya Apps (custom-built)

| Service            | Local IP                              | Tailscale                               |
|--------------------|---------------------------------------|-----------------------------------------|
| Senya Landing      | http://192.168.2.100:8090             | http://100.121.230.17:8090              |
| SenyaTasks         | http://192.168.2.100:8000             | http://100.121.230.17:8000              |
| SenyaDaily         | http://192.168.2.100:8001             | http://100.121.230.17:8001              |

## Prebuilt Containers & Apps

| Service            | Local IP                              | Tailscale                               |
|--------------------|---------------------------------------|-----------------------------------------|
| Homepage           | http://192.168.2.100:3010             | http://100.121.230.17:3010              |
| Homarr             | http://192.168.2.100:3000             | http://100.121.230.17:3000              |
| Grafana            | http://192.168.2.100:3002             | http://100.121.230.17:3002              |
| Portainer          | http://192.168.2.100:9000             | http://100.121.230.17:9000              |
| Glances            | http://192.168.2.100:61208            | http://100.121.230.17:61208             |
| Uptime Kuma        | http://192.168.2.100:3001             | http://100.121.230.17:3001              |
| Prometheus         | http://192.168.2.100:9090             | http://100.121.230.17:9090              |
| SearXNG            | http://192.168.2.100:4000             | http://100.121.230.17:4000              |
| Obsidian           | http://192.168.2.100:8080             | http://100.121.230.17:8080              |
| Claude (Chromium)  | http://192.168.2.100:3003             | http://100.121.230.17:3003              |
| Baikal (CalDAV)    | http://192.168.2.100:5232             | http://100.121.230.17:5232              |
| Memos              | http://192.168.2.100:5230             | http://100.121.230.17:5230              |
| Vikunja            | http://192.168.2.100:3456             | http://100.121.230.17:3456              |
| Firefly III        | http://192.168.2.100:3005             | http://100.121.230.17:3005              |
| Firefly Importer   | http://192.168.2.100:3006             | http://100.121.230.17:3006              |
| Miniflux (RSS)     | http://192.168.2.100:3007             | http://100.121.230.17:3007              |
| Vaultwarden        | http://192.168.2.100:8222             | http://100.121.230.17:8222              |
| Jellyfin           | http://192.168.2.82:30013             | http://100.112.73.95:30013              |
| TrueNAS            | http://192.168.2.82                   | http://100.112.73.95                    |

## APIs (internal / not user-facing)

| Service              | Local IP                              | Tailscale                             |
|----------------------|---------------------------------------|---------------------------------------|
| Power API            | http://192.168.2.100:8081             | http://100.121.230.17:8081            |
| Tailscale API        | http://192.168.2.100:8082             | http://100.121.230.17:8082            |
| Nvidia API           | http://192.168.2.100:8083             | http://100.121.230.17:8083            |
| Prometheus Exporter  | http://192.168.2.100:9091/metrics     | http://100.121.230.17:9091/metrics    |
| Traefik dashboard    | http://192.168.2.100:8096             | http://100.121.230.17:8096            |
| CouchDB (Obsidian)   | http://192.168.2.100:5984/_utils      | http://100.121.230.17:5984/_utils     |

## CalDAV / CardDAV (Baikal)

| Protocol | Local IP                                   | Tailscale                                    |
|----------|--------------------------------------------|----------------------------------------------|
| CalDAV   | http://192.168.2.100:5232/dav.php/         | http://100.121.230.17:5232/dav.php/          |

## Public (Cloudflare Tunnel)

| Service           | URL                          | Auth           |
|-------------------|------------------------------|----------------|
| Glances           | https://glances.senya.ca     | none (direct)  |
| Authelia portal   | https://auth.senya.ca        | login portal   |
| whoami (demo)     | https://whoami.senya.ca      | Authelia       |

Public services route through Traefik (`http://traefik:80`) and are protected
selectively via the `authelia@file` middleware in `traefik/dynamic/routes.yml`.
See [authelia/README.md](authelia/README.md).
</content>
</invoke>
