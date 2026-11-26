import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { ProtectionProfileAeadAes128Gcm } from "../../../rtp/src/srtp/const";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import {
  CipherSuite,
  type CipherSuites,
  HashAlgorithm,
  SignatureAlgorithm,
} from "../../src/cipher/const";
import { HandshakeType } from "../../src/handshake/const";
import { ExtendedMasterSecret } from "../../src/handshake/extensions/extendedMasterSecret";
import { KeyShare } from "../../src/handshake/extensions/keyShare";
import { RenegotiationIndication } from "../../src/handshake/extensions/renegotiationIndication";
import { SignatureAlgorithms } from "../../src/handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../src/handshake/extensions/supportedVersions";
import { UseSRTP } from "../../src/handshake/extensions/useSrtp";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { ServerHello } from "../../src/handshake/message/server/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { ContentType } from "../../src/record/const";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  WireVersion,
} from "../../src/version";
import { certPem, keyPem } from "../fixture";

function collectClientHellos(datagram: Buffer): ClientHello[] {
  const hellos: ClientHello[] = [];
  let offset = 0;
  while (offset + 13 <= datagram.length) {
    const first = datagram[offset]!;
    if (first < 20 || first > 63) break;
    const contentLen = datagram.readUInt16BE(offset + 11);
    if (offset + 13 + contentLen > datagram.length) break;
    const fragment = datagram.subarray(offset + 13, offset + 13 + contentLen);
    const contentType = datagram.readUInt8(offset);
    offset += 13 + contentLen;
    if (contentType !== ContentType.handshake || fragment.length < 12) {
      continue;
    }
    try {
      const hs = FragmentedHandshake.deSerialize(fragment);
      if (hs.msg_type !== HandshakeType.client_hello_1) continue;
      hellos.push(ClientHello.deSerialize(hs.fragment));
    } catch {
      // CCS / 断片化など ClientHello 以外は無視
    }
  }
  return hellos;
}

function extTypes(ch: ClientHello): Set<number> {
  return new Set(ch.extensions.map((e) => e.type));
}

function extData(ch: ClientHello, type: number): Buffer {
  const found = ch.extensions.find((e) => e.type === type);
  if (!found) throw new Error(`missing extension ${type}`);
  return found.data;
}

test("e2e/dual: CH-A and HVR-cookie ClientHello extension sets on the wire", async () => {
  // Arrange: dual client × 1.2-only server（本物の 1.2 Flight2 HVR）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
  const srtp = [ProtectionProfileAeadAes128Gcm];
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
    extendedMasterSecret: true,
    srtpProfiles: srtp,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    extendedMasterSecret: true,
    srtpProfiles: srtp,
  });

  const hellos: ClientHello[] = [];
  const origSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    try {
      hellos.push(...collectClientHellos(Buffer.from(buf)));
    } catch {
      // tap 失敗で TX を止めない
    }
    return origSend(buf, addr);
  };

  // Act: handshake を完走し、CH-A と HVR 後 CH を tap する
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("dual fallback CH wire timeout")),
      15_000,
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
      if (/protocol version|DTLS 1\.3 cipher/i.test(e.message)) return;
      clearTimeout(timer);
      reject(e);
    });
    await client.connect();
  });

  const chA = hellos.find((ch) => ch.cookie.length === 0);
  const ch2 = hellos.find((ch) => ch.cookie.length > 0);
  expect(chA).toBeDefined();
  expect(ch2).toBeDefined();
  const a = extTypes(chA!);
  const b = extTypes(ch2!);

  // Assert: CH-A は 1.3 engine の拡張に加え、1.2 server が CH1 から読む
  // EMS / renegotiation_info も載せる（develop 以前の werift は EMS を CH1 だけで判定する）
  expect(a.has(SupportedVersions.type)).toBe(true);
  expect(a.has(KeyShare.type)).toBe(true);
  expect(a.has(SignatureAlgorithms.type)).toBe(true);
  expect(a.has(UseSRTP.type)).toBe(true);
  expect(a.has(ExtendedMasterSecret.type)).toBe(true);
  expect(a.has(RenegotiationIndication.type)).toBe(true);
  expect(chA!.cookie.length).toBe(0);
  expect(chA!.cipherSuites).toContain(
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
  );
  expect(chA!.cipherSuites).toContain(
    CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
  );
  const svA = SupportedVersions.fromData(
    extData(chA!, SupportedVersions.type),
    false,
  );
  expect(svA.versions).toEqual([DTLS_1_3_VERSION, DTLS_1_2_VERSION]);
  const sigA = SignatureAlgorithms.fromData(
    extData(chA!, SignatureAlgorithms.type),
  );
  expect(sigA.schemes).toContain(0x0401);

  // Assert: HVR 後 CH は CH-A と同じ拡張集合に legacy cookie を載せる（RFC 6347 §4.2.1）
  expect(b.has(SupportedVersions.type)).toBe(true);
  expect(b.has(KeyShare.type)).toBe(true);
  expect(b.has(SignatureAlgorithms.type)).toBe(true);
  expect(b.has(UseSRTP.type)).toBe(true);
  expect(b.has(ExtendedMasterSecret.type)).toBe(true);
  expect(b.has(RenegotiationIndication.type)).toBe(true);
  expect([...b].sort()).toEqual([...a].sort());
  expect(ch2!.cookie.length).toBeGreaterThan(0);
  expect(ch2!.cipherSuites).toContain(
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
  );
  expect(ch2!.cipherSuites).toContain(
    CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
  );
  const sv2 = SupportedVersions.fromData(
    extData(ch2!, SupportedVersions.type),
    false,
  );
  expect(sv2.versions).toEqual([DTLS_1_3_VERSION, DTLS_1_2_VERSION]);

  client.close();
  server.close();
  await clientTransport.close();
  await serverTransport.close();
}, 20_000);

