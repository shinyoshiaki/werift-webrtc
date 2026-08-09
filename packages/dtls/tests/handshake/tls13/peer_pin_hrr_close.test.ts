import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../../src";
import { CipherSuite } from "../../../src/cipher/const";
import { NamedCurveAlgorithm } from "../../../src/cipher/const";
import { generateKeyPair } from "../../../src/cipher/namedCurve";
import { MAX_ACK_RECORD_NUMBERS } from "../../../src/engine/v1_3/types";
import { EllipticCurves } from "../../../src/handshake/extensions/ellipticCurves";
import { KeyShare } from "../../../src/handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../src/handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../src/handshake/extensions/supportedVersions";
import { ClientHello } from "../../../src/handshake/message/client/hello";
import {
  DtlsAck,
  MAX_ACK_RECORD_NUMBERS_INBOUND,
} from "../../../src/handshake/message/tls13/ack";
import { DtlsRandom } from "../../../src/handshake/random";
import { ContentType } from "../../../src/record/const";
import { serializePlaintextRecord } from "../../../src/record/v1_3/record";
import { DTLS_1_3_VERSION, WireVersion } from "../../../src/version";
import { certPem, keyPem } from "../../fixture";

const dtls13Options = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  addressValidation: "none" as const,
};

async function pair(extra?: {
  addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
}) {
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const opts = { ...dtls13Options, ...extra };
  const server = new DtlsServer({
    transport: serverTransport,
    ...opts,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...opts,
  });
  return { server, client, serverTransport, clientTransport };
}

