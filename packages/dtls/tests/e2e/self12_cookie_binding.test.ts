import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer } from "../../src";
import {
  CipherSuite,
  HashAlgorithm,
  SignatureAlgorithm,
} from "../../src/cipher/const";
import {
  mintDtls12HelloVerifyCookie,
  verifyDtls12HelloVerifyCookie,
} from "../../src/handshake/extensions/cookie";
import { EllipticCurves } from "../../src/handshake/extensions/ellipticCurves";
import { Signature } from "../../src/handshake/extensions/signature";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { certPem, keyPem } from "../fixture";

const sig = {
  hash: HashAlgorithm.sha256_4,
  signature: SignatureAlgorithm.rsa_1,
};

type ClientRandom = { gmt_unix_time: number; random_bytes: Buffer };

function fixedClientRandom(): ClientRandom {
  const r = new DtlsRandom();
  return {
    gmt_unix_time: r.gmt_unix_time,
    random_bytes: Buffer.from(r.random_bytes),
  };
}

function build12ClientHello(opts?: {
  cookie?: Buffer;
  random?: ClientRandom;
  ciphers?: number[];
}): ClientHello {
  const curves = new EllipticCurves({ data: [23, 29] });
  const signature = new Signature({
    data: [
      { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.rsa_1 },
    ],
  });
  return new ClientHello(
    { major: 254, minor: 253 },
    opts?.random ?? fixedClientRandom(),
    Buffer.alloc(0),
    opts?.cookie ?? Buffer.alloc(0),
    opts?.ciphers ?? [
      CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
    ],
    [0],
    [curves.extension, signature.extension],
  );
}

function chAsAssembled(hello: ClientHello): FragmentedHandshake[] {
  const frag = hello.toFragment();
  return [FragmentedHandshake.assemble([frag])];
}

/**
 * P1: A に発行した cookie を B が提示しても pin / Flight4 しない。
 */
test("e2e/self12: cookie minted for A is rejected from peer B", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const flight4Sends: Array<[string, number] | undefined> = [];
  let hvrCount = 0;
  serverTransport.send = async (_data: Buffer, addr?: any) => {
    const a = addr as [string, number] | undefined;
    // Count HVR (small) vs Flight4 (large multi-message) roughly by tracking dest
    if ((server as any).dtls.flight === 2) {
      hvrCount += 1;
    }
    if ((server as any).dtls.flight === 4) {
      flight4Sends.push(a);
    }
  };

  const peerA: [string, number] = ["198.51.100.1", 10001];
  const peerB: [string, number] = ["198.51.100.2", 10002];
  const rnd = fixedClientRandom();

  // Act: A → CH1 → HVR(cookie for A)
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ random: rnd })),
    peerA,
  );
  const cookieA = Buffer.from((server as any).dtls.cookie as Buffer);
  expect(cookieA.length).toBeGreaterThan(0);
  expect((server as any).transport.pinnedPeer).toBeUndefined();

  // B presents A's cookie with same CH params but wrong source
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ cookie: cookieA, random: rnd })),
    peerB,
  );

  // Assert: B を pin しない / Flight4 なし
  const pin = (server as any).transport.pinnedPeer as
    | [string, number]
    | undefined;
  expect(pin).toBeUndefined();
  expect(flight4Sends.length).toBe(0);
  // B は新 HVR を受け得る（再チャレンジ）
  expect(hvrCount).toBeGreaterThanOrEqual(1);

  server.close();
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: CH1 と random が異なる CH2 + 同 cookie → 拒否。
 */
test("e2e/self12: CH2 with different random than cookie-bound CH1 is rejected", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });
  serverTransport.send = async () => {};

  const peer: [string, number] = ["203.0.113.10", 20001];
  const rnd1 = fixedClientRandom();
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ random: rnd1 })),
    peer,
  );
  const cookie = Buffer.from((server as any).dtls.cookie as Buffer);

  // Different random (new ClientHello params) — cookie binding must fail
  const rnd2 = fixedClientRandom();
  expect(rnd2.random_bytes.equals(rnd1.random_bytes)).toBe(false);
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ cookie, random: rnd2 })),
    peer,
  );

  expect((server as any).transport.pinnedPeer).toBeUndefined();
  // Association crypto not committed to rnd2
  expect((server as any).cipher.remoteRandom).toBeUndefined();

  server.close();
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: A CH1 → B CH1 (poison attempt) → A CH2 with valid cookie → A pins and Flight4.
 * B must not leave association cipher state committed.
 */
