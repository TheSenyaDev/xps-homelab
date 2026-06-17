# InfCloud — open-source CalDAV/CardDAV web client (the integrated build of
# CalDavZAP + CardDavMATE). https://www.inf-it.com/open-source/clients/infcloud/
#
# We take the prebuilt app from ckulka/infcloud (same maintainer as our Baikal
# image) and serve it from a plain nginx that ALSO reverse-proxies Baikal's DAV
# endpoints under the SAME origin. Because the browser then only ever makes
# same-origin requests, there are no CORS headers to configure on Baikal and no
# PHP cross-domain proxy is needed. See README.md.
FROM ckulka/infcloud:latest AS app

FROM nginx:alpine
# The InfCloud app lives at /usr/share/nginx/infcloud in the source image.
COPY --from=app /usr/share/nginx/infcloud /usr/share/nginx/infcloud

# Point the client at Baikal's (same-origin, proxied) principal collection.
# Appended LAST so it overrides the stock globalNetworkCheckSettings in config.js.
COPY config.override.js /tmp/config.override.js
RUN cat /tmp/config.override.js >> /usr/share/nginx/infcloud/config.js \
 && rm /tmp/config.override.js

COPY default.conf /etc/nginx/conf.d/default.conf
