import { expect, test } from "vitest";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { CipherSuite } from "../../src/cipher/const";
import { SupportedVersions } from "../../src/handshake/extensions/supportedVersions";
import { ServerHello } from "../../src/handshake/message/server/hello";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { DtlsRandom } from "../../src/handshake/random";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { DTLS_1_3_VERSION, WireVersion } from "../../src/version";
import { certPem, keyPem } from "../fixture";

function buildDtls13ServerHello(): Buffer {
  const hello = new ServerHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
    0,
    [SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension],
  );
  hello.messageSeq = 0;
  const fragment = hello.toFragment();
  fragment.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    fragment.serialize(),
  );
}

function buildHelloVerifyRequest(cookie = Buffer.alloc(16, 0xab)): Buffer {
  const hvr = new ServerHelloVerifyRequest(WireVersion.DTLS_1_2, cookie);
  hvr.messageSeq = 0;
  const fragment = hvr.toFragment();
  fragment.message_seq = 0;
  return serializePlaintextRecord(
    ContentType.handshake,
    0,
    0,
    fragment.serialize(),
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("dual probing setup timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("e2e/dual: stale generation の ServerHello は DTLS 1.3 を commit しない", async () => {
  // Arrange: dual client が実際に ClientHello を送信し、HVR 後に
  // 1.3 候補を park して association probing へ遷移する。
  const transport = await UdpTransport.init("udp4");
  const peer: [string, number] = ["127.0.0.1", 9];
  transport.rinfo = { address: peer[0], port: peer[1] };
  const client = new DtlsClient({
    transport,
    cert: certPem,
    key: keyPem,
    signatureHash: {
      hash: HashAlgorithm.sha256_4,
      signature: SignatureAlgorithm.rsa_1,
    },
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    addressValidation: "none",
  });
  let expectedGeneration = 7;
  let firstClientHello = true;
  transport.send = async () => {
    if (firstClientHello) {
      firstClientHello = false;
      // Act: 最初の ClientHello に対する HVR だけを実際の association
      // dispatcher へ返し、その後の cookie ClientHello は送信しない。
      queueMicrotask(() => {
        (client as any).udpOnMessage(buildHelloVerifyRequest(), peer, {
          rxGeneration: expectedGeneration,
        });
      });
    }
  };
  client.setExpectedRxGeneration(() => expectedGeneration);

  const connectPromise = client.connect().catch(() => undefined);
  try {
    await waitUntil(
      () =>
        client.dualAssociationPhase === "probing" &&
        (client as any).engine13 === undefined,
    );
    const associationGeneration = (client as any).associationGen;
    expectedGeneration = 8;

    // Act: version selection 前に generation 7 の ServerHello を
    // association dispatcher へ渡す。
    (client as any).udpOnMessage(buildDtls13ServerHello(), ["127.0.0.1", 9], {
      rxGeneration: 7,
    });

    // Assert: 旧世代の version、association generation、terminal state は
    // 変化せず、DTLS 1.3 engine も生成されない。
    expect((client as any).dualPhase).toBe("probing");
    expect((client as any).associationGen).toBe(associationGeneration);
    expect((client as any).engine13).toBeUndefined();
    expect(client.connected).toBe(false);
    expect((client as any).associationTornDown).toBe(false);
  } finally {
    client.close();
    await transport.close();
    await connectPromise;
  }
});
