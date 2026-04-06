# SPDX-FileCopyrightText: 2023 The Pion community <https://pion.ly>
# SPDX-License-Identifier: MIT

FROM golang:alpine as builder

ARG VERSION=master

RUN apk add --no-cache git

WORKDIR /build
# Clone Source using GIT
RUN git clone --branch=$VERSION --depth=1 https://github.com/pion/turn.git turn && rm -rf turn/.git

WORKDIR /build/turn/examples/turn-server/tls

# Download all the dependencies
RUN go get -d -v ./...

# Build static binary
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-w -s" -o turn-server main.go


##### main
FROM alpine

RUN apk add --no-cache openssl

ENV REALM localhost
ENV USERS username=password
ENV TLS_PORT 5349
ENV PUBLIC_IP 127.0.0.1

EXPOSE 5349

# Copy the executable
COPY --from=builder /build/turn/examples/turn-server/tls/turn-server /usr/bin/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
