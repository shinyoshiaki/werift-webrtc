import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsServer, DtlsVersion } from "../../src";
import { DirectHandshakeCarrier } from "../../src/carrier/direct";
import {
  CipherSuite,
  HashAlgorithm,
  SignatureAlgorithm,
} from "../../src/cipher/const";
import { EllipticCurves } from "../../src/handshake/extensions/ellipticCurves";
import { Signature } from "../../src/handshake/extensions/signature";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { createDtlsClientInternal } from "../../src/internal";
import { AlertDesc, ContentType } from "../../src/record/const";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
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
  only13Cipher?: boolean;
  /** Fixed random for CH1/CH2 cookie binding (RFC 6347 same parameters). */
  random?: ClientRandom;
}): ClientHello {
  // EllipticCurves / Signature matching RSA fixture cert
  const curves = new EllipticCurves({ data: [23, 29] }); // secp256r1, x25519
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
    opts?.only13Cipher
      ? [0x1301]
      : [CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199],
    [0],
    [curves.extension, signature.extension],
  );
}

function chAsAssembled(hello: ClientHello): FragmentedHandshake[] {
  const frag = hello.toFragment();
  return [FragmentedHandshake.assemble([frag])];
}

/**
 * P1: pure / initial dual DTLS 1.3 client は startEngine13 直後から
 * UDP と carrier.inject を association dispatcher に接続する。
 */
test("e2e: pure 1.3 client binds association dispatcher at startEngine13", async () => {
  // Arrange
  const clientTransport = await UdpTransport.init("udp4");
  const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    handshakeCarrier: carrier,
  });

  // Act / Assert: association が onData / inject を所有
  expect((client as any).engine13).toBeTruthy();
  expect(clientTransport.onData).toBe((client as any).udpOnMessage);

  // close 後 inject は terminal で drop
  client.close();
  expect((client as any).associationTornDown).toBe(true);
  carrier.inject(
    serializePlaintextRecord(
      ContentType.alert,
      0,
      0,
      Buffer.from([2, AlertDesc.HandshakeFailure]),
    ),
    ["10.9.9.9", 9999],
  );
  await new Promise((r) => setTimeout(r, 30));
  expect((client as any).associationTornDown).toBe(true);

  await clientTransport.close().catch(() => {});
}, 15_000);

test("e2e: dual initial client binds association dispatcher before HVR", async () => {
  // Arrange: dual prefer-1.3 — dualPhase still "none" until HVR
  const clientTransport = await UdpTransport.init("udp4");
  const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    handshakeCarrier: carrier,
  });

  // Assert: 初期 dual でも association が RX を所有
  expect(client.dualAssociationPhase).toBe("none");
  expect((client as any).engine13).toBeTruthy();
  expect(clientTransport.onData).toBe((client as any).udpOnMessage);

  // spoof inject from non-peer before connect: no pin yet → allowed through
  // gate (isAssociationPeer true when unpinned); after connect pin, dropped.
  clientTransport.rinfo = { address: "127.0.0.1", port: 4444 };
  await client.connect().catch(() => {
    // no server — connect may hang or error; we only need pin after CH send
  });
  // Pin is set at connect start even if HS incomplete
  await new Promise((r) => setTimeout(r, 20));
  const pinKey = (client as any).dualAssociationPeerKey as string | undefined;
  expect(pinKey).toBeTruthy();

  // Act: spoof inject from wrong peer must not pass association peer gate
  const beforeTornDown = (client as any).associationTornDown;
  carrier.inject(
    serializePlaintextRecord(
      ContentType.handshake,
      0,
      0,
      Buffer.from([2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0xff]),
    ),
    ["203.0.113.9", 12345],
  );
  await new Promise((r) => setTimeout(r, 30));
  // Assert: 端末状態は spoof で変わらない
  expect((client as any).associationTornDown).toBe(beforeTornDown);

  client.close();
  await clientTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: DTLS 1.2 サーバー pre-cookie HVR は、async 処理へ渡した受信元へ送る。
 * mutable rinfo が spoof で書き換わっても HVR は本物の CH 送信元へ届く。
 */
