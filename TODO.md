General
- [ ] add ADgaurd for DNS
- [ ] add Nginx for reverse proxy
- [ ] add Cloudflare to allow for access externally
- [ ] how to check fan speed
- [ ] be able to control fans peed manually or set a profile for it
- [ ] torrent solution
- [ ] Verify Prometheus is working
- [ ] sync to boox


Grafana
- [x] add graphs to be able to see past metrics and performance for each of the things i want 
- [x] for stuff like ram and hdd I want to see numbers as well
- [x] add alerts when stuff goes bad
- [x] fix GPU Usage (GTX 1050), GPU Temp (GTX 1050), GPU VRAM, not displaying any data
- [x] add graph for fan speed
- [ ] check why the past graph data is not appearing

Homarr
- [ ] add widgets for Obsidian, Portainer, Uptime Kuma, claude
- [ ] add icons for the widgets for Obsidian, Portainer, Uptime Kuma, Glances, Grafana, claude
- [ ] update weather to be for toronto
- [ ] add username and password as a config in the env fil

Cloud Flare Tunnel to my website
- [x] create container
- [x] create tunnel in CF dashboard + paste token into .env
- [x] set CLOUDFLARE_TUNNEL_TOKEN in .env — tunnel live at ${CLAUDE_PUBLIC_URL}
- [ ] create some simple auth to protect this 
- [ ] unable to connect a tunnel there is still some strange error 

Claude 
- [ ] change username and password
- [ ] how to auth to the app

Nginx
- [ ] create this container
- [ ] set this up

ADGaurd (is this the correct thing)
- [ ] set up dns

Prometheus
- [ ] check that everything is working properly here
- [ ]

Self Hosted Calendar App

TrueNAS
- [ ] set up the rest of the TrueNAS config to view its stats on Senya Landing (install Glances on TrueNAS, set its IP in the /stats/truenas/ block in nginx.conf)

Authentication
- [x] create self-hosted authentication (Authelia + Traefik forward-auth) to protect services — see authelia/README.md
- [ ] change the default admin/authelia password before exposing publicly
- [ ] add auth.senya.ca + any protected subdomains in the Cloudflare dashboard (→ http://traefik:80)
- [ ] (optional) enable two_factor / TOTP for sensitive services

Senya Landing
- [ ] rework into more of a full-stack web app with proper folder structure and a backend
- [ ] add a way to view notes from Senya Landing
- [ ] make it more minimal and optimized for the screen to fit more info — add a normal view and a compact view toggle