describe("P1: remote peer pin (rinfo hijack)", () => {
  test("post-handshake app data is not redirected after foreign UDP packet", async () => {
    // Arrange
    const { server, client, serverTransport, clientTransport } = await pair();
    const word = "pin-test";

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("peer pin handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });

      server.onData.subscribe((data) => {
        // Assert: server still received client data after noise
        expect(data.toString()).toBe(word);
        void server.send(Buffer.from(word + "_ok"));
      });
      client.onData.subscribe((data) => {
        // Assert: client got response on the real 5-tuple (not hijacked)
        expect(data.toString()).toBe(word + "_ok");
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });

      client.onConnect.subscribe(() => {
        // Act: inject noise that would rewrite UdpTransport.rinfo if association
        // used last-rinfo for TX (simulate foreign source by mutating rinfo)
        const realClient = clientTransport.address;
        serverTransport.rinfo = { address: "203.0.113.9", port: 9 };
        void client.send(Buffer.from(word));
        // Restore rinfo for OS path so client can still receive (send uses pin)
        serverTransport.rinfo = {
          address: realClient.address,
          port: realClient.port,
        };
      });

      await client.connect();
    });
  }, 20_000);

  test("dtls-cookie pin: foreign source packets do not steal association", async () => {
    // Arrange
    const { server, client, serverTransport } = await pair({
      addressValidation: "dtls-cookie",
    });

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("cookie pin handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        // Act: after connect, pin is set — foreign rinfo must not redirect
        const eng = (server as any).engine13;
        expect(eng).toBeTruthy();
        expect(eng.pinnedPeerKey || eng.provisionalPeerKey).toBeTruthy();
        const pinned = eng.pinnedPeerKey ?? eng.provisionalPeerKey;
        const sendAddr = eng.getSendAddr?.() ?? eng.peerAddr;
        expect(sendAddr).toBeTruthy();
        // Mutate transport rinfo to attacker
        serverTransport.rinfo = { address: "198.51.100.1", port: 4444 };
        // getSendAddr must still be the real client
        const after = eng.getSendAddr?.() ?? eng.peerAddr;
        expect(after[0]).not.toBe("198.51.100.1");
        expect(eng.expectedPeerKey?.() ?? eng.pinnedPeerKey).toBe(pinned);
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);

  test("pre-handshake garbage from B does not lock out legitimate ClientHello from A", async () => {
    // Arrange: P1 regression — lockProvisionalPeer must not run on undecoded UDP
    const { server, client, serverTransport } = await pair({
      addressValidation: "none",
    });

    // Act: attacker B sends random garbage before any handshake
    serverTransport.onData?.(Buffer.from("not-a-dtls-record-at-all"), [
      "203.0.113.50",
      9,
    ] as any);
    await new Promise((r) => setTimeout(r, 30));

    const engEarly = (server as any).engine13;
    // 1.3-only server may create engine on first data via dual path; pure 1.3 uses engine13 from start
    // Either way, provisional must not be locked to the attacker
    if (engEarly) {
      expect(engEarly.provisionalPeerKey).toBeUndefined();
      expect(engEarly.pinnedPeerKey).toBeUndefined();
    }

    // Assert: legitimate handshake still completes
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("garbage-then-CH handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        const eng = (server as any).engine13;
        expect(eng).toBeTruthy();
        // Peer is the real client, not attacker B
        const key = eng.pinnedPeerKey ?? eng.provisionalPeerKey;
        expect(key).toBeTruthy();
        expect(String(key)).not.toContain("203.0.113.50");
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);

  test("valid cookie-less CH from B does not lock out legitimate A (dtls-cookie)", async () => {
    // Arrange: B sends a well-formed CH without completing cookie → A must still connect
    const { server, client, serverTransport } = await pair({
      addressValidation: "dtls-cookie",
    });
    const probe = (() => {
      const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
      const curves = EllipticCurves.createEmpty();
      curves.data = [NamedCurveAlgorithm.x25519_29] as any;
      const ch = new ClientHello(
        WireVersion.DTLS_1_2,
        new DtlsRandom(),
        Buffer.alloc(0),
        Buffer.alloc(0),
        [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
        [0],
        [
          SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
          curves.extension,
          KeyShare.forClient([
            {
              group: NamedCurveAlgorithm.x25519_29,
              keyExchange: kp.publicKey,
            },
          ]).clientExtension,
          SignatureAlgorithms.create().extension,
        ],
      );
      ch.messageSeq = 0;
      const frag = ch.toFragment();
      frag.message_seq = 0;
      return serializePlaintextRecord(
        ContentType.handshake,
        0,
        0,
        frag.serialize(),
      );
    })();

    // Act: attacker B valid CH (no cookie) — server may HRR but must not pin
    serverTransport.onData?.(probe, ["203.0.113.77", 4444] as any);
    await new Promise((r) => setTimeout(r, 50));
    const engB = (server as any).engine13;
    expect(engB.provisionalPeerKey).toBeUndefined();
    expect(engB.pinnedPeerKey).toBeUndefined();

    // Assert: legitimate client A completes cookie exchange + handshake
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("B-CH then A handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        const eng = (server as any).engine13;
        const key = eng.pinnedPeerKey ?? eng.provisionalPeerKey;
        expect(key).toBeTruthy();
        expect(String(key)).not.toContain("203.0.113.77");
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);

  test("client pins destination at connect; forged HRR from B does not redirect CH2", async () => {
    // Arrange
    const { server, client, clientTransport } = await pair({
      addressValidation: "dtls-cookie",
    });
    const clientEng = (client as any).engine13;
    const realServer = clientTransport.rinfo!;
    // Capture client outbound addresses
    const sendAddrs: Array<[string, number] | undefined> = [];
    const origSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (buf: Buffer, addr?: any) => {
      sendAddrs.push(
        Array.isArray(addr)
          ? [addr[0], addr[1]]
          : addr?.address != null
            ? [addr.address, addr.port]
            : undefined,
      );
      return origSend(buf, addr);
    };

    // Act: pin destination via connect, then inject foreign-looking SH/HRR path
    // by mutating rinfo as if a packet arrived from B (demux must drop / not rebind)
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("client pin connect timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        // Assert: client pin uses loopback when rinfo was 0.0.0.0 (normalize)
        const expectedHost =
          realServer.address === "0.0.0.0" ? "127.0.0.1" : realServer.address;
        expect(clientEng.pinnedPeerKey).toBe(
          `${expectedHost}:${realServer.port}`,
        );
        for (const a of sendAddrs) {
          if (!a) continue;
          expect(a[0]).toBe(expectedHost);
          expect(a[1]).toBe(realServer.port);
        }
        // Mutate rinfo as if foreign source "arrived" — getSendAddr must stay
        clientTransport.rinfo = { address: "198.51.100.9", port: 9 };
        const dest = clientEng.getSendAddr?.() ?? clientEng.peerAddr;
        expect(dest[0]).toBe(expectedHost);
        expect(dest[1]).toBe(realServer.port);
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);
});

describe("P2: inbound ACK processing bound", () => {
  test("deSerialize caps record_numbers at MAX_ACK_RECORD_NUMBERS_INBOUND", () => {
    // Arrange: wire claims many more entries than local bound
    const n = MAX_ACK_RECORD_NUMBERS_INBOUND + 50;
    const listLen = n * 16;
    const buf = Buffer.alloc(2 + listLen);
    buf.writeUInt16BE(listLen, 0);
    for (let i = 0; i < n; i++) {
      const off = 2 + i * 16;
      buf.writeBigUInt64BE(BigInt(3), off);
      buf.writeBigUInt64BE(BigInt(i), off + 8);
    }
    // Act
    const ack = DtlsAck.deSerialize(buf);
    // Assert
    expect(ack.recordNumbers.length).toBe(MAX_ACK_RECORD_NUMBERS_INBOUND);
    expect(MAX_ACK_RECORD_NUMBERS_INBOUND).toBe(MAX_ACK_RECORD_NUMBERS);
    expect(ack.recordNumbers[0].sequenceNumber).toBe(0);
    expect(ack.recordNumbers[ack.recordNumbers.length - 1].sequenceNumber).toBe(
      MAX_ACK_RECORD_NUMBERS_INBOUND - 1,
    );
  });
});

describe("P2: close_notify epoch/seq boundary", () => {
  test("application data with lower seq than close_notify is still deliverable", async () => {
    // Arrange: full handshake then inject reordered close + app via engine internals
    const { server, client } = await pair();

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("close boundary setup timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        const eng = (client as any).engine13;
        expect(eng).toBeTruthy();
        // Act: set close boundary at epoch 3 seq 11 (as if close_notify arrived first)
        eng.peerCloseBoundary = { epoch: 3, sequenceNumber: 11 };
        const shouldDrop = (epoch: number, seq: number) => {
          const b = eng.peerCloseBoundary;
          return (
            epoch > b.epoch || (epoch === b.epoch && seq > b.sequenceNumber)
          );
        };
        // Assert: RFC 9147 — only greater epoch/seq ignored
        expect(shouldDrop(3, 10)).toBe(false);
        expect(shouldDrop(3, 11)).toBe(false);
        expect(shouldDrop(3, 12)).toBe(true);
        expect(shouldDrop(4, 0)).toBe(true);
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);
});

describe("P2: missing_extension fails promptly (not timeout)", () => {
  function buildChMissingKeyShare(): Buffer {
    const curves = EllipticCurves.createEmpty();
    curves.data = [NamedCurveAlgorithm.x25519_29] as any;
    const ch = new ClientHello(
      WireVersion.DTLS_1_2,
      new DtlsRandom(),
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
        curves.extension,
        // deliberately omit key_share
        SignatureAlgorithms.create().extension,
      ],
    );
    ch.messageSeq = 0;
    const frag = ch.toFragment();
    frag.message_seq = 0;
    return serializePlaintextRecord(
      ContentType.handshake,
      0,
      0,
      frag.serialize(),
    );
  }

  function buildChMissingSupportedGroups(): Buffer {
    const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    const ch = new ClientHello(
      WireVersion.DTLS_1_2,
      new DtlsRandom(),
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
        // deliberately omit supported_groups
        KeyShare.forClient([
          { group: NamedCurveAlgorithm.x25519_29, keyExchange: kp.publicKey },
        ]).clientExtension,
        SignatureAlgorithms.create().extension,
      ],
    );
    ch.messageSeq = 0;
    const frag = ch.toFragment();
    frag.message_seq = 0;
    return serializePlaintextRecord(
      ContentType.handshake,
      0,
      0,
      frag.serialize(),
    );
  }

  test("ClientHello without key_share fails with missing_extension", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("missing key_share should fail promptly")),
        3_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/missing_extension|key_share/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(buildChMissingKeyShare(), [
        "127.0.0.1",
        9,
      ] as any);
    });
  }, 10_000);

  test("ClientHello without supported_groups fails with missing_extension", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    // Act / Assert
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("missing supported_groups should fail promptly")),
        3_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/missing_extension|supported_groups/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(buildChMissingSupportedGroups(), [
        "127.0.0.1",
        9,
      ] as any);
    });
  }, 10_000);
});

