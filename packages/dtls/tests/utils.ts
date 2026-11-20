import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "crypto";
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
import { DtlsRandom } from "../src/handshake/random";
import { createPlaintext } from "../src/record/builder";
import { ContentType } from "../src/record/const";
import { FragmentedHandshake } from "../src/record/message/fragment";
import { DtlsPlaintext } from "../src/record/message/plaintext";
import type { HandshakeReassembler } from "../src/record/message/reassembler";
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
  extraExtensions = [],
}: {
  random: DtlsRandom;
  cookie?: Buffer;
  /** appended after the default extensions (e.g. a large key_share) */
  extraExtensions?: { type: number; data: Buffer }[];
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
    [curves.extension, signature.extension, ...extraExtensions],
  );
  return hello.toFragment();
};

/**
 * ClientHello as large as Chrome's post-quantum one (an X25519MLKEM768
 * key_share is 1,216 bytes of public key): over 1,200 bytes, so it must be
 * fragmented. The key share bytes are random, so a missing range cannot be
 * mistaken for zero-filled data.
 */
export const createLargeClientHelloHandshake = ({
  random,
  cookie,
  keyShareLength = 1216,
}: {
  random: DtlsRandom;
  cookie?: Buffer;
  keyShareLength?: number;
}) =>
  createClientHelloHandshake({
    random,
    cookie,
    // key_share (RFC 8446 §4.2.8) の形だけを真似た未知の拡張として送る
    extraExtensions: [{ type: 51, data: randomBytes(keyShareLength) }],
  });

/** Fragments of `handshake` (fragment_length <= `size`) picked in `order` (indexes). */
export const fragmentHandshake = (
  handshake: FragmentedHandshake,
  size: number,
  order?: number[],
) => {
  const fragments = handshake.chunk(size);
  return order ? order.map((i) => fragments[i]) : fragments;
};

/** One handshake fragment cut at an arbitrary `[start, end)` of `handshake`. */
export const sliceHandshake = (
  handshake: FragmentedHandshake,
  start: number,
  end: number,
  fragment = handshake.fragment.subarray(start, end),
) =>
  new FragmentedHandshake(
    handshake.msg_type,
    handshake.length,
    handshake.message_seq,
    start,
    end - start,
    Buffer.from(fragment),
  );

/**
 * A fragment that leaves message `message_seq` (of `length` bytes) partial:
 * only its first byte. Each call advances `clock` by 1 ms, so the messages
 * are updated in call order.
 */
export const createPartialFragment = (
  clock: { now: number },
  message_seq: number,
  length: number,
) => {
  clock.now++;
  return new FragmentedHandshake(
    HandshakeType.certificate_11,
    length,
    message_seq,
    0,
    1,
    Buffer.alloc(1),
  );
};

/** Add every fragment to `reassembler` and return each add() result. */
export const addAllFragments = (
  reassembler: HandshakeReassembler,
  fragments: FragmentedHandshake[],
  epoch = 0,
) => fragments.map((fragment) => reassembler.add(fragment, epoch));

/**
 * DtlsServer that has received only the middle fragment of a large
 * ClientHello, so its reassembler holds one partial message.
 */
export const createServerWithPartialHandshake = async () => {
  const { server, transport } = await createEcdsaDtlsServer();
  const hello = createLargeClientHelloHandshake({ random: new DtlsRandom() });
  const [, middle] = fragmentHandshake(hello, Math.ceil(hello.length / 3));
  transport.onData(
    createHandshakeRecord(middle, { sequenceNumber: 0 }),
    undefined as any,
  );
  const reassembler = (server as any).reassembler as HandshakeReassembler;
  return { server, transport, reassembler, hello };
};

/** A plaintext handshake record (one datagram) carrying `fragment`. */
export const createHandshakeRecord = (
  fragment: FragmentedHandshake,
  {
    epoch = 0,
    sequenceNumber = 0,
  }: { epoch?: number; sequenceNumber?: number } = {},
) => {
  const raw = fragment.serialize();
  return new DtlsPlaintext(
    {
      contentType: ContentType.handshake,
      protocolVersion: { major: 255 - 1, minor: 255 - 2 },
      epoch,
      sequenceNumber,
      contentLen: raw.length,
    },
    raw,
  ).serialize();
};

