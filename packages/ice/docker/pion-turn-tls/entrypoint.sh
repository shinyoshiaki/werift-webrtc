#!/bin/sh
set -e

# Generate self-signed certificate at startup
CERT_DIR=/tmp/certs
mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 1 \
  -subj "/CN=localhost" \
  2>/dev/null

exec turn-server \
  -public-ip "$PUBLIC_IP" \
  -users "$USERS" \
  -realm "$REALM" \
  -port "$TLS_PORT" \
  -cert "$CERT_DIR/cert.pem" \
  -key "$CERT_DIR/key.pem"