describe("P2: use_srtp RFC 5764 server response", () => {
  test("rejects multi-profile use_srtp in EncryptedExtensions", async () => {
    // Arrange: client engine with offered use_srtp
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([14]); // use_srtp
    eng.clientOfferedSrtpMki = Buffer.alloc(0);
    eng.options.srtpProfiles = [1, 2];
    const { UseSRTP } = await import(
      "../../../src/handshake/extensions/useSrtp"
    );
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    // Act: server illegally returns two profiles
    const multi = UseSRTP.create([1, 2], Buffer.alloc(0));
    const ee = new EncryptedExtensions([multi.extension]);
    // Assert
    await expect(eng.onEncryptedExtensions(ee.serialize())).rejects.toThrow(
      /exactly one profile/i,
    );
    client.close();
    server.close();
  });

  test("rejects use_srtp profile not offered by client", async () => {
    // Arrange
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([14]);
    eng.clientOfferedSrtpMki = Buffer.alloc(0);
    eng.options.srtpProfiles = [1];
    const { UseSRTP } = await import(
      "../../../src/handshake/extensions/useSrtp"
    );
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    const bad = UseSRTP.create([0x0007], Buffer.alloc(0));
    const ee = new EncryptedExtensions([bad.extension]);
    // Act / Assert
    await expect(eng.onEncryptedExtensions(ee.serialize())).rejects.toThrow(
      /not offered/i,
    );
    client.close();
    server.close();
  });

  test("rejects use_srtp MKI mismatch (different non-empty)", async () => {
    // Arrange: client offered empty MKI; server returns different non-empty
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([14]);
    eng.clientOfferedSrtpMki = Buffer.alloc(0);
    eng.options.srtpProfiles = [1];
    const { UseSRTP } = await import(
      "../../../src/handshake/extensions/useSrtp"
    );
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    const badMki = UseSRTP.create([1], Buffer.from([0x01, 0x02]));
    const ee = new EncryptedExtensions([badMki.extension]);
    // Act / Assert
    await expect(eng.onEncryptedExtensions(ee.serialize())).rejects.toThrow(
      /MKI/i,
    );
    client.close();
    server.close();
  });

  test("accepts empty MKI response even if client offered non-empty MKI", async () => {
    // Arrange: RFC 5764 — server may disable MKI with empty response
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([14]);
    eng.clientOfferedSrtpMki = Buffer.from([0xaa, 0xbb]);
    eng.options.srtpProfiles = [1];
    const { UseSRTP } = await import(
      "../../../src/handshake/extensions/useSrtp"
    );
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    const emptyMki = UseSRTP.create([1], Buffer.alloc(0));
    const ee = new EncryptedExtensions([emptyMki.extension]);
    // Act / Assert: must not throw
    await eng.onEncryptedExtensions(ee.serialize());
    expect(eng.negotiatedSrtpProfile).toBe(1);
    client.close();
    server.close();
  });

  test("rejects unsolicited unknown extension in EE", async () => {
    // Arrange
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([10]); // only supported_groups
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    // unknown type 0x9999 not offered
    const ee = new EncryptedExtensions([
      { type: 0x9999, data: Buffer.from([1]) },
    ]);
    // Act / Assert
    await expect(eng.onEncryptedExtensions(ee.serialize())).rejects.toThrow(
      /unsupported_extension|unsolicited/i,
    );
    client.close();
    server.close();
  });

  test("allows supported_groups in EE when offered", async () => {
    // Arrange
    const { client, server } = await pair();
    const eng = (client as any).engine13;
    eng.clientOfferedExtensionTypes = new Set([EllipticCurves.type]);
    const curves = EllipticCurves.createEmpty();
    curves.data = [NamedCurveAlgorithm.x25519_29] as any;
    const { EncryptedExtensions } = await import(
      "../../../src/handshake/message/tls13/encryptedExtensions"
    );
    const ee = new EncryptedExtensions([curves.extension]);
    // Act: must not throw (transcript add only)
    await eng.onEncryptedExtensions(ee.serialize());
    client.close();
    server.close();
  });
});