test("e2e/self12: B cookie-less CH1 does not poison A's cookie CH2 commit", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const flight4To: Array<[string, number] | undefined> = [];
  serverTransport.send = async (_data: Buffer, addr?: any) => {
    if ((server as any).dtls.flight === 4) {
      flight4To.push(addr as [string, number] | undefined);
    }
  };

  const peerA: [string, number] = ["198.51.100.50", 30001];
  const peerB: [string, number] = ["198.51.100.51", 30002];
  const rndA = fixedClientRandom();
  const rndB = fixedClientRandom();

  // A CH1
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ random: rndA })),
    peerA,
  );
  const cookieA = Buffer.from((server as any).dtls.cookie as Buffer);
  // Pre-cookie: no remoteRandom committed
  expect((server as any).cipher.remoteRandom).toBeUndefined();

  // B CH1 (would have overwritten state in the old implementation)
  await (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ random: rndB })),
    peerB,
  );
  expect((server as any).cipher.remoteRandom).toBeUndefined();
  expect((server as any).transport.pinnedPeer).toBeUndefined();

  // A CH2 with valid cookie + original params (Flight4 retransmit loops — don't await full)
  const hsPromise = (server as any).handleHandshakes(
    chAsAssembled(build12ClientHello({ cookie: cookieA, random: rndA })),
    peerA,
  );
  await new Promise((r) => setTimeout(r, 80));

  const pin = (server as any).transport.pinnedPeer as
    | [string, number]
    | undefined;
  expect(pin).toEqual(peerA);
  // Flight4 only toward A
  expect(flight4To.length).toBeGreaterThan(0);
  for (const d of flight4To) {
    expect(d).toEqual(peerA);
  }
  // remoteRandom matches A's CH random, not B's
  const remote = (server as any).cipher.remoteRandom;
  expect(remote).toBeTruthy();
  const remoteBytes = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(remote.gmt_unix_time >>> 0, 0);
      return b;
    })(),
    remote.random_bytes,
  ]);
  const aBytes = Buffer.concat([
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(rndA.gmt_unix_time >>> 0, 0);
      return b;
    })(),
    rndA.random_bytes,
  ]);
  expect(remoteBytes.equals(aBytes)).toBe(true);

  server.close();
  await hsPromise.catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * Unit: mint/verify helpers bind peer and CH params.
 */
test("unit: mintDtls12HelloVerifyCookie binds peer and ClientHello params", () => {
  const secret = Buffer.alloc(16, 0xab);
  const rnd = fixedClientRandom();
  const ch1 = build12ClientHello({ random: rnd });
  const body = ch1.serialize();
  const cookie = mintDtls12HelloVerifyCookie(secret, "10.0.0.1:9", body);

  expect(
    verifyDtls12HelloVerifyCookie(secret, cookie, "10.0.0.1:9", body),
  ).toBe(true);
  // Wrong peer
  expect(
    verifyDtls12HelloVerifyCookie(secret, cookie, "10.0.0.2:9", body),
  ).toBe(false);
  // Wrong random (CH params)
  const ch2 = build12ClientHello({
    cookie: Buffer.from(cookie),
    random: fixedClientRandom(),
  });
  expect(
    verifyDtls12HelloVerifyCookie(
      secret,
      cookie,
      "10.0.0.1:9",
      ch2.serialize(),
    ),
  ).toBe(false);
  // Same params + cookie field set still verifies (cookie zeroed for binding)
  const ch2ok = build12ClientHello({
    cookie: Buffer.from(cookie),
    random: rnd,
  });
  expect(
    verifyDtls12HelloVerifyCookie(
      secret,
      cookie,
      "10.0.0.1:9",
      ch2ok.serialize(),
    ),
  ).toBe(true);
});

/**
 * E2E: normal dual self 1.2 still completes after cookie binding change.
 */
test("e2e/self12: full handshake still completes with bound cookies", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("self12 cookie e2e timeout")), 15_000);
    client.onConnect.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    void client.connect();
  });

  expect(client.connected).toBe(true);
  expect(server.connected).toBe(true);

  client.close();
  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