function dtls12ServerHelloWithoutSupportedVersions(
  cipherSuite: CipherSuites,
): Buffer {
  const sh = new ServerHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    cipherSuite,
    0,
    [],
  );
  sh.messageSeq = 0;
  const frag = sh.toFragment();
  frag.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    frag.serialize(),
  );
}

test("e2e/dual: cookie-less 1.2 ServerHello park retransmits CH-A unchanged", async () => {
  // Arrange: Chrome ICE 相当。HVR を出さず、SV 無しの 1.2 SH だけ返す
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    extendedMasterSecret: true,
    srtpProfiles: [ProtectionProfileAeadAes128Gcm],
  });

  const hellos: ClientHello[] = [];
  let replied = false;
  serverTransport.onData = (buf, addr) => {
    hellos.push(...collectClientHellos(Buffer.from(buf)));
    if (replied) return;
    if (collectClientHellos(Buffer.from(buf)).length === 0) return;
    replied = true;
    void serverTransport.send(
      dtls12ServerHelloWithoutSupportedVersions(
        CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
      ),
      addr,
    );
  };

  // Act: CH-A のあとに 1.2 SH を注入し、cookie 無しの再送 CH を待つ
  void client.connect().catch(() => {});
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const cookieLess = hellos.filter((ch) => ch.cookie.length === 0);
    if (replied && cookieLess.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const cookieLess = hellos.filter((ch) => ch.cookie.length === 0);
  const chA = cookieLess[0];
  const chResend = cookieLess[1];

  // Assert: SH-only park の再送は CH-A と同じ拡張集合（CH-A の EMS をそのまま保つ）
  expect(chA).toBeDefined();
  expect(chResend).toBeDefined();
  expect(extTypes(chA!).has(ExtendedMasterSecret.type)).toBe(true);
  expect(extTypes(chResend!).has(ExtendedMasterSecret.type)).toBe(true);
  expect(extTypes(chResend!).has(RenegotiationIndication.type)).toBe(true);
  expect([...extTypes(chResend!)].sort()).toEqual([...extTypes(chA!)].sort());

  client.close();
  await clientTransport.close();
  await serverTransport.close();
}, 10_000);

