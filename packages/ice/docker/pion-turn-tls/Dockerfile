# SPDX-FileCopyrightText: 2023 The Pion community <https://pion.ly>
# SPDX-License-Identifier: MIT

FROM golang:alpine AS builder

ARG VERSION=main

RUN apk add --no-cache git

WORKDIR /build
# Clone Source using GIT
RUN git clone --branch=$VERSION --depth=1 https://github.com/pion/turn.git turn && rm -rf turn/.git

WORKDIR /build/turn

# Download dependencies
RUN go mod download

# Build static binary
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-w -s" -o /usr/local/bin/turn-server ./examples/turn-server/tls


##### main
FROM alpine

RUN apk add --no-cache openssl

ENV REALM localhost
ENV USERS username=password
ENV TLS_PORT 5349
ENV PUBLIC_IP 127.0.0.1

EXPOSE 5349

# Copy the executable
COPY --from=builder /usr/local/bin/turn-server /usr/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
