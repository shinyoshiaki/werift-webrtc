# Official Playwright image (the Chromium matching e2e's Playwright) plus
# iproute2 for network namespaces and tc. Built by run-netns-sim.js.
ARG PLAYWRIGHT_VERSION
# werift runs TypeScript with --experimental-transform-types, which Node 26
# (the Playwright image's default) no longer has; pin Node 24.
FROM node:24-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*
