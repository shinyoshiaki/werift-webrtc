# BoringSSL DTLS 1.3 interop image.
# Clones the pinned BoringSSL revision with stock git inside the image so the
# host SAK git wrapper / insteadOf / GIT_DIR injection is never used.
#
# Build and run from the repository root:
#   docker build -f packages/dtls/tests/e2e/boringssl/Dockerfile -t werift-dtls-boringssl-e2e .
#   docker run --rm werift-dtls-boringssl-e2e
#
# Or from packages/dtls:
#   npm run test:boringssl:docker

# --- Stage 1: pin-correct BoringSSL + dtls13_echo (stock git, isolated tree) ---
FROM golang:1.24-bookworm AS bssl

ENV DEBIAN_FRONTEND=noninteractive
# Neutralize any inherited git identity so clone/checkout cannot touch a parent repo.
ENV GIT_DIR=
ENV GIT_WORK_TREE=
ENV GIT_COMMON_DIR=
ENV GIT_INDEX_FILE=
ENV GIT_OBJECT_DIRECTORY=
ENV GIT_CONFIG_GLOBAL=/dev/null
ENV GIT_CONFIG_SYSTEM=/dev/null
ENV HOME=/root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++ \
    git \
    ninja-build \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/werift-boringssl-dtls13
COPY packages/dtls/tools/boringssl-dtls13 /opt/werift-boringssl-dtls13

# Clone under /opt, never under a copied werift work tree.
ENV WERIFT_BORINGSSL_SRC=/opt/boringssl
ENV WERIFT_DTLS13_ECHO_OUT=/opt/dtls13_echo
RUN chmod +x fetch-and-build-boringssl.sh build-bssl-echo.sh \
  && ./fetch-and-build-boringssl.sh \
  && test -x /opt/dtls13_echo \
  && test -f /opt/werift-boringssl-dtls13/.built-revision

# --- Stage 2: Node 18 workspace + required-harness interop tests ---
FROM node:18-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples ./examples
COPY import-test ./import-test

COPY --from=bssl /opt/dtls13_echo /workspace/packages/dtls/tests/e2e/boringssl/dtls13_echo
COPY --from=bssl /opt/werift-boringssl-dtls13/.built-revision /workspace/packages/dtls/tests/e2e/boringssl/.built-revision

RUN chmod +x /workspace/packages/dtls/tests/e2e/boringssl/dtls13_echo \
  && npm ci

WORKDIR /workspace/packages/dtls
ENV WERIFT_REQUIRE_BORINGSSL=1
ENV WERIFT_BORINGSSL_ENFORCE_PIN=1
ENV WERIFT_BORINGSSL_DTLS_ECHO=/workspace/packages/dtls/tests/e2e/boringssl/dtls13_echo

CMD ["npm", "run", "test:boringssl"]