test("e2e/1.3-only: ClientHello does not offer EMS (only a ClientHello that also offers DTLS 1.2 does)", async () => {
  // Arrange: 1.3 だけを提示する client。送出される ClientHello を tap する
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: {
      hash: HashAlgorithm.sha256_4,
      signature: SignatureAlgorithm.rsa_1,
    },
    protocolVersions: [DtlsVersion.V1_3],
    extendedMasterSecret: true,
    srtpProfiles: [ProtectionProfileAeadAes128Gcm],
  });
  const hellos: ClientHello[] = [];
  serverTransport.onData = (buf) => {
    hellos.push(...collectClientHellos(Buffer.from(buf)));
  };

  // Act: 接続を開始し、最初の ClientHello を待つ
  void client.connect().catch(() => {});
  const deadline = Date.now() + 5_000;
  while (hellos.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }

  // Assert: 1.3 の拡張だけで、EMS は載らない
  expect(hellos.length).toBeGreaterThan(0);
  expect(extTypes(hellos[0]!).has(SupportedVersions.type)).toBe(true);
  expect(extTypes(hellos[0]!).has(ExtendedMasterSecret.type)).toBe(false);

  client.close();
  await clientTransport.close();
  await serverTransport.close();
}, 10_000);

test("e2e/dual: CH-A and HVR-cookie ClientHello offer the ChaCha20-Poly1305 1.2 suites", async () => {
  // Arrange: dual client × 1.2-only server（本物の 1.2 Flight2 HVR）
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;
  const sig = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_2],
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: sig,
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });
  const hellos: ClientHello[] = [];
  const origSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (buf: Buffer, addr?: any) => {
    try {
      hellos.push(...collectClientHellos(Buffer.from(buf)));
    } catch {
      // tap 失敗で TX を止めない
    }
    return origSend(buf, addr);
  };

  // Act: handshake を開始し、CH-A と HVR 後 CH の両方を tap するまで待つ
  void client.connect().catch(() => {});
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      hellos.some((ch) => ch.cookie.length === 0) &&
      hellos.some((ch) => ch.cookie.length > 0)
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const chA = hellos.find((ch) => ch.cookie.length === 0);
  const ch2 = hellos.find((ch) => ch.cookie.length > 0);

  // Assert: 1.3 engine の CH-A も HVR cookie 付き CH も ChaCha20-Poly1305 の 1.2 suite を提示する
  expect(chA).toBeDefined();
  expect(ch2).toBeDefined();
  for (const ch of [chA!, ch2!]) {
    expect(ch.cipherSuites).toContain(
      CipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256_52393,
    );
    expect(ch.cipherSuites).toContain(
      CipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256_52392,
    );
  }

  client.close();
  server.close();
  await clientTransport.close();
  await serverTransport.close();
}, 15_000);

test("dual: 1.2 ServerHello selecting ChaCha20-Poly1305 is accepted by the probing classifier", async () => {
  // Arrange: dual client と、SV 無しの 1.2 ServerHello（AES-GCM / ChaCha / 未知 suite）
  const clientTransport = await UdpTransport.init("udp4");
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash: {
      hash: HashAlgorithm.sha256_4,
      signature: SignatureAlgorithm.rsa_1,
    },
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  });
  const classify = (cipherSuite: number) =>
    (client as any).classifyProbingServerHello(
      new ServerHello(
        WireVersion.DTLS_1_2,
        new DtlsRandom(),
        Buffer.alloc(0),
        cipherSuite as CipherSuites,
        0,
        [],
      ).serialize(),
    ).kind;

  // Act: dual probing の ServerHello 判定を suite ごとに行う
  const aesKind = classify(
    CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
  );
  const chachaRsaKind = classify(
    CipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256_52392,
  );
  const chachaEcdsaKind = classify(
    CipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256_52393,
  );
  const unknownKind = classify(0x1234);

  // Assert: ChaCha の 1.2 SH は AES-GCM と同じく dtls12 として受理され、未知 suite は破棄される
  expect(aesKind).toBe("dtls12");
  expect(chachaRsaKind).toBe("dtls12");
  expect(chachaEcdsaKind).toBe("dtls12");
  expect(unknownKind).toBe("drop");

  client.close();
  await clientTransport.close();
});
