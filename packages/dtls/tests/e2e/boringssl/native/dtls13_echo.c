/*
 * Minimal BoringSSL DTLS 1.3 echo peer for werift interop tests.
 * Uses a custom UDP BIO (BoringSSL has no BIO_new_dgram).
 *
 * Usage:
 *   dtls13_echo server <port> <cert.pem> <key.pem>
 *   dtls13_echo client <host> <port> <cert.pem> <key.pem>
 */
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/ssl.h>

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct {
  int fd;
  struct sockaddr_storage peer;
  socklen_t peer_len;
  int connected;
} UdpState;

static void die_ssl(const char *msg) {
  fprintf(stderr, "bssl-echo: %s\n", msg);
  ERR_print_errors_fp(stderr);
  exit(1);
}

static int udp_new(BIO *bio) {
  UdpState *st = (UdpState *)calloc(1, sizeof(UdpState));
  if (!st) return 0;
  st->fd = -1;
  BIO_set_init(bio, 1);
  BIO_set_data(bio, st);
  return 1;
}

static int udp_free(BIO *bio) {
  if (!bio) return 0;
  UdpState *st = (UdpState *)BIO_get_data(bio);
  if (st) {
    free(st);
    BIO_set_data(bio, NULL);
  }
  BIO_set_init(bio, 0);
  return 1;
}

static int udp_read(BIO *bio, char *out, int outl) {
  UdpState *st = (UdpState *)BIO_get_data(bio);
  if (!st || st->fd < 0 || outl <= 0) return 0;
  BIO_clear_retry_flags(bio);
  struct sockaddr_storage peer;
  socklen_t plen = sizeof(peer);
  ssize_t n =
      recvfrom(st->fd, out, (size_t)outl, 0, (struct sockaddr *)&peer, &plen);
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      BIO_set_retry_read(bio);
    }
    return -1;
  }
  if (!st->connected) {
    st->peer = peer;
    st->peer_len = plen;
    st->connected = 1;
    connect(st->fd, (struct sockaddr *)&peer, plen);
  }
  return (int)n;
}

static int udp_write(BIO *bio, const char *in, int inl) {
  UdpState *st = (UdpState *)BIO_get_data(bio);
  if (!st || st->fd < 0 || inl <= 0) return 0;
  BIO_clear_retry_flags(bio);
  ssize_t n;
  if (st->connected) {
    n = send(st->fd, in, (size_t)inl, 0);
  } else {
    n = sendto(st->fd, in, (size_t)inl, 0, (struct sockaddr *)&st->peer,
               st->peer_len);
  }
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      BIO_set_retry_write(bio);
    }
    return -1;
  }
  return (int)n;
}

static long udp_ctrl(BIO *bio, int cmd, long num, void *ptr) {
  UdpState *st = (UdpState *)BIO_get_data(bio);
  switch (cmd) {
    case BIO_C_SET_FD:
      if (!st || !ptr) return 0;
      st->fd = *(int *)ptr;
      return 1;
    case BIO_C_GET_FD:
      if (!st) return -1;
      if (ptr) *(int *)ptr = st->fd;
      return st->fd;
    case BIO_CTRL_FLUSH:
      return 1;
    case BIO_CTRL_DGRAM_QUERY_MTU:
      return 1200;
    default:
      return 0;
  }
}

static BIO_METHOD *g_udp_method = NULL;

static BIO_METHOD *udp_method(void) {
  if (g_udp_method) return g_udp_method;
  g_udp_method = BIO_meth_new(BIO_TYPE_DGRAM, "udp");
  if (!g_udp_method) return NULL;
  BIO_meth_set_write(g_udp_method, udp_write);
  BIO_meth_set_read(g_udp_method, udp_read);
  BIO_meth_set_ctrl(g_udp_method, udp_ctrl);
  BIO_meth_set_create(g_udp_method, udp_new);
  BIO_meth_set_destroy(g_udp_method, udp_free);
  return g_udp_method;
}

static BIO *BIO_new_udp(int fd) {
  BIO *bio = BIO_new(udp_method());
  if (!bio) return NULL;
  BIO_int_ctrl(bio, BIO_C_SET_FD, 0, fd);
  return bio;
}