/** Handshake messages (msg_type) of the plaintext records in `datagrams`. */
export const sentHandshakeTypes = (datagrams: Buffer[]) =>
  datagrams.flatMap((datagram) =>
    parsePacket(datagram)
      .filter(
        (packet) =>
          packet.recordLayerHeader.contentType === ContentType.handshake &&
          packet.recordLayerHeader.epoch === 0,
      )
      .map(
        (packet) => FragmentedHandshake.deSerialize(packet.fragment).msg_type,
      ),
  );

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
  /**
   * Network impairment: rewrites one sent datagram into the datagrams the
   * peer receives (none = loss, several = re-fragmentation / duplication).
   * Datagrams sent in the same tick are then delivered together.
   */
  impair?: (data: Buffer, index: number) => Buffer[];
  /** With {@link impair}: deliver the datagrams of one tick in reverse order. */
  reverseOrder = false;
  onData: (data: Buffer, addr: Address) => void = () => {};
  private impairedCount = 0;
  private pending?: Buffer[];

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
      if (this.impair) {
        this.deliverImpaired(peer, this.impair(data, this.impairedCount++));
        return;
      }
      setImmediate(() => {
        if (!peer.closed) peer.onData(data, this.address);
      });
    }
  };

  private deliverImpaired(peer: PairedTransport, datagrams: Buffer[]) {
    if (this.pending) {
      this.pending.push(...datagrams);
      return;
    }
    this.pending = [...datagrams];
    setImmediate(() => {
      const batch = this.pending ?? [];
      this.pending = undefined;
      if (this.reverseOrder) batch.reverse();
      for (const datagram of batch) {
        if (peer.closed) return;
        peer.onData(datagram, this.address);
      }
    });
  }

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

/**
 * {@link PairedTransport.impair} that re-fragments every unfragmented
 * plaintext (epoch 0) handshake message into fragments of at most
 * `maxFragmentLength` bytes, one record per datagram, as a peer with a small
 * MTU would send them. `firstFragmentLast` delivers each message's
 * offset-0 fragment after its other fragments (the fragment ending the
 * message then arrives while the start is still missing). `duplicate`
 * repeats every fragment; `dropOnce` loses the first fragment it matches,
 * to force a retransmission.
 */
export const createRefragmentingImpairment = ({
  maxFragmentLength,
  firstFragmentLast = false,
  duplicate = false,
  dropOnce,
}: {
  maxFragmentLength: number;
  firstFragmentLast?: boolean;
  duplicate?: boolean;
  dropOnce?: (fragment: FragmentedHandshake) => boolean;
}) => {
  let dropped = false;
  return (data: Buffer): Buffer[] =>
    parsePacket(data).flatMap((packet) => {
      const { contentType, epoch, sequenceNumber } = packet.recordLayerHeader;
      if (contentType !== ContentType.handshake || epoch !== 0) {
        return [packet.serialize()];
      }
      const handshakes: FragmentedHandshake[] = [];
      for (let start = 0; start < packet.fragment.length; ) {
        const handshake = FragmentedHandshake.deSerialize(
          packet.fragment.subarray(start),
        );
        handshakes.push(handshake);
        start += 12 + handshake.fragment_length;
      }
      return handshakes
        .flatMap((handshake) => {
          if (handshake.fragment_length !== handshake.length) {
            return [handshake];
          }
          const [first, ...rest] = handshake.chunk(maxFragmentLength);
          return firstFragmentLast ? [...rest, first] : [first, ...rest];
        })
        .filter((fragment) => {
          if (!dropped && dropOnce?.(fragment)) {
            dropped = true;
            return false;
          }
          return true;
        })
        .flatMap((fragment) => {
          const record = createHandshakeRecord(fragment, {
            epoch,
            sequenceNumber,
          });
          return duplicate ? [record, record] : [record];
        });
    });
};
