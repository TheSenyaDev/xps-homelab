#!/usr/bin/env sh
# Download service/bookmark icons from the dashboard-icons project (homarr-labs)
# into ./icons/. Browse/search slug names at https://dashboardicons.com/ .
#
# Adding a new service? Add its slug to SLUGS below and re-run:
#   ./fetch-icons.sh
# Anything that 404s is skipped; the app falls back to icons/_default.svg at
# runtime, so a missing icon never breaks the page.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)/icons"
mkdir -p "$DIR"
BASE="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png"

# Local filename == slug == the value used in app.js / services.js `icon:` field.
SLUGS="
proton-mail github-light claude-ai openai youtube reddit cloudflare tailscale
wikipedia hacker-news homepage homarr grafana portainer glances uptime-kuma
prometheus searxng obsidian baikal memos vikunja firefly-iii miniflux truenas
dell authelia traefik
"

for s in $SLUGS; do
  code=$(curl -fsSL -o "$DIR/$s.png" -w "%{http_code}" "$BASE/$s.png" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "ok   $s"
  else
    rm -f "$DIR/$s.png"
    echo "MISS $s ($code)  -> will use _default.svg"
  fi
done
