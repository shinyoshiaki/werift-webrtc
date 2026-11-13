import { createPublicKey, generateKeyPairSync, verify } from "crypto";
import type { Address, Transport } from "../../common/src";
import { type DtlsAlert, DtlsClient, DtlsServer } from "../src";
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
import { Alert } from "../src/handshake/message/alert";
import { ClientHello } from "../src/handshake/message/client/hello";
import { ServerKeyExchange } from "../src/handshake/message/server/keyExchange";
import type { DtlsRandom } from "../src/handshake/random";
import { createPlaintext } from "../src/record/builder";
import { ContentType } from "../src/record/const";
import { FragmentedHandshake } from "../src/record/message/fragment";
import { DtlsPlaintext } from "../src/record/message/plaintext";
import { parsePacket } from "../src/record/receive";
import type { Options } from "../src/socket";
import { certPem, keyPem } from "./fixture";

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

/** 証明書生成テスト用の鍵ペアを作る（ECDSA は P-256、RSA は 2048 bit）。 */
export const createCertificateKeyPair = (type: "ec" | "rsa") =>
  type === "ec"
    ? generateKeyPairSync("ec", { namedCurve: "P-256" })
    : generateKeyPairSync("rsa", { modulusLength: 2048 });

/**
 * In-memory transport connected to a peer transport. Every sent datagram is
 * recorded and delivered to the peer asynchronously (like UDP) unless the
 * peer is closed. `sendBehavior` lets a test make sending hang or fail.
 */
export class PairedTransport implements Transport {
  type = "paired";
  address = { address: "127.0.0.1", port: 0, family: "IPv4" } as any;
  closed = false;
  closeCount = 0;
  sent: Buffer[] = [];
  peer?: PairedTransport;
  sendBehavior: "deliver" | "hang" | "reject" = "deliver";
  onData: (data: Buffer, addr: Address) => void = () => {};

  send = async (data: Buffer) => {
    this.sent.push(data);
    if (this.sendBehavior === "hang") {
      return new Promise<void>(() => {});
    }
    if (this.sendBehavior === "reject") {
      throw new Error("send failed");
    }
    const peer = this.peer;
    if (!this.closed && peer && !peer.closed) {
      setImmediate(() => {
        if (!peer.closed) peer.onData(data, this.address);
      });
    }
  };

  close = async () => {
    this.closed = true;
    this.closeCount++;
  };
}

/** DtlsClient / DtlsServer pair over {@link PairedTransport} (RSA fixture certificate). */
export const createDtlsPair = ({
  client: clientOptions = {},
  server: serverOptions = {},
}: {
  client?: Partial<Options>;
  server?: Partial<Options>;
} = {}) => {
  const clientTransport = new PairedTransport();
  const serverTransport = new PairedTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  const signatureHash = {
    hash: HashAlgorithm.sha256_4,
    signature: SignatureAlgorithm.rsa_1,
  };
  const server = new DtlsServer({
    transport: serverTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    ...serverOptions,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    cert: certPem,
    key: keyPem,
    signatureHash,
    ...clientOptions,
  });
  return { client, server, clientTransport, serverTransport };
};

/** Connect a pair made by {@link createDtlsPair} and wait until both sides are connected. */
export const connectDtlsPair = async (
  pair: ReturnType<typeof createDtlsPair>,
) => {
  const connected = Promise.all([
    pair.client.onConnect.asPromise(),
    pair.server.onConnect.asPromise(),
  ]);
  await pair.client.connect();
  await connected;
};

/** Record-layer view (content type / epoch / fragment) of sent datagrams. */
export const sentRecords = (datagrams: Buffer[]) =>
  datagrams.flatMap((datagram) =>
    parsePacket(datagram).map((packet) => ({
      contentType: packet.recordLayerHeader.contentType,
      epoch: packet.recordLayerHeader.epoch,
      sequenceNumber: packet.recordLayerHeader.sequenceNumber,
      fragment: packet.fragment,
    })),
  );

/**
 * One alert record carrying several alerts (RFC 5246 §6.2.1 lets a record
 * hold several messages of one content type), protected the way `sender`
 * protects its own alerts: plaintext at epoch 0, encrypted with the current
 * epoch after ChangeCipherSpec.
 */
export const createMultiAlertRecord = (
  sender: DtlsClient | DtlsServer,
  alerts: DtlsAlert[],
) => {
  const [packet] = createPlaintext(sender.dtls)(
    [
      {
        type: ContentType.alert,
        fragment: Buffer.concat(
          alerts.map((a) => new Alert(a.level, a.description).serialize()),
        ),
      },
    ],
    ++sender.dtls.recordSequenceNumber,
  );
  return sender.dtls.epoch > 0
    ? sender.cipher.encryptPacket(packet).serialize()
    : packet.serialize();
};

/**
 * A plaintext epoch-0 handshake record (as it would be injected on the path
 * after the handshake): `fragment` is a serialized FragmentedHandshake.
 */
export const createEpoch0HandshakeRecord = (
  sender: DtlsClient | DtlsServer,
  fragment: Buffer,
) =>
  new DtlsPlaintext(
    {
      contentType: ContentType.handshake,
      protocolVersion: sender.dtls.version,
      epoch: 0,
      sequenceNumber: 1000,
      contentLen: fragment.length,
    },
    fragment,
  ).serialize();
