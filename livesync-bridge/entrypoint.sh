#!/bin/sh
# Render config.json from env (.env -> compose environment), then run the bridge.
set -e
deno run --allow-env --allow-write=/app/dat /app/render-config.ts
exec deno task run
