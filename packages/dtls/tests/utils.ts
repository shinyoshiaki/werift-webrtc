import { createPublicKey, verify } from "crypto";
import type { Address, Transport } from "../../common/src";
import { DtlsServer } from "../src";
import {
  CipherSuite,
  CurveType,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
  signatures,
} from "../src/cipher/const";
import { CipherContext } from "../src/context/cipher";
import { HandshakeType } from "../src/handshake/const";
import { EllipticCurves } from "../src/handshake/extensions/ellipticCurves";
import { Signature } from "../src/handshake/extensions/signature";
import { ClientHello } from "../src/handshake/message/client/hello";
import { ServerKeyExchange } from "../src/handshake/message/server/keyExchange";
import type { DtlsRandom } from "../src/handshake/random";
import { FragmentedHandshake } from "../src/record/message/fragment";
import { parsePacket } from "../src/record/receive";

/**Transport that records every sent datagram instead of using a real socket */
export class RecordingTransport implements Transport {
  type = "recording";
  address = { address: "127.0.0.1", port: 0, family: "IPv4" } as any;
  closed = false;
  sent: Buffer[] = [];
  onData: (data: Buffer, addr: Address) => void = () => {};

  send = async (data: Buffer) => {
    this.sent.push(data);
  };

  close = async () => {
    this.closed = true;
  };
}

/**DtlsServer with a freshly generated ECDSA (P-256 / SHA-256) certificate */
export const createEcdsaDtlsServer = async () => {
  const transport = new RecordingTransport();
  const { certPem, keyPem, signatureHash } =
    await CipherContext.createSelfSignedCertificateWithKey(
      { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.ecdsa_3 },
      NamedCurveAlgorithm.secp256r1_23,
    );
  const server = new DtlsServer({
    transport,
    cert: certPem,
    key: keyPem,
    signatureHash,
  });
  return { server, transport, certPem };
};

/**ClientHello handshake as a DTLS client would send it in flight 1 / 3 */
export const createClientHelloHandshake = ({
  random,
  cookie = Buffer.alloc(0),
}: {
  random: DtlsRandom;
  cookie?: Buffer;
}) => {
  const curves = EllipticCurves.createEmpty();
  curves.data = [NamedCurveAlgorithm.secp256r1_23];
  const signature = Signature.createEmpty();
  signature.data = signatures;

  const hello = new ClientHello(
    { major: 255 - 1, minor: 255 - 2 },
    random,
    Buffer.alloc(0),
    cookie,
    [CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195],
    [0], // don't compress
    [curves.extension, signature.extension],
  );
  return hello.toFragment();
};

/**extract ServerKeyExchange from datagrams sent by the server */
export const findServerKeyExchange = (datagrams: Buffer[]) => {
  for (const datagram of datagrams) {
    for (const packet of parsePacket(datagram)) {
      const handshake = FragmentedHandshake.deSerialize(packet.fragment);
      if (handshake.msg_type === HandshakeType.server_key_exchange_12) {
        return ServerKeyExchange.deSerialize(handshake.fragment);
      }
    }
  }
};

/**verify the ServerKeyExchange signature (RFC 4492 5.4) with given randoms */
export const verifyServerKeyExchangeSignature = ({
  certPem,
  keyExchange,
  clientRandom,
  serverRandom,
}: {
  certPem: string;
  keyExchange: ServerKeyExchange;
  clientRandom: DtlsRandom;
  serverRandom: DtlsRandom;
}) => {
  const serverParams = Buffer.alloc(4);
  serverParams.writeUInt8(CurveType.named_curve_3, 0);
  serverParams.writeUInt16BE(keyExchange.namedCurve, 1);
  serverParams.writeUInt8(keyExchange.publicKey.length, 3);
  const data = Buffer.concat([
    clientRandom.serialize(),
    serverRandom.serialize(),
    serverParams,
    keyExchange.publicKey,
  ]);
  return verify(
    "sha256",
    data,
    createPublicKey(certPem),
    keyExchange.signature,
  );
};

/** PEM の各行をインデントした文字列（インデント付きテンプレートリテラル相当）を作る。 */
export const indentPem = (pem: string, indent = "    ") =>
  pem
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