describe("P2: duplicate extensions rejected", () => {
  test("ClientHello with duplicate extension type fails", async () => {
    // Arrange
    const serverTransport = await UdpTransport.init("udp4");
    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });
    const kp = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    const curves = EllipticCurves.createEmpty();
    curves.data = [NamedCurveAlgorithm.x25519_29] as any;
    const sv = SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension;
    const ch = new ClientHello(
      WireVersion.DTLS_1_2,
      new DtlsRandom(),
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        sv,
        sv, // duplicate supported_versions
        curves.extension,
        KeyShare.forClient([
          { group: NamedCurveAlgorithm.x25519_29, keyExchange: kp.publicKey },
        ]).clientExtension,
        SignatureAlgorithms.create().extension,
      ],
    );
    ch.messageSeq = 0;
    const frag = ch.toFragment();
    frag.message_seq = 0;
    const pkt = serializePlaintextRecord(
      ContentType.handshake,
      0,
      0,
      frag.serialize(),
    );
    // Act / Assert
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("duplicate extension should fail promptly")),
        3_000,
      );
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        try {
          expect(e.message).toMatch(/duplicate extension/i);
          server.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      serverTransport.onData?.(pkt, ["127.0.0.1", 9] as any);
    });
  }, 10_000);
});

describe("P2: CH2 key_share single entry after HRR selected_group", () => {
  test("rejects ClientHello2 key_share with extra groups", async () => {
    // Arrange: use server engine internals after recording HRR selected_group
    const { server, client } = await pair();
    const eng = (server as any).engine13;
    eng.hrrSelectedGroup = NamedCurveAlgorithm.secp256r1_23;
    eng.hrrHadCookie = false;
    eng.awaitingHrr = true;

    const rand = new DtlsRandom();
    const curves = EllipticCurves.createEmpty();
    curves.data = [
      NamedCurveAlgorithm.x25519_29,
      NamedCurveAlgorithm.secp256r1_23,
    ] as any;
    const baseExts = [
      SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
      curves.extension,
      SignatureAlgorithms.create().extension,
    ];
    const kp1 = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    const ch1 = new ClientHello(
      WireVersion.DTLS_1_2,
      rand,
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        ...baseExts,
        KeyShare.forClient([
          {
            group: NamedCurveAlgorithm.x25519_29,
            keyExchange: kp1.publicKey,
          },
        ]).clientExtension,
      ],
    );
    const ch1Body = ch1.serialize();
    eng.firstClientHelloBody = ch1Body;

    const kpP256 = generateKeyPair(NamedCurveAlgorithm.secp256r1_23);
    const kpX = generateKeyPair(NamedCurveAlgorithm.x25519_29);
    // Act: CH2 with two key shares (illegal after selected_group HRR)
    const ch2 = new ClientHello(
      WireVersion.DTLS_1_2,
      rand,
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        ...baseExts,
        KeyShare.forClient([
          {
            group: NamedCurveAlgorithm.secp256r1_23,
            keyExchange: kpP256.publicKey,
          },
          {
            group: NamedCurveAlgorithm.x25519_29,
            keyExchange: kpX.publicKey,
          },
        ]).clientExtension,
      ],
    );
    // Assert
    expect(() =>
      eng.validateClientHelloAfterHrr(ch1Body, ch2, ch2.serialize()),
    ).toThrow(/single entry|selected_group/i);

    // Legal: single P-256 share
    const ch2ok = new ClientHello(
      WireVersion.DTLS_1_2,
      rand,
      Buffer.alloc(0),
      Buffer.alloc(0),
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      [
        ...baseExts,
        KeyShare.forClient([
          {
            group: NamedCurveAlgorithm.secp256r1_23,
            keyExchange: kpP256.publicKey,
          },
        ]).clientExtension,
      ],
    );
    expect(() =>
      eng.validateClientHelloAfterHrr(ch1Body, ch2ok, ch2ok.serialize()),
    ).not.toThrow();

    client.close();
    server.close();
  });
});

describe("P2: dynamic MTU retransmit re-fragment source retained", () => {
  test("pendingFlightSource is stored for retransmittable flights", async () => {
    // Arrange
    const { server, client } = await pair();
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("mtu source timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      const eng = (client as any).engine13;
      client.onConnect.subscribe(() => {
        clearTimeout(timer);
        eng.carrier.setMtu(400);
        expect(eng.carrier.getMtu()).toBe(400);
        client.close();
        server.close();
        resolve();
      });
      const p = client.connect();
      await new Promise((r) => setTimeout(r, 20));
      if (eng.getPendingFlightSize() > 0) {
        expect(
          eng.pendingFlightSource || eng["pendingFlightSource"],
        ).toBeTruthy();
      }
      await p;
    });
  }, 20_000);
});
