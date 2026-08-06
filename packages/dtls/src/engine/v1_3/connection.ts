import { randomBytes } from "crypto";

import {
  CipherSuite,
  NamedCurveAlgorithm,
  type NamedCurveAlgorithms,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import { prfPreMasterSecret } from "../../cipher/prf";
import { SessionType, type SessionTypes } from "../../cipher/suites/abstract";
import { defaultKeySchedule } from "../../cipher/tls13/keySchedule";
import {
  parseCertAndKey,
  signCertificateVerify,
  verifyCertificateVerify,
} from "../../cipher/tls13/signature";
import {
  createHandshakeDatagram,
  DirectHandshakeCarrier,
} from "../../carrier/direct";
import type { DtlsHandshakeDatagram } from "../../carrier/types";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { KeyShare } from "../../handshake/extensions/keyShare";
import {
  DEFAULT_SIGNATURE_SCHEMES,
  SignatureAlgorithms,
} from "../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { HandshakeType } from "../../handshake/const";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHello } from "../../handshake/message/server/hello";
import { Finished } from "../../handshake/message/finished";
import { Certificate13 } from "../../handshake/message/tls13/certificate";
import { CertificateVerify13 } from "../../handshake/message/tls13/certificateVerify";
import { EncryptedExtensions } from "../../handshake/message/tls13/encryptedExtensions";
import { CertificateRequest13 } from "../../handshake/message/tls13/certificateRequest";
import { KeyUpdate } from "../../handshake/message/tls13/keyUpdate";
import { DtlsAck } from "../../handshake/message/tls13/ack";
import { DtlsRandom } from "../../handshake/random";
import { Alert } from "../../handshake/message/alert";
import {
  CookieExtension,
  mintCookie,
  verifyCookie,
} from "../../handshake/extensions/cookie";
import type { Transport } from "../../imports/common";
import { Event, debug } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import { FragmentedHandshake } from "../../record/message/fragment";
import { AlertDesc, ContentType } from "../../record/const";
import {
  createEpochProtection,
  encryptRecord,
  parseNextRecord,
  serializePlaintextRecord,
  type EpochProtection,
} from "../../record/v1_3/record";
import type { Extension } from "../../typings/domain";
import {
  DTLS_1_3_VERSION,
  DtlsVersion,
  ProtocolVersionError,
  WireVersion,
} from "../../version";
import { HandshakeTranscript } from "./transcript";

/** Anti-amplification: server may send at most 3× received before address validated. */
const ANTI_AMPLIFICATION_FACTOR = 3;

const log = debug("werift-dtls : packages/dtls/src/engine/v1_3/connection.ts");

export type AddressValidationMode =
  | "dtls-cookie"
  | "ice-authenticated"
  | "none";

export interface Dtls13Options {
  transport: Transport;
  cert: string;
  key: string;
  srtpProfiles?: SrtpProfile[];
  certificateRequest?: boolean;
  /** Preferred named groups order */
  groups?: NamedCurveAlgorithms[];
  mtu?: number;
  /**
   * Address validation policy.
   * - dtls-cookie (default): HRR + cookie before amplifying server flight
   * - ice-authenticated / none: skip cookie (peer path already authenticated)
   */
  addressValidation?: AddressValidationMode;
}

type Role = "client" | "server";

const HRR_RANDOM = Buffer.from(
  "CF21AD74E59A6111BE1D8C021E65B891C2A211167ABB8C5E079E09E2C8A8339C",
  "hex",
);

/**
 * Self-contained DTLS 1.3 endpoint (client or server) over direct datagrams.
 * Mutable crypto state is isolated from the DTLS 1.2 engine.
 */
export class Dtls13Connection {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onError = new Event<[Error]>();
  readonly onClose = new Event();

  connected = false;
  private readonly role: Role;
  private readonly carrier: DirectHandshakeCarrier;
  private readonly keySchedule = defaultKeySchedule;
  private readonly certDer: Buffer;
  private readonly keyPem: string;

  private messageSeq = 0;
  private recordSeqEpoch0 = 0;
  private transcript = new HandshakeTranscript();
  private cookie = Buffer.alloc(0);
  private localKeyPair = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  private remoteKeyShare?: { group: number; keyExchange: Buffer };
  private selectedGroup: NamedCurveAlgorithms = NamedCurveAlgorithm.x25519_29;
  private clientRandom = new DtlsRandom();
  private serverRandom = new DtlsRandom();
  private sessionId = Buffer.alloc(0);

  /** Epoch protections: 0 plaintext, 2 handshake, 3 app, 4+ KeyUpdate */
  private epochs = new Map<number, EpochProtection>();
  private readEpoch = 0;
  private writeEpoch = 0;

  private clientHsTraffic?: Buffer;
  private serverHsTraffic?: Buffer;
  private clientAppTraffic?: Buffer;
  private serverAppTraffic?: Buffer;
  private exporterMasterSecret?: Buffer;
  private handshakeSecret?: Buffer;

  private firstClientHelloBody?: Buffer;
  private awaitingHrr = false;
  private peerFinishedReceived = false;
  private localFinishedSent = false;
  private flightId = 0;
  private pendingFlight: DtlsHandshakeDatagram[] = [];
  /** Record numbers of the current retransmittable flight (for ACK matching). */
  private pendingFlightRecords: { epoch: number; sequenceNumber: number }[] =
    [];
  private cancelRetransmit: (() => void) | undefined;
  private retransmitCount = 0;
  private readonly maxRetransmit = 10;
  private closed = false;
  private remoteCert?: Buffer;
  private serverFlightComplete = false;
  private clientExpectsServerFlight = false;
  private negotiatedSrtpProfile?: number;
  private readonly groups: NamedCurveAlgorithms[];
  private fragmentBuffer = new Map<
    string,
    { parts: FragmentedHandshake[]; total: number }
  >();
  /** Records received in current flight awaiting ACK */
  private receivedRecordNumbers: { epoch: number; sequenceNumber: number }[] =
    [];
  private cookieSecret = randomBytes(16);
  private tlsCookie = Buffer.alloc(0);
  private addressValidated = false;
  private bytesReceived = 0;
  private bytesSent = 0;
  private readonly addressValidation: AddressValidationMode;
  private certificateRequestContext = Buffer.alloc(0);
  private expectClientCertificate = false;
  private clientCertificateReceived = false;
  private clientCertificateVerified = false;
  private peerRequestedClientCert = false;

  constructor(
    private readonly options: Dtls13Options,
    sessionType: SessionTypes,
  ) {
    this.role = sessionType === SessionType.CLIENT ? "client" : "server";
    const parsed = parseCertAndKey(options.cert, options.key);
    this.certDer = parsed.certDer;
    this.keyPem = parsed.keyPem;
    this.groups = options.groups ?? [
      NamedCurveAlgorithm.x25519_29,
      NamedCurveAlgorithm.secp256r1_23,
    ];
    this.localKeyPair = generateKeyPair(this.groups[0]);
    this.selectedGroup = this.groups[0];
    this.addressValidation = options.addressValidation ?? "dtls-cookie";
    // ICE-authenticated / none: address already trusted for amplification purposes
    this.addressValidated =
      this.addressValidation === "none" ||
      this.addressValidation === "ice-authenticated";
    this.epochs.set(0, createEpochProtection(0));
    this.carrier = new DirectHandshakeCarrier(options.transport, {
      mtu: options.mtu,
    });
    this.carrier.setInjectHandler((bytes) => this.handleDatagram(bytes));
    options.transport.onData = (data) => this.handleDatagram(data);
  }

  get negotiatedVersion(): DtlsVersion {
    return DtlsVersion.V1_3;
  }

  get remoteCertificate(): Buffer | undefined {
    return this.remoteCert;
  }

  /** Public carrier for tests / SPED integration. */
  get handshakeCarrier(): DirectHandshakeCarrier {
    return this.carrier;
  }

  async connect(): Promise<void> {
    if (this.role !== "client") {
      throw new Error("connect() is client-only");
    }
    await this.sendClientHello();
  }

  private async sendClientHello(hrrGroup?: number): Promise<void> {
    if (hrrGroup) {
      this.selectedGroup = hrrGroup as NamedCurveAlgorithms;
      this.localKeyPair = generateKeyPair(this.selectedGroup);
    }

    const extensions = this.buildClientHelloExtensions();
    const ch = new ClientHello(
      WireVersion.DTLS_1_2, // legacy_version
      this.clientRandom,
      this.sessionId,
      Buffer.alloc(0), // legacy_cookie must be empty in DTLS 1.3
      [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301],
      [0],
      extensions,
    );
    // After HRR, second ClientHello reuses message_seq of first (RFC 9147)
    if (!this.awaitingHrr && this.firstClientHelloBody) {
      // retransmit path — keep messageSeq
    } else if (this.awaitingHrr) {
      // second CH after HRR: same message_seq as first CH (=0)
      this.messageSeq = 0;
    } else {
      this.messageSeq = 0;
    }
    ch.messageSeq = this.messageSeq;

    const body = ch.serialize();
    if (!this.firstClientHelloBody) {
      this.firstClientHelloBody = body;
      this.transcript.add(HandshakeType.client_hello_1, body);
    } else if (this.awaitingHrr) {
      // After HRR, second CH is added after message_hash already set
      this.transcript.add(HandshakeType.client_hello_1, body);
      this.awaitingHrr = false;
    } else {
      // Retransmit: do not re-add to transcript
    }

    const frag = ch.toFragment();
    frag.message_seq = this.messageSeq;
    await this.sendHandshakeFlight([frag], 0, true);
    this.clientExpectsServerFlight = true;
  }

  private buildClientHelloExtensions(): Extension[] {
    const exts: Extension[] = [];

    exts.push(
      SupportedVersions.forClient([DTLS_1_3_VERSION]).clientExtension,
    );

    const curves = EllipticCurves.createEmpty();
    curves.data = this.groups as any;
    exts.push(curves.extension);

    // Only send key share for selected group
    exts.push(
      KeyShare.forClient([
        {
          group: this.selectedGroup,
          keyExchange: this.localKeyPair.publicKey,
        },
      ]).clientExtension,
    );

    exts.push(SignatureAlgorithms.create().extension);

    if (this.tlsCookie.length > 0) {
      exts.push(new CookieExtension(this.tlsCookie).extension);
    }

    if (this.options.srtpProfiles?.length) {
      exts.push(
        UseSRTP.create(this.options.srtpProfiles, Buffer.from([0x00]))
          .extension,
      );
    }

    return exts;
  }

  private handleDatagram = (data: Buffer): void => {
    if (this.closed) return;
    // Process records one-by-one so ServerHello can install epoch-2 keys
    // before coalesced ciphertext in the same UDP datagram (BoringSSL).
    void this.handleDatagramAsync(data);
  };

  private async handleDatagramAsync(data: Buffer): Promise<void> {
    try {
      this.bytesReceived += data.length;
      let offset = 0;
      while (offset < data.length) {
        const rec = parseNextRecord(data.subarray(offset), (low) =>
          this.resolveEpochByLowBits(low),
        );
        if (!rec) break;
        offset += rec.consumed;
        if (rec.kind === "plaintext") {
          await this.onPlaintextRecordAsync(rec);
        } else {
          this.receivedRecordNumbers.push({
            epoch: rec.epoch,
            sequenceNumber: rec.sequenceNumber,
          });
          await this.onCiphertextRecordAsync(rec);
        }
      }
    } catch (e) {
      log("handleDatagram error", e);
      const err = e instanceof Error ? e : new Error(String(e));
      this.onError.execute(err);
    }
  }

  private resolveEpochByLowBits(low: number): EpochProtection | undefined {
    // Epoch is only 2 bits on the wire; prefer newest epoch with read keys.
    let best: EpochProtection | undefined;
    for (const ep of this.epochs.values()) {
      if ((ep.epoch & 0x03) !== low || !ep.readKeys) continue;
      if (!best || ep.epoch > best.epoch) best = ep;
    }
    // Also allow current write epoch when receiving ACK of our flight (same low bits)
    if (!best) {
      for (const ep of this.epochs.values()) {
        if ((ep.epoch & 0x03) === low && (ep.readKeys || ep.writeKeys)) {
          if (!best || ep.epoch > best.epoch) best = ep;
        }
      }
    }
    return best;
  }

  private async onPlaintextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    fragment: Buffer;
  }) {
    if (rec.contentType === ContentType.alert) {
      this.handleAlert(rec.fragment);
      return;
    }
    if (rec.contentType === ContentType.handshake) {
      await this.processHandshakeBytes(rec.fragment, 0);
    }
  }

  private async onCiphertextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    content: Buffer;
  }) {
    switch (rec.contentType) {
      case ContentType.handshake:
        await this.processHandshakeBytes(rec.content, rec.epoch);
        break;
      case ContentType.applicationData:
        this.onData.execute(rec.content);
        break;
      case ContentType.ack:
        this.handleAck(rec.content);
        break;
      case ContentType.alert:
        this.handleAlert(rec.content);
        break;
      default:
        log("unknown content type", rec.contentType);
    }
  }

  private handleAlert(fragment: Buffer) {
    try {
      const alert = Alert.deSerialize(fragment);
      log("alert", alert.level, alert.description);
      if (alert.description === AlertDesc.ProtocolVersion) {
        this.fail(
          new ProtocolVersionError(
            "peer rejected protocol version (alert protocol_version)",
          ),
        );
        return;
      }
      if (alert.level > 1) {
        this.fail(
          new Error(
            `fatal alert ${alert.description} (${AlertDesc[alert.description] ?? "unknown"})`,
          ),
        );
      }
    } catch {
      this.onClose.execute();
    }
  }

  private handleAck(content: Buffer) {
    try {
      const ack = DtlsAck.deSerialize(content);
      log("received ACK", ack.recordNumbers.length);
      if (this.pendingFlightRecords.length === 0) {
        return;
      }
      // Only stop retransmission when ACK covers at least one record of our pending flight
      const matches = ack.recordNumbers.some((rn) =>
        this.pendingFlightRecords.some(
          (p) =>
            p.epoch === rn.epoch && p.sequenceNumber === rn.sequenceNumber,
        ),
      );
      if (!matches) {
        log("ACK ignored: no pending flight records matched");
        return;
      }
      this.cancelRetransmit?.();
      this.cancelRetransmit = undefined;
      this.pendingFlight = [];
      this.pendingFlightRecords = [];
      this.retransmitCount = 0;
    } catch (e) {
      log("bad ACK", e);
    }
  }

  private async processHandshakeBytes(
    raw: Buffer,
    epoch: number,
  ): Promise<void> {
    let offset = 0;
    while (offset < raw.length) {
      if (raw.length - offset < 12) break;
      const hs = FragmentedHandshake.deSerialize(raw.subarray(offset));
      offset += 12 + hs.fragment_length;
      const complete = this.reassemble(hs);
      if (complete) {
        // Await so ServerHello installs keys before next coalesced record
        await this.dispatchHandshake(complete, epoch);
      }
    }
  }

  private reassemble(hs: FragmentedHandshake): FragmentedHandshake | null {
    if (hs.fragment_length === hs.length && hs.fragment_offset === 0) {
      return hs;
    }
    const key = `${hs.msg_type}:${hs.message_seq}:${hs.length}`;
    let entry = this.fragmentBuffer.get(key);
    if (!entry) {
      entry = { parts: [], total: hs.length };
      this.fragmentBuffer.set(key, entry);
    }
    entry.parts.push(hs);
    const covered = new Set<number>();
    for (const p of entry.parts) {
      for (let i = 0; i < p.fragment_length; i++) {
        covered.add(p.fragment_offset + i);
      }
    }
    if (covered.size < hs.length) return null;
    this.fragmentBuffer.delete(key);
    return FragmentedHandshake.assemble(entry.parts);
  }

  private async dispatchHandshake(
    hs: FragmentedHandshake,
    epoch: number,
  ): Promise<void> {
    const body = hs.fragment;
    log(
      this.role,
      "recv handshake",
      hs.msg_type,
      "seq",
      hs.message_seq,
      "epoch",
      epoch,
    );

    switch (hs.msg_type) {
      case HandshakeType.client_hello_1:
        if (this.role === "server") {
          await this.onClientHello(body, hs.message_seq);
        }
        break;
      case HandshakeType.hello_verify_request_3:
        if (this.role === "client") {
          // Peer is speaking DTLS 1.2 cookie exchange — not DTLS 1.3
          throw new ProtocolVersionError(
            "received HelloVerifyRequest: peer appears to be DTLS 1.2-only",
          );
        }
        break;
      case HandshakeType.server_hello_2:
        if (this.role === "client") {
          await this.onServerHello(body, hs.message_seq);
        }
        break;
      case HandshakeType.encrypted_extensions_8:
        if (this.role === "client") {
          this.transcript.add(HandshakeType.encrypted_extensions_8, body);
        }
        break;
      case HandshakeType.certificate_request_13:
        if (this.role === "client") {
          await this.onCertificateRequest(body);
        }
        break;
      case HandshakeType.certificate_11:
        await this.onCertificate(body);
        break;
      case HandshakeType.certificate_verify_15:
        await this.onCertificateVerify(body);
        break;
      case HandshakeType.finished_20:
        await this.onFinished(body, epoch);
        break;
      case HandshakeType.key_update_24:
        this.onKeyUpdate(body);
        break;
      default:
        log("ignored handshake type", hs.msg_type);
    }
  }

  private async onClientHello(
    body: Buffer,
    messageSeq: number,
  ): Promise<void> {
    const ch = ClientHello.deSerialize(body);
    const versionsExt = ch.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!versionsExt) {
      await this.sendProtocolVersionAlert();
      return;
    }
    const sv = SupportedVersions.fromData(versionsExt.data, false);
    if (!sv.versions.includes(DTLS_1_3_VERSION)) {
      await this.sendProtocolVersionAlert();
      return;
    }

    // Address validation via TLS cookie (HRR)
    if (this.addressValidation === "dtls-cookie" && !this.addressValidated) {
      const cookieExt = ch.extensions.find(
        (e) => e.type === CookieExtension.type,
      );
      if (!cookieExt) {
        // First CH without cookie → HRR with cookie
        this.firstClientHelloBody = body;
        this.sessionId = Buffer.from(ch.sessionId);
        await this.sendHelloRetryRequest(undefined, true, body);
        return;
      }
      const cookie = CookieExtension.fromData(cookieExt.data).cookie;
      if (!verifyCookie(this.cookieSecret, cookie)) {
        throw new Error("invalid DTLS cookie");
      }
      this.addressValidated = true;
      this.tlsCookie = Buffer.from(cookie);
    }

    const keyShareExt = ch.extensions.find((e) => e.type === KeyShare.type);
    if (!keyShareExt) {
      throw new Error("ClientHello missing key_share");
    }
    const ks = KeyShare.fromClientData(keyShareExt.data);
    const clientShare = ks.clientShares?.find((s) =>
      this.groups.includes(s.group as NamedCurveAlgorithms),
    );
    if (!clientShare) {
      // Send HRR for first preferred group (may also carry cookie if not validated)
      this.firstClientHelloBody = body;
      this.sessionId = Buffer.from(ch.sessionId);
      await this.sendHelloRetryRequest(this.groups[0], !this.addressValidated, body);
      return;
    }

    this.remoteKeyShare = clientShare;
    this.selectedGroup = clientShare.group as NamedCurveAlgorithms;
    this.localKeyPair = generateKeyPair(this.selectedGroup);
    this.clientRandom = DtlsRandom.from(ch.random as any);
    this.sessionId = Buffer.from(ch.sessionId);
    // Server maintains its own message_seq starting at 0 for ServerHello
    this.messageSeq = -1;

    // use_srtp
    const srtpExt = ch.extensions.find((e) => e.type === UseSRTP.type);
    if (srtpExt && this.options.srtpProfiles?.length) {
      try {
        const use = UseSRTP.fromData(srtpExt.data);
        const match = use.profiles.find((p) =>
          this.options.srtpProfiles!.includes(p as SrtpProfile),
        );
        if (match) this.negotiatedSrtpProfile = match;
      } catch {
        /* ignore */
      }
    }

    // Transcript after HRR: message_hash(CH1) + HRR already set; else fresh CH
    if (this.awaitingHrr && this.firstClientHelloBody) {
      // second CH after HRR — transcript already has message_hash + HRR
      this.transcript.add(HandshakeType.client_hello_1, body);
      this.awaitingHrr = false;
    } else {
      this.transcript = new HandshakeTranscript();
      this.transcript.add(HandshakeType.client_hello_1, body);
    }

    await this.sendServerFlight();
  }

  /**
   * HelloRetryRequest. Optionally includes cookie for address validation
   * and/or selected_group for key_share.
   */
  private async sendHelloRetryRequest(
    group: number | undefined,
    withCookie: boolean,
    clientHelloBody: Buffer,
  ): Promise<void> {
    const hrrRandom = {
      gmt_unix_time: HRR_RANDOM.readUInt32BE(0),
      random_bytes: HRR_RANDOM.subarray(4),
    };
    const extensions: Extension[] = [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
    ];
    if (group !== undefined) {
      extensions.push(KeyShare.forHelloRetryRequest(group).serverExtension);
    }
    if (withCookie) {
      const cookie = mintCookie(this.cookieSecret);
      this.tlsCookie = Buffer.from(cookie);
      extensions.push(new CookieExtension(cookie).extension);
    }
    const hrr = new ServerHello(
      WireVersion.DTLS_1_2,
      hrrRandom,
      this.sessionId,
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      0,
      extensions,
    );
    // Server first message uses message_seq 0
    this.messageSeq = 0;
    hrr.messageSeq = this.messageSeq;

    // Transcript: message_hash(CH1) + HRR
    this.transcript = new HandshakeTranscript();
    this.transcript.replaceWithMessageHash(clientHelloBody);
    const body = hrr.serialize();
    this.transcript.add(HandshakeType.server_hello_2, body);
    this.awaitingHrr = true;
    this.firstClientHelloBody = clientHelloBody;

    const frag = hrr.toFragment();
    frag.message_seq = this.messageSeq;
    await this.sendHandshakeFlight([frag], 0, true);
  }

  private async sendServerFlight(): Promise<void> {
    // ServerHello (plaintext epoch 0)
    this.serverRandom = new DtlsRandom();
    const shExtensions: Extension[] = [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
      KeyShare.forServer({
        group: this.selectedGroup,
        keyExchange: this.localKeyPair.publicKey,
      }).serverExtension,
    ];
    if (
      this.negotiatedSrtpProfile !== undefined &&
      this.options.srtpProfiles?.length
    ) {
      shExtensions.push(
        // use_srtp is in EncryptedExtensions for TLS 1.3, not ServerHello
      );
    }

    const sh = new ServerHello(
      WireVersion.DTLS_1_2,
      this.serverRandom,
      this.sessionId,
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      0,
      shExtensions,
    );
    this.messageSeq += 1;
    sh.messageSeq = this.messageSeq;
    const shBody = sh.serialize();
    this.transcript.add(HandshakeType.server_hello_2, shBody);

    // ECDHE
    const shared = prfPreMasterSecret(
      this.remoteKeyShare!.keyExchange,
      this.localKeyPair.privateKey,
      this.selectedGroup,
    );
    const hsSecrets = this.keySchedule.deriveHandshakeSecrets(
      shared,
      this.transcript.bytes,
    );
    this.handshakeSecret = hsSecrets.handshakeSecret;
    this.clientHsTraffic = hsSecrets.clientHandshakeTrafficSecret;
    this.serverHsTraffic = hsSecrets.serverHandshakeTrafficSecret;

    // Install epoch 2 keys
    const ep2 = createEpochProtection(2);
    ep2.writeKeys = this.keySchedule.trafficKeys(this.serverHsTraffic);
    ep2.readKeys = this.keySchedule.trafficKeys(this.clientHsTraffic);
    this.epochs.set(2, ep2);
    this.writeEpoch = 2;
    this.readEpoch = 2;

    // EncryptedExtensions (may include use_srtp)
    const eeExts: Extension[] = [];
    if (this.negotiatedSrtpProfile !== undefined) {
      eeExts.push(
        UseSRTP.create(
          [this.negotiatedSrtpProfile as SrtpProfile],
          Buffer.from([0x00]),
        ).extension,
      );
    }
    const ee = new EncryptedExtensions(eeExts);
    this.messageSeq += 1;
    ee.messageSeq = this.messageSeq;
    const eeBody = ee.serialize();
    this.transcript.add(HandshakeType.encrypted_extensions_8, eeBody);

    const encFragsList: FragmentedHandshake[] = [];

    // Optional CertificateRequest for mutual auth
    if (this.options.certificateRequest) {
      this.certificateRequestContext = Buffer.from(randomBytes(8));
      this.expectClientCertificate = true;
      const cr = CertificateRequest13.create(this.certificateRequestContext);
      this.messageSeq += 1;
      cr.messageSeq = this.messageSeq;
      this.transcript.add(HandshakeType.certificate_request_13, cr.serialize());
      const crf = cr.toFragment();
      crf.message_seq = cr.messageSeq;
      encFragsList.push(crf);
    }

    // Certificate
    const cert = new Certificate13(Buffer.alloc(0), [this.certDer]);
    this.messageSeq += 1;
    cert.messageSeq = this.messageSeq;
    const certBody = cert.serialize();
    this.transcript.add(HandshakeType.certificate_11, certBody);
    {
      const f = cert.toFragment();
      f.message_seq = cert.messageSeq;
      encFragsList.push(f);
    }

    // CertificateVerify
    const { algorithm, signature } = signCertificateVerify(
      this.keyPem,
      true,
      this.transcript.bytes,
    );
    const cv = new CertificateVerify13(algorithm, signature);
    this.messageSeq += 1;
    cv.messageSeq = this.messageSeq;
    const cvBody = cv.serialize();
    this.transcript.add(HandshakeType.certificate_verify_15, cvBody);
    {
      const f = cv.toFragment();
      f.message_seq = cv.messageSeq;
      encFragsList.push(f);
    }

    // Finished
    const verifyData = this.keySchedule.verifyData(
      this.serverHsTraffic,
      this.transcript.bytes,
    );
    const fin = new Finished(verifyData);
    this.messageSeq += 1;
    fin.messageSeq = this.messageSeq;
    const finBody = fin.serialize();
    this.transcript.add(HandshakeType.finished_20, finBody);
    {
      const f = fin.toFragment();
      f.message_seq = fin.messageSeq;
      encFragsList.push(f);
    }

    // EncryptedExtensions fragment first
    {
      const f = ee.toFragment();
      f.message_seq = ee.messageSeq!;
      encFragsList.unshift(f);
    }

    // Derive application secrets after server Finished is in transcript
    const appSecrets = this.keySchedule.deriveApplicationSecrets(
      this.handshakeSecret!,
      this.transcript.bytes,
    );
    this.clientAppTraffic = appSecrets.clientApplicationTrafficSecret;
    this.serverAppTraffic = appSecrets.serverApplicationTrafficSecret;
    this.exporterMasterSecret = appSecrets.exporterMasterSecret;

    // Epoch 3 write keys for server (application); read still handshake until client Finished
    const ep3 = createEpochProtection(3);
    ep3.writeKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
    // read keys for app installed after client Finished
    this.epochs.set(3, ep3);

    // Send ServerHello in epoch 0, then encrypted messages in epoch 2
    const shFrag = sh.toFragment();
    shFrag.message_seq = sh.messageSeq!;
    await this.sendHandshakeFlight([shFrag], 0, false);

    await this.sendHandshakeFlight(encFragsList, 2, true);
    this.localFinishedSent = true;
    this.serverFlightComplete = true;
    // Server can send early app data on epoch 3 after its Finished (WARP); optional
    this.writeEpoch = 3;
  }

  private async onServerHello(
    body: Buffer,
    messageSeq: number,
  ): Promise<void> {
    const sh = ServerHello.deSerialize(body);
    this.messageSeq = messageSeq;

    // Detect HRR by random
    const randomBuf = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
        return b;
      })(),
      sh.random.random_bytes,
    ]);
    const isHrr = randomBuf.equals(HRR_RANDOM);

    const versionsExt = sh.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!versionsExt) {
      throw new ProtocolVersionError("ServerHello missing supported_versions");
    }
    const selected = SupportedVersions.fromData(versionsExt.data, true)
      .selected!;
    if (selected !== DTLS_1_3_VERSION) {
      throw new ProtocolVersionError(
        `server selected unsupported version 0x${selected.toString(16)}`,
      );
    }

    if (isHrr) {
      const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
      const group = ksExt
        ? KeyShare.fromServerData(ksExt.data).selectedGroup
        : undefined;
      const cookieExt = sh.extensions.find(
        (e) => e.type === CookieExtension.type,
      );
      if (cookieExt) {
        this.tlsCookie = Buffer.from(
          CookieExtension.fromData(cookieExt.data).cookie,
        );
      }
      // Transcript: replace first CH with message_hash, add HRR
      if (this.firstClientHelloBody) {
        this.transcript = new HandshakeTranscript();
        this.transcript.replaceWithMessageHash(this.firstClientHelloBody);
      }
      this.transcript.add(HandshakeType.server_hello_2, body);
      this.awaitingHrr = true;
      await this.sendClientHello(group);
      return;
    }

    if (sh.cipherSuite !== CipherSuite.TLS_AES_128_GCM_SHA256_0x1301) {
      throw new Error(`unsupported cipher suite 0x${sh.cipherSuite.toString(16)}`);
    }

    const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
    if (!ksExt) throw new Error("ServerHello missing key_share");
    const serverShare = KeyShare.fromServerData(ksExt.data).serverShare!;
    this.remoteKeyShare = serverShare;
    this.selectedGroup = serverShare.group as NamedCurveAlgorithms;
    this.serverRandom = DtlsRandom.from(sh.random as any);
    // Client continues its own message_seq after ClientHello (0)
    // messageSeq currently reflects last received server seq; keep local counter for sends
    if (this.messageSeq < 0) this.messageSeq = 0;

    this.transcript.add(HandshakeType.server_hello_2, body);

    const shared = prfPreMasterSecret(
      serverShare.keyExchange,
      this.localKeyPair.privateKey,
      this.selectedGroup,
    );
    const hsSecrets = this.keySchedule.deriveHandshakeSecrets(
      shared,
      this.transcript.bytes,
    );
    this.handshakeSecret = hsSecrets.handshakeSecret;
    this.clientHsTraffic = hsSecrets.clientHandshakeTrafficSecret;
    this.serverHsTraffic = hsSecrets.serverHandshakeTrafficSecret;

    const ep2 = createEpochProtection(2);
    ep2.writeKeys = this.keySchedule.trafficKeys(this.clientHsTraffic);
    ep2.readKeys = this.keySchedule.trafficKeys(this.serverHsTraffic);
    this.epochs.set(2, ep2);
    this.readEpoch = 2;
    this.writeEpoch = 2;
    this.clientExpectsServerFlight = true;
  }

  private async onCertificateRequest(body: Buffer): Promise<void> {
    const cr = CertificateRequest13.deSerialize(body);
    this.certificateRequestContext = Buffer.from(
      cr.certificateRequestContext,
    );
    this.peerRequestedClientCert = true;
    this.transcript.add(HandshakeType.certificate_request_13, body);
  }

  private async onCertificate(body: Buffer): Promise<void> {
    const cert = Certificate13.deSerialize(body);
    // Empty certificate list is allowed for optional client auth decline;
    // we require a cert when we requested one.
    if (this.role === "server" && this.expectClientCertificate) {
      if (!cert.certificates.length) {
        throw new Error("client Certificate required but empty list received");
      }
      this.remoteCert = cert.certificates[0];
      this.clientCertificateReceived = true;
      this.transcript.add(HandshakeType.certificate_11, body);
      return;
    }
    if (!cert.certificates.length) {
      throw new Error("empty certificate list");
    }
    this.remoteCert = cert.certificates[0];
    this.transcript.add(HandshakeType.certificate_11, body);
  }

  private async onCertificateVerify(body: Buffer): Promise<void> {
    if (!this.remoteCert) throw new Error("CertificateVerify without Certificate");
    const cv = CertificateVerify13.deSerialize(body);
    // Client only verifies server CertificateVerify; server verifies client CV for mutual auth
    const peerIsServer = this.role === "client";
    const ok = verifyCertificateVerify(
      this.remoteCert,
      cv.algorithm,
      cv.signature,
      peerIsServer,
      this.transcript.bytes,
    );
    if (!ok) {
      throw new Error("CertificateVerify signature verification failed");
    }
    this.transcript.add(HandshakeType.certificate_verify_15, body);
    if (this.role === "server" && this.expectClientCertificate) {
      this.clientCertificateVerified = true;
    }
  }

  private async onFinished(body: Buffer, epoch: number): Promise<void> {
    const fin = Finished.deSerialize(body);
    if (this.role === "client") {
      // Verify server Finished
      const expected = this.keySchedule.verifyData(
        this.serverHsTraffic!,
        this.transcript.bytes,
      );
      if (!fin.verifyData.equals(expected)) {
        throw new Error("server Finished verify_data mismatch");
      }
      this.transcript.add(HandshakeType.finished_20, body);
      this.peerFinishedReceived = true;

      const appSecrets = this.keySchedule.deriveApplicationSecrets(
        this.handshakeSecret!,
        this.transcript.bytes,
      );
      this.clientAppTraffic = appSecrets.clientApplicationTrafficSecret;
      this.serverAppTraffic = appSecrets.serverApplicationTrafficSecret;
      this.exporterMasterSecret = appSecrets.exporterMasterSecret;

      const ep3 = createEpochProtection(3);
      ep3.writeKeys = this.keySchedule.trafficKeys(this.clientAppTraffic);
      ep3.readKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
      this.epochs.set(3, ep3);

      // Optional client Certificate + CertificateVerify for mutual auth
      const clientMsgs: FragmentedHandshake[] = [];
      if (this.peerRequestedClientCert) {
        const cCert = new Certificate13(this.certificateRequestContext, [
          this.certDer,
        ]);
        this.messageSeq += 1;
        cCert.messageSeq = this.messageSeq;
        this.transcript.add(
          HandshakeType.certificate_11,
          cCert.serialize(),
        );
        const cFrag = cCert.toFragment();
        cFrag.message_seq = cCert.messageSeq;
        clientMsgs.push(cFrag);

        const { algorithm, signature } = signCertificateVerify(
          this.keyPem,
          false,
          this.transcript.bytes,
        );
        const cCv = new CertificateVerify13(algorithm, signature);
        this.messageSeq += 1;
        cCv.messageSeq = this.messageSeq;
        this.transcript.add(
          HandshakeType.certificate_verify_15,
          cCv.serialize(),
        );
        const cvFrag = cCv.toFragment();
        cvFrag.message_seq = cCv.messageSeq;
        clientMsgs.push(cvFrag);
      }

      // Send client Finished
      const clientVd = this.keySchedule.verifyData(
        this.clientHsTraffic!,
        this.transcript.bytes,
      );
      const clientFin = new Finished(clientVd);
      this.messageSeq += 1;
      clientFin.messageSeq = this.messageSeq;
      const cfBody = clientFin.serialize();
      this.transcript.add(HandshakeType.finished_20, cfBody);

      const frag = clientFin.toFragment();
      frag.message_seq = clientFin.messageSeq;
      clientMsgs.push(frag);
      await this.sendHandshakeFlight(clientMsgs, 2, false);

      // Send ACK for server flight
      await this.sendAck();

      this.writeEpoch = 3;
      this.readEpoch = 3;
      this.localFinishedSent = true;
      this.connected = true;
      this.cancelRetransmit?.();
      this.carrier.events.onHandshakeComplete?.();
      this.carrier.cancelAllTimers();
      this.onConnect.execute();
      log("client connected");
    } else {
      // Server receives client Finished — require mutual auth if requested
      if (this.expectClientCertificate) {
        if (!this.clientCertificateReceived || !this.clientCertificateVerified) {
          throw new Error(
            "client Finished before Certificate/CertificateVerify (mutual auth)",
          );
        }
      }
      const expected = this.keySchedule.verifyData(
        this.clientHsTraffic!,
        this.transcript.bytes,
      );
      if (!fin.verifyData.equals(expected)) {
        throw new Error("client Finished verify_data mismatch");
      }
      this.transcript.add(HandshakeType.finished_20, body);
      this.peerFinishedReceived = true;

      // Install app read keys
      const ep3 = this.epochs.get(3)!;
      ep3.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic!);
      this.readEpoch = 3;
      this.writeEpoch = 3;

      await this.sendAck();

      this.connected = true;
      this.cancelRetransmit?.();
      this.carrier.events.onHandshakeComplete?.();
      this.carrier.cancelAllTimers();
      this.onConnect.execute();
      log("server connected");
    }
  }

  private onKeyUpdate(body: Buffer) {
    const ku = KeyUpdate.deSerialize(body);
    // Peer sent KeyUpdate with its old write keys; after processing, update our read keys.
    if (this.role === "client") {
      this.serverAppTraffic = this.keySchedule.updateTrafficSecret(
        this.serverAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
      // Retain current write keys on the read epoch entry for demux convenience
      const prevWrite = this.epochs.get(this.writeEpoch);
      if (prevWrite?.writeKeys) {
        // write stays on writeEpoch; only advance read
      }
      this.epochs.set(nextEpoch, ep);
      // Keep write keys available under writeEpoch; copy read onto write epoch too
      const writeEp = this.epochs.get(this.writeEpoch);
      if (writeEp) writeEp.readKeys = ep.readKeys;
      this.readEpoch = nextEpoch;
    } else {
      this.clientAppTraffic = this.keySchedule.updateTrafficSecret(
        this.clientAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic);
      this.epochs.set(nextEpoch, ep);
      const writeEp = this.epochs.get(this.writeEpoch);
      if (writeEp) writeEp.readKeys = ep.readKeys;
      this.readEpoch = nextEpoch;
    }
    if (ku.requestUpdate) {
      this.keyUpdate(false).catch((e) => this.fail(e));
    }
  }

  /** Next application epoch after KeyUpdate (skip reserved epoch 1). */
  private nextAppEpoch(current: number): number {
    let n = current + 1;
    if (n === 1) n = 2;
    return n;
  }

  async keyUpdate(requestUpdate = false): Promise<void> {
    if (!this.connected) throw new Error("not connected");
    // RFC 8446: send KeyUpdate with current keys, then update sending keys.
    const sendEpoch = this.writeEpoch;
    const ku = new KeyUpdate(requestUpdate);
    this.messageSeq += 1;
    ku.messageSeq = this.messageSeq;
    const frag = ku.toFragment();
    frag.message_seq = ku.messageSeq;
    await this.sendHandshakeFlight([frag], sendEpoch, false);

    if (this.role === "client") {
      this.clientAppTraffic = this.keySchedule.updateTrafficSecret(
        this.clientAppTraffic!,
      );
    } else {
      this.serverAppTraffic = this.keySchedule.updateTrafficSecret(
        this.serverAppTraffic!,
      );
    }
    const nextEpoch = this.nextAppEpoch(this.writeEpoch);
    const ep = createEpochProtection(nextEpoch);
    const traffic =
      this.role === "client" ? this.clientAppTraffic! : this.serverAppTraffic!;
    ep.writeKeys = this.keySchedule.trafficKeys(traffic);
    const prevRead = this.epochs.get(this.readEpoch);
    ep.readKeys = prevRead?.readKeys;
    this.epochs.set(nextEpoch, ep);
    this.writeEpoch = nextEpoch;
  }

  private async sendAck(): Promise<void> {
    if (this.receivedRecordNumbers.length === 0) {
      // empty ACK is allowed
      const ack = new DtlsAck([]);
      const ep = this.epochs.get(this.writeEpoch) ?? this.epochs.get(2);
      if (!ep?.writeKeys) return;
      const record = encryptRecord(ack.serialize(), ContentType.ack, ep);
      await this.carrier.send(
        createHandshakeDatagram(record, this.flightId, 0, false),
      );
      return;
    }
    const ack = new DtlsAck([...this.receivedRecordNumbers]);
    this.receivedRecordNumbers = [];
    const ep =
      this.epochs.get(this.writeEpoch) ??
      this.epochs.get(2) ??
      this.epochs.get(3);
    if (!ep?.writeKeys) return;
    const record = encryptRecord(ack.serialize(), ContentType.ack, ep);
    await this.options.transport.send(record);
  }

  private async sendHandshakeFlight(
    fragments: FragmentedHandshake[],
    epoch: number,
    retransmittable: boolean,
  ): Promise<void> {
    this.flightId += 1;
    const flightId = this.flightId;
    const mtu = this.carrier.getMtu();
    // handshake overhead: 13 header + 12 hs header + AEAD tag for encrypted
    const maxFrag =
      epoch === 0
        ? mtu - 13 - 12
        : mtu - 5 - 12 - 16; // unified header ~5 + tag

    const packets: Buffer[] = [];
    const recordNumbers: { epoch: number; sequenceNumber: number }[] = [];
    for (const f of fragments) {
      const chunks =
        f.fragment.length > maxFrag ? f.chunk(maxFrag) : [f];
      for (const chunk of chunks) {
        const hsBytes = chunk.serialize();
        if (epoch === 0) {
          const seq = this.recordSeqEpoch0++;
          recordNumbers.push({ epoch: 0, sequenceNumber: seq });
          packets.push(
            serializePlaintextRecord(
              ContentType.handshake,
              0,
              seq,
              hsBytes,
            ),
          );
        } else {
          const ep = this.epochs.get(epoch);
          if (!ep?.writeKeys) {
            throw new Error(`no write keys for epoch ${epoch}`);
          }
          const seq = ep.writeSequence;
          recordNumbers.push({ epoch, sequenceNumber: seq });
          packets.push(
            encryptRecord(hsBytes, ContentType.handshake, ep),
          );
        }
      }
    }

    // Coalesce into datagrams under MTU
    const datagrams: Buffer[] = [];
    let current: Buffer = Buffer.alloc(0);
    for (const p of packets) {
      if (current.length + p.length > mtu && current.length > 0) {
        datagrams.push(current);
        current = Buffer.from(p);
      } else {
        current = current.length
          ? Buffer.concat([current, p])
          : Buffer.from(p);
      }
    }
    if (current.length) datagrams.push(current);

    // Anti-amplification: cap outbound before address validation (server)
    if (
      this.role === "server" &&
      !this.addressValidated &&
      this.addressValidation === "dtls-cookie"
    ) {
      const budget =
        ANTI_AMPLIFICATION_FACTOR * this.bytesReceived - this.bytesSent;
      let allowed = Math.max(0, budget);
      const limited: Buffer[] = [];
      for (const d of datagrams) {
        if (d.length > allowed) break;
        limited.push(d);
        allowed -= d.length;
      }
      if (limited.length === 0 && datagrams.length > 0) {
        // Still send HRR-sized first datagram if possible (cookie exchange must proceed)
        if (datagrams[0].length <= mtu) {
          limited.push(datagrams[0]);
        } else {
          throw new Error("anti-amplification: cannot send flight");
        }
      }
      datagrams.length = 0;
      datagrams.push(...limited);
    }

    const flightPackets = datagrams.map((bytes, i) =>
      createHandshakeDatagram(bytes, flightId, i, retransmittable),
    );
    this.carrier.events.onFlightCreated?.(flightId, flightPackets);

    if (retransmittable) {
      this.pendingFlight = flightPackets;
      this.pendingFlightRecords = recordNumbers;
      this.retransmitCount = 0;
      this.scheduleRetransmit();
    }

    for (const pkt of flightPackets) {
      this.bytesSent += pkt.bytes.length;
      await this.carrier.send(pkt);
    }
  }

  private scheduleRetransmit() {
    this.cancelRetransmit?.();
    if (this.pendingFlight.length === 0 || this.connected) return;
    const rto = Math.min(1000 * (1 + this.retransmitCount / 2), 5000);
    this.cancelRetransmit = this.carrier.schedule(rto, () => {
      this.retransmitCount++;
      if (this.retransmitCount > this.maxRetransmit) {
        this.fail(new Error("DTLS 1.3 handshake retransmission exhausted"));
        return;
      }
      log("retransmit flight", this.flightId, this.retransmitCount);
      Promise.all(this.pendingFlight.map((p) => this.carrier.send(p))).catch(
        (e) => this.fail(e),
      );
      this.scheduleRetransmit();
    });
  }

  private async sendProtocolVersionAlert(): Promise<void> {
    // alert level fatal(2), description protocol_version(70)
    const alert = Buffer.from([2, AlertDesc.ProtocolVersion]);
    const seq = this.recordSeqEpoch0++;
    const record = serializePlaintextRecord(
      ContentType.alert,
      0,
      seq,
      alert,
    );
    await this.options.transport.send(record);
    this.fail(
      new ProtocolVersionError(
        "no overlapping DTLS 1.3 protocol version with peer",
      ),
    );
  }

  async send(buf: Buffer): Promise<void> {
    if (!this.connected && this.writeEpoch < 3) {
      throw new Error("DTLS 1.3 not ready to send application data");
    }
    const ep = this.epochs.get(this.writeEpoch);
    if (!ep?.writeKeys) throw new Error("no application write keys");
    const record = encryptRecord(buf, ContentType.applicationData, ep);
    await this.options.transport.send(record);
  }

  exportKeyingMaterial(label: string, length: number): Buffer {
    if (!this.exporterMasterSecret) {
      throw new Error("exporter not available");
    }
    return this.keySchedule.exportKeyingMaterial(
      this.exporterMasterSecret,
      label,
      Buffer.alloc(0),
      length,
    );
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
    const keyingMaterial = this.exportKeyingMaterial(
      "EXTRACTOR-dtls_srtp",
      keyLength * 2 + saltLength * 2,
    );
    const clientKey = keyingMaterial.subarray(0, keyLength);
    const serverKey = keyingMaterial.subarray(keyLength, keyLength * 2);
    const clientSalt = keyingMaterial.subarray(
      keyLength * 2,
      keyLength * 2 + saltLength,
    );
    const serverSalt = keyingMaterial.subarray(
      keyLength * 2 + saltLength,
    );
    if (this.role === "client") {
      return {
        localKey: clientKey,
        localSalt: clientSalt,
        remoteKey: serverKey,
        remoteSalt: serverSalt,
      };
    }
    return {
      localKey: serverKey,
      localSalt: serverSalt,
      remoteKey: clientKey,
      remoteSalt: clientSalt,
    };
  }

  close() {
    this.closed = true;
    this.cancelRetransmit?.();
    this.carrier.close();
    void this.options.transport.close().catch(() => {});
    this.onClose.execute();
  }

  private fail(err: Error) {
    if (this.closed) return;
    log("fail", err.message);
    this.cancelRetransmit?.();
    this.carrier.cancelAllTimers();
    this.onError.execute(err);
  }
}
