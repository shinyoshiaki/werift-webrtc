import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { ProtectionProfileAeadAes128Gcm } from "../../../rtp/src/srtp/const";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import {
  CipherSuite,
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
import { ContentType } from "../../src/record/const";
import { FragmentedHandshake } from "../../src/record/message/fragment";
import { DTLS_1_2_VERSION, DTLS_1_3_VERSION } from "../../src/version";
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

  // Assert: CH-A は 1.3 engine の拡張（EMS / renegotiation は載せない）
  expect(a.has(SupportedVersions.type)).toBe(true);
  expect(a.has(KeyShare.type)).toBe(true);
  expect(a.has(SignatureAlgorithms.type)).toBe(true);
  expect(a.has(UseSRTP.type)).toBe(true);
  expect(a.has(ExtendedMasterSecret.type)).toBe(false);
  expect(a.has(RenegotiationIndication.type)).toBe(false);
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

  // Assert: HVR 後 CH は 1.3 拡張を残し、1.2 拡張と legacy cookie を載せる
  expect(b.has(SupportedVersions.type)).toBe(true);
  expect(b.has(KeyShare.type)).toBe(true);
  expect(b.has(SignatureAlgorithms.type)).toBe(true);
  expect(b.has(UseSRTP.type)).toBe(true);
  expect(b.has(ExtendedMasterSecret.type)).toBe(true);
  expect(b.has(RenegotiationIndication.type)).toBe(true);
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
