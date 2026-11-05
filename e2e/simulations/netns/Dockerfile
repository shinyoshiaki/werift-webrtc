# Official Playwright image (the Chromium matching e2e's Playwright) plus
# iproute2 for network namespaces and tc. Built by run-netns-sim.js.
ARG PLAYWRIGHT_VERSION
# werift no longer needs any Node.js TypeScript flag, but this simulation has
# only been run on Node 24, so keep that pin instead of the image's Node 26.
FROM node:24-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*