test("e2e/self12: pre-cookie HVR targets CH source not spoofed rinfo", async () => {
  // Arrange
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const sent: Array<{ addr?: [string, number] }> = [];
  const origSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (data: Buffer, addr?: any) => {
    const a = addr as [string, number] | undefined;
    sent.push({
      addr: a
        ? [a[0], a[1]]
        : serverTransport.rinfo?.address != null &&
            serverTransport.rinfo?.port != null
          ? [serverTransport.rinfo.address, serverTransport.rinfo.port]
          : undefined,
    });
    // Do not actually UDP-send (fake peers)
    void data;
    return;
  };

  const realPeer: [string, number] = ["127.0.0.1", 18001];
  const spoofPeer: [string, number] = ["127.0.0.1", 18002];

  // Simulate: CH arrived from realPeer, but rinfo already hijacked to spoof
  (serverTransport as any).rinfo = {
    address: spoofPeer[0],
    port: spoofPeer[1],
  };

  const hello = build12ClientHello();
  // Act: handleHandshakes with explicit peer (as handleUdpDatagram would pass)
  await (server as any).handleHandshakes(chAsAssembled(hello), realPeer);

  // Assert: HVR は CH 受信元へ
  expect(sent.length).toBeGreaterThan(0);
  for (const s of sent) {
    expect(s.addr).toEqual(realPeer);
    expect(s.addr).not.toEqual(spoofPeer);
  }

  server.close();
  await serverTransport.close().catch(() => {});
  void origSend;
}, 15_000);

/**
 * P1: pre-cookie protocol_version alert も明示的な受信元へ送る。
 */
test("e2e/self12: pre-cookie protocol_version alert targets CH source", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  const sent: Array<[string, number] | undefined> = [];
  serverTransport.send = async (_data: Buffer, addr?: any) => {
    sent.push(addr as [string, number] | undefined);
  };

  const realPeer: [string, number] = ["198.51.100.10", 4444];
  (serverTransport as any).rinfo = { address: "203.0.113.1", port: 9 };

  // only TLS_AES_128_GCM_SHA256 → 1.2-only server sends protocol_version
  const hello = build12ClientHello({ only13Cipher: true });
  await (server as any).handleHandshakes(chAsAssembled(hello), realPeer);

  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]).toEqual(realPeer);

  server.close();
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * P1: pre-cookie 複数送信元 race — CH 処理中に rinfo が別 peer に化けても
 * cookie pin は CH 受信元を使う。
 */
test("e2e/self12: cookie pin uses CH source under concurrent rinfo spoof", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
  });

  // Suppress real sends
  serverTransport.send = async () => {};

  const realPeer: [string, number] = ["127.0.0.1", 19001];
  const spoofPeer: [string, number] = ["127.0.0.1", 19002];

  // First empty-cookie CH → mint cookie + HVR (same random for CH2 binding)
  const rnd = fixedClientRandom();
  const ch1 = build12ClientHello({ random: rnd });
  (serverTransport as any).rinfo = {
    address: spoofPeer[0],
    port: spoofPeer[1],
  };
  await (server as any).handleHandshakes(chAsAssembled(ch1), realPeer);
  const cookie = (server as any).dtls.cookie as Buffer;
  expect(cookie?.length).toBeGreaterThan(0);

  // Cookie CH from real peer while rinfo still spoofed.
  // Flight4 may retransmit without a full peer HS — pin is set *before* exec.
  const ch2 = build12ClientHello({
    cookie: Buffer.from(cookie),
    random: rnd,
  });
  const hsPromise = (server as any).handleHandshakes(
    chAsAssembled(ch2),
    realPeer,
  );
  // Wait only for pin to land (sync before Flight4 retransmit sleep)
  await new Promise((r) => setTimeout(r, 50));

  const pin = (server as any).transport.pinnedPeer as
    | [string, number]
    | undefined;
  expect(pin).toBeTruthy();
  expect(pin![0]).toBe(realPeer[0]);
  expect(pin![1]).toBe(realPeer[1]);
  expect(pin![1]).not.toBe(spoofPeer[1]);

  server.close();
  await hsPromise.catch(() => {});
  await serverTransport.close().catch(() => {});
}, 15_000);

/**
 * pure 1.3: close 後の carrier.inject は association terminal で drop。
 * （全フェーズで同一 dispatcher を通すことの回帰）
 */
test("e2e/self13: close then carrier.inject is dropped by association", async () => {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
    mtu: 1200,
  });
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
  });
  const client = createDtlsClientInternal({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3],
    handshakeCarrier: clientCarrier,
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 15_000);
    client.onConnect.subscribe(() => {
      clearTimeout(t);
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(t);
      reject(e);
    });
    void client.connect();
  });

  // Act: close then inject spoof alert
  client.close();
  expect((client as any).associationTornDown).toBe(true);
  const errors: Error[] = [];
  client.onError.subscribe((e) => errors.push(e));
  clientCarrier.inject(
    serializePlaintextRecord(
      ContentType.alert,
      0,
      0,
      Buffer.from([2, AlertDesc.InternalError]),
    ),
    ["10.0.0.9", 8],
  );
  await new Promise((r) => setTimeout(r, 40));

  // Assert: 追加エラーなし（terminal drop）
  expect(errors.length).toBe(0);

  server.close();
  await clientTransport.close().catch(() => {});
  await serverTransport.close().catch(() => {});
}, 20_000);
