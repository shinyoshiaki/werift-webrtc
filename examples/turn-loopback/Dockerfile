FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    certbot \
    gettext-base \
    nginx \
    openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json biome.json vitest.workspace.mjs ./
COPY packages ./packages
COPY examples/turn-loopback ./examples/turn-loopback
COPY import-test ./import-test

RUN npm ci
RUN npm run build --workspace examples/turn-loopback
RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf \
  && chmod +x /app/examples/turn-loopback/docker/entrypoint.sh

WORKDIR /app/examples/turn-loopback

EXPOSE 8080 8443

ENV TURN_LOOPBACK_HOST=0.0.0.0
ENV TURN_LOOPBACK_HTTP_PORT=8080
ENV TURN_LOOPBACK_PORT=8443
ENV TURN_LOOPBACK_PUBLIC_PORT=443
ENV CERTBOT_WEBROOT=/var/www/turn-loopback
ENV CERTBOT_STATE_DIR=/var/lib/turn-loopback/certbot
ENV CERTBOT_RENEW_INTERVAL=0

ENTRYPOINT ["/app/examples/turn-loopback/docker/entrypoint.sh"]
