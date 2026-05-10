FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json biome.json vitest.workspace.mjs ./
COPY packages ./packages
COPY examples/turn-loopback ./examples/turn-loopback
COPY import-test ./import-test

RUN npm ci
RUN npm run build --workspace examples/turn-loopback

WORKDIR /app/examples/turn-loopback

EXPOSE 8443

ENV TURN_LOOPBACK_HOST=0.0.0.0
ENV TURN_LOOPBACK_PORT=8443

CMD ["npm", "run", "server"]
