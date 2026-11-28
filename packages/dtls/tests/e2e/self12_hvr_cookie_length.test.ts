import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import { CipherSuite } from "../../src/cipher/const";
import {
  ADDRESS_COOKIE_LENGTH,
  assertDtls12HelloVerifyCookieLength,
  DTLS12_HVR_COOKIE_LENGTH,
  DTLS12_HVR_COOKIE_MAX_LENGTH,
  mintAddressCookie,
  mintDtls12HelloVerifyCookie,
  verifyDtls12HelloVerifyCookie,
} from "../../src/handshake/extensions/cookie";
import {
  build12ClientHello,
  certPem,
  fixedClientRandom,
  helloVerifyRequestCookieOf,
  keyPem,
  rsaSignatureHash,
} from "../fixture";

/** NSS の DTLS_COOKIE_BYTES（lib/ssl/dtlscon.c）。これを超える HVR cookie は decode_error になる。 */
const NSS_DTLS_COOKIE_BYTES = 32;

const secret = Buffer.alloc(32, 0x5a);
const peer = "192.0.2.10:5000";
const nowSec = 1_800_000_000;

/** 自己対向の DTLS 1.2 サーバー / クライアントを UDP 上に用意する。 */
async function arrangeSelf12Pair() {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: rsaSignatureHash,
  });
  const close = async () => {
    client.close();
    server.close();
    await clientTransport.close().catch(() => {});
    await serverTransport.close().catch(() => {});
  };
  return { server, client, serverTransport, clientTransport, close };
}

test("unit: DTLS 1.2 HVR cookie fits the 32-byte bound NSS enforces", () => {
  // Arrange
  const body = build12ClientHello().serialize();

  // Act: DTLS 1.2 HVR 用の cookie を発行する
  const cookie = mintDtls12HelloVerifyCookie(secret, peer, body, { nowSec });

  // Assert: 32 バイト以下で、DTLS 1.3 HRR cookie（104 バイト）とは別形式
  expect(DTLS12_HVR_COOKIE_MAX_LENGTH).toBe(NSS_DTLS_COOKIE_BYTES);
  expect(cookie.length).toBe(DTLS12_HVR_COOKIE_LENGTH);
  expect(cookie.length).toBeLessThanOrEqual(NSS_DTLS_COOKIE_BYTES);
  expect(ADDRESS_COOKIE_LENGTH).toBeGreaterThan(NSS_DTLS_COOKIE_BYTES);
});

test("unit: compact HVR cookie keeps peer, CH parameter and expiry binding", () => {
  // Arrange
  const random = fixedClientRandom();
  const ch1 = build12ClientHello({ random }).serialize();
  const cookie = mintDtls12HelloVerifyCookie(secret, peer, ch1, { nowSec });
  const ch2 = build12ClientHello({ random, cookie }).serialize();
  const verify = (
    c: Buffer,
    opts?: { peerKey?: string; body?: Buffer; now?: number; key?: Buffer },
  ) =>
    verifyDtls12HelloVerifyCookie(
      opts?.key ?? secret,
      c,
      opts?.peerKey ?? peer,
      opts?.body ?? ch2,
      { nowSec: opts?.now ?? nowSec },
    );

  // Act / Assert: 同じ送信元・同じパラメータの CH2 は通る
  expect(verify(cookie)).toBe(true);
  // Act / Assert: 送信元アドレスが違えば失敗する
  expect(verify(cookie, { peerKey: "192.0.2.11:5000" })).toBe(false);
  // Act / Assert: CH のパラメータ（cipher suites）が違えば失敗する
  const otherParams = build12ClientHello({
    random,
    cookie,
    ciphers: [CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195],
  }).serialize();
  expect(verify(cookie, { body: otherParams })).toBe(false);
  // Act / Assert: 有効期限（60 秒）を過ぎた cookie と未来の cookie は失敗する
  expect(verify(cookie, { now: nowSec + 61 })).toBe(false);
  expect(verify(cookie, { now: nowSec - 6 })).toBe(false);
  // Act / Assert: 別の secret では失敗する
  expect(verify(cookie, { key: Buffer.alloc(32, 0x01) })).toBe(false);
});

test("unit: tampered, truncated or foreign-format HVR cookies are rejected", () => {
  // Arrange
  const body = build12ClientHello().serialize();
  const cookie = mintDtls12HelloVerifyCookie(secret, peer, body, { nowSec });
  const verify = (c: Buffer) =>
    verifyDtls12HelloVerifyCookie(secret, c, peer, body, { nowSec });

  // Act / Assert: MAC・issuedAt・version の各バイトを 1 ビット反転すると失敗する
  for (let i = 0; i < cookie.length; i++) {
    const tampered = Buffer.from(cookie);
    tampered[i] ^= 0x01;
    expect(verify(tampered), `byte ${i}`).toBe(false);
  }
  // Act / Assert: 長さが違う cookie は失敗する
  expect(verify(cookie.subarray(0, cookie.length - 1))).toBe(false);
  expect(verify(Buffer.concat([cookie, Buffer.alloc(1)]))).toBe(false);
  // Act / Assert: DTLS 1.3 の HRR cookie 形式は DTLS 1.2 の検証を通らない
  expect(verify(mintAddressCookie(secret, peer, body, { nowSec }))).toBe(false);
});

test("unit: HVR cookie length guard throws above 32 bytes", () => {
  // Act / Assert: 32 バイトは許可し、33 バイトは送らずに例外にする
  expect(() =>
    assertDtls12HelloVerifyCookieLength(Buffer.alloc(32)),
  ).not.toThrow();
  expect(() => assertDtls12HelloVerifyCookieLength(Buffer.alloc(33))).toThrow(
    /max 32/,
  );
});

test("e2e/self12: wire HVR cookie is <= 32 bytes and an NSS-like client completes", async () => {
  // Arrange: クライアント側で受信 HVR の cookie を取り出し、NSS と同じく 32 バイト超を拒否する
  const { server, client, clientTransport, close } = await arrangeSelf12Pair();
  const hvrCookies: Buffer[] = [];
  let nssRejected: Error | undefined;
  const deliver = clientTransport.onData;
  clientTransport.onData = (data, addr) => {
    const cookie = helloVerifyRequestCookieOf(data);
    if (cookie) {
      hvrCookies.push(cookie);
      if (cookie.length > NSS_DTLS_COOKIE_BYTES) {
        nssRejected = new Error(
          `NSS-like client: decode_error (HVR cookie ${cookie.length} bytes)`,
        );
        return;
      }
    }
    deliver(data, addr);
  };

  try {
    // Act: ハンドシェイクを実行する
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(nssRejected ?? new Error("self12 handshake timeout")),
        10_000,
      );
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        resolve();
      });
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      void client.connect();
    });

    // Assert: HVR を受け取り、その cookie は 32 バイト以下で、接続が完了している
    expect(nssRejected).toBeUndefined();
    expect(hvrCookies.length).toBeGreaterThan(0);
    for (const cookie of hvrCookies) {
      expect(cookie.length).toBeLessThanOrEqual(NSS_DTLS_COOKIE_BYTES);
    }
    expect(client.connected).toBe(true);
    expect(server.connected).toBe(true);
  } finally {
    await close();
  }
}, 15_000);
