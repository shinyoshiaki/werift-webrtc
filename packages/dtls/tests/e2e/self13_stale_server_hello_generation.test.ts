import { expect, test } from "vitest";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsVersion } from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { CipherSuite } from "../../src/cipher/const";
import { SupportedVersions } from "../../src/handshake/extensions/supportedVersions";
import { ServerHello } from "../../src/handshake/message/server/hello";
import { DtlsRandom } from "../../src/handshake/random";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { WireVersion } from "../../src/version";
import { certPem, keyPem } from "../fixture";

function buildDtls13ServerHello(): Buffer {
  const hello = new ServerHello(
    WireVersion.DTLS_1_2,
    new DtlsRandom(),
    Buffer.alloc(0),
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
    0,
    [SupportedVersions.forServer(0x0304).serverExtension],
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

test("e2e/dual: stale generation の ServerHello は DTLS 1.3 を commit しない", async () => {
  // Arrange: dual dispatcher が probing 中に旧世代の 1.3 ServerHello を受ける。
  const transport = await UdpTransport.init("udp4");
  const client = new DtlsClient({
    transport,
    cert: certPem,
    key: keyPem,
    signatureHash: {
      hash: HashAlgorithm.sha256_4,
      signature: SignatureAlgorithm.rsa_1,
    },
    protocolVersions: [DtlsVersion.V1_2],
  });
  const generation = 7;
  client.setExpectedRxGeneration(() => generation);
  (client as any).dualPhase = "probing";
  const associationGeneration = (client as any).associationGen;

  try {
    // Act: generation 6 の ServerHello を実際の association dispatcher へ渡す。
    (client as any).udpOnMessage(buildDtls13ServerHello(), ["127.0.0.1", 9], {
      rxGeneration: generation - 1,
    });

    // Assert: version、association generation、terminal state は変化しない。
    expect((client as any).dualPhase).toBe("probing");
    expect((client as any).associationGen).toBe(associationGeneration);
    expect((client as any).engine13).toBeUndefined();
    expect(client.connected).toBe(false);
    expect((client as any).associationTornDown).toBe(false);
  } finally {
    client.close();
    await transport.close();
  }
});
