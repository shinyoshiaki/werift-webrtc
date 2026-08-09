import { describe, expect, test } from "vitest";
import { NamedCurveAlgorithm } from "../../../src/cipher/const";
import { generateKeyPair } from "../../../src/cipher/namedCurve";
import { HandshakeType } from "../../../src/handshake/const";
import { KeyShare } from "../../../src/handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../src/handshake/extensions/signatureAlgorithms";
import { CertificateRequest13 } from "../../../src/handshake/message/tls13/certificateRequest";
import { AlertDesc } from "../../../src/record/const";
import { DtlsProtocolError } from "../../../src/version";
import { UdpTransport } from "../../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../../src";
import { certPem, keyPem } from "../../fixture";

describe("P2: handshake message order state machine", () => {
  test("client rejects Certificate before EncryptedExtensions", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const client = new DtlsClient({
      transport: clientTransport,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const eng = (client as any).engine13;
    // Force phase as if SH was processed
    eng.hsPhase = "wait_ee";

    // Act / Assert: Certificate when EE expected
    await expect(
      eng.dispatchHandshake(
        {
          msg_type: HandshakeType.certificate_11,
          message_seq: 1,
          fragment: Buffer.from([0]), // body unused — order check first
        },
        2,
      ),
    ).rejects.toMatchObject({
      name: "DtlsProtocolError",
      alertDescription: AlertDesc.UnexpectedMessage,
    });

    client.close();
    server.close();
    await serverTransport.close();
    await clientTransport.close();
  });

  test("server rejects EncryptedExtensions from client on epoch 2", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const eng = (server as any).engine13;
    eng.hsPhase = "wait_client_finished";

    // Act / Assert
    await expect(
      eng.dispatchHandshake(
        {
          msg_type: HandshakeType.encrypted_extensions_8,
          message_seq: 2,
          fragment: Buffer.alloc(2),
        },
        2,
      ),
    ).rejects.toMatchObject({
      name: "DtlsProtocolError",
      message: expect.stringMatching(/unexpected_message/i),
    });

    server.close();
    await serverTransport.close();
  });
});

describe("P2: strict vector length validation", () => {
  test("key_share client rejects trailing bytes", () => {
    // Arrange: valid single X25519 share + trailing 0xff
    const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    const good = KeyShare.forClient([
      { group: NamedCurveAlgorithm.x25519_29, keyExchange: kp.publicKey },
    ]).serializeClientData();
    const bad = Buffer.concat([good, Buffer.from([0xff])]);
    // Act / Assert
    expect(() => KeyShare.fromClientData(bad)).toThrow(/length mismatch/i);
  });

  test("key_share server rejects trailing bytes", () => {
    const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    const good = KeyShare.forServer({
      group: NamedCurveAlgorithm.x25519_29,
      keyExchange: kp.publicKey,
    }).serializeServerData();
    const bad = Buffer.concat([good, Buffer.from([0x00])]);
    expect(() => KeyShare.fromServerData(bad)).toThrow(/length mismatch/i);
  });

  test("key_share rejects wrong X25519 key_exchange length", () => {
    const short = Buffer.alloc(16, 1);
    const list = Buffer.alloc(2 + 4 + 16);
    list.writeUInt16BE(4 + 16, 0);
    list.writeUInt16BE(NamedCurveAlgorithm.x25519_29, 2);
    list.writeUInt16BE(16, 4);
    short.copy(list, 6);
    expect(() => KeyShare.fromClientData(list)).toThrow(
      /key_exchange length|illegal_parameter/i,
    );
  });

  test("signature_algorithms rejects trailing bytes", () => {
    const good = SignatureAlgorithms.create([0x0804]).serializeData();
    const bad = Buffer.concat([good, Buffer.from([0x00])]);
    expect(() => SignatureAlgorithms.fromData(bad)).toThrow(/invalid length/i);
  });

  test("CertificateRequest13 rejects trailing bytes", () => {
    const cr = CertificateRequest13.create(Buffer.alloc(0));
    const good = cr.serialize();
    const bad = Buffer.concat([good, Buffer.from([0xde, 0xad])]);
    expect(() => CertificateRequest13.deSerialize(bad)).toThrow(
      /length mismatch/i,
    );
  });
});

describe("P2: DtlsProtocolError shape", () => {
  test("carries alert description", () => {
    const e = new DtlsProtocolError("test", AlertDesc.UnexpectedMessage);
    expect(e.name).toBe("DtlsProtocolError");
    expect(e.alertDescription).toBe(AlertDesc.UnexpectedMessage);
  });
});