static SSL_CTX *make_ctx(const char *cert, const char *key) {
  SSL_CTX *ctx = SSL_CTX_new(DTLS_method());
  if (!ctx) die_ssl("SSL_CTX_new");

  if (!SSL_CTX_set_min_proto_version(ctx, DTLS1_3_VERSION) ||
      !SSL_CTX_set_max_proto_version(ctx, DTLS1_3_VERSION)) {
    die_ssl("set proto version");
  }

  if (!SSL_CTX_set_strict_cipher_list(ctx, "TLS_AES_128_GCM_SHA256")) {
    /* some builds use different API — continue with defaults */
    fprintf(stderr, "bssl-echo: warning: strict cipher list failed\n");
  }
  if (!SSL_CTX_set1_groups_list(ctx, "X25519:P-256")) {
    fprintf(stderr, "bssl-echo: warning: groups list failed\n");
  }

  if (SSL_CTX_use_certificate_file(ctx, cert, SSL_FILETYPE_PEM) != 1) {
    die_ssl("use certificate");
  }
  if (SSL_CTX_use_PrivateKey_file(ctx, key, SSL_FILETYPE_PEM) != 1) {
    die_ssl("use private key");
  }
  SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
  return ctx;
}

static int run_server(int port, const char *cert, const char *key) {
  SSL_CTX *ctx = make_ctx(cert, key);

  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    perror("socket");
    return 1;
  }
  int on = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons((uint16_t)port);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("bind");
    return 1;
  }

  fprintf(stderr, "bssl-echo: server listening on UDP %d (DTLS 1.3)\n", port);
  fflush(stderr);

  BIO *bio = BIO_new_udp(fd);
  SSL *ssl = SSL_new(ctx);
  SSL_set_bio(ssl, bio, bio);
  SSL_set_accept_state(ssl);

  if (SSL_accept(ssl) != 1) {
    die_ssl("SSL_accept");
  }
  fprintf(stderr, "bssl-echo: server handshake done\n");
  fflush(stderr);

  char rbuf[4096];
  int r = SSL_read(ssl, rbuf, sizeof(rbuf));
  if (r > 0) {
    fprintf(stderr, "bssl-echo: server got %d bytes\n", r);
    SSL_write(ssl, rbuf, r);
  }

  SSL_shutdown(ssl);
  SSL_free(ssl);
  SSL_CTX_free(ctx);
  close(fd);
  return 0;
}

static int run_client(const char *host, int port, const char *cert,
                      const char *key) {
  SSL_CTX *ctx = make_ctx(cert, key);

  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    perror("socket");
    return 1;
  }
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
    fprintf(stderr, "bad host\n");
    return 1;
  }
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("connect");
    return 1;
  }

  BIO *bio = BIO_new_udp(fd);
  UdpState *st = (UdpState *)BIO_get_data(bio);
  st->connected = 1;
  memcpy(&st->peer, &addr, sizeof(addr));
  st->peer_len = sizeof(addr);

  SSL *ssl = SSL_new(ctx);
  SSL_set_bio(ssl, bio, bio);
  SSL_set_connect_state(ssl);

  if (SSL_connect(ssl) != 1) {
    die_ssl("SSL_connect");
  }
  fprintf(stderr, "bssl-echo: client handshake done\n");
  fflush(stderr);

  const char *msg = "hello-from-bssl";
  if (SSL_write(ssl, msg, (int)strlen(msg)) <= 0) {
    die_ssl("SSL_write");
  }
  char rbuf[4096];
  int r = SSL_read(ssl, rbuf, sizeof(rbuf) - 1);
  if (r > 0) {
    rbuf[r] = 0;
    fprintf(stderr, "bssl-echo: client got: %s\n", rbuf);
    printf("%s\n", rbuf);
  }

  SSL_shutdown(ssl);
  SSL_free(ssl);
  SSL_CTX_free(ctx);
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: %s server <port> <cert> <key>\n"
            "       %s client <host> <port> <cert> <key>\n",
            argv[0], argv[0]);
    return 2;
  }
  if (strcmp(argv[1], "server") == 0 && argc == 5) {
    return run_server(atoi(argv[2]), argv[3], argv[4]);
  }
  if (strcmp(argv[1], "client") == 0 && argc == 6) {
    return run_client(argv[2], atoi(argv[3]), argv[4], argv[5]);
  }
  fprintf(stderr, "bad arguments\n");
  return 2;
}
