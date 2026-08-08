import { randomBytes } from "crypto";

import { DirectHandshakeCarrier } from "../../carrier/direct";
import type { DtlsHandshakeDatagram } from "../../carrier/types";
import {
  NamedCurveAlgorithm,
  type NamedCurveAlgorithms,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import { SessionType, type SessionTypes } from "../../cipher/suites/abstract";
import { defaultKeySchedule } from "../../cipher/tls13/keySchedule";
import { parseCertAndKey } from "../../cipher/tls13/signature";
import { DEFAULT_SIGNATURE_SCHEMES } from "../../handshake/extensions/signatureAlgorithms";
import type { AckRecordNumber } from "../../handshake/message/tls13/ack";
import { DtlsRandom } from "../../handshake/random";
import { Event } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import type { FragmentedHandshake } from "../../record/message/fragment";
import {
  type EpochProtection,
  createEpochProtection,
} from "../../record/v1_3/record";
import {
  DtlsVersion,
  ProtocolVersionError,
  normalizeProtocolVersions,
} from "../../version";
import { HandshakeTranscript } from "./transcript";
import {
  type AddressValidationMode,
  type Dtls13Options,
  EPOCH_KEY_TTL_MS,
  EPOCH_PRUNE_INTERVAL_MS,
  MAX_ACCEPTED_HS_RECORDS,
  MAX_RETAINED_APP_EPOCHS,
  type Role,
  log,
} from "./types";

/**
 * Shared mutable state and lifecycle for the DTLS 1.3 endpoint.
 * Layer 0 in the flight stack (see index.ts Figure 3).
 */
export abstract class Dtls13ConnectionBase {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onError = new Event<[Error]>();
  readonly onClose = new Event();

  connected = false;
  protected readonly role: Role;
  protected readonly carrier: DirectHandshakeCarrier;
  protected readonly keySchedule = defaultKeySchedule;
  protected readonly certDer: Buffer;
  protected readonly keyPem: string;
  protected readonly hasLocalIdentity: boolean;

  protected messageSeq = 0;
  protected recordSeqEpoch0 = 0;
  protected transcript = new HandshakeTranscript();
  protected cookie = Buffer.alloc(0);
  protected localKeyPair = generateKeyPair(NamedCurveAlgorithm.x25519_29);
  protected remoteKeyShare?: { group: number; keyExchange: Buffer };
  protected selectedGroup: NamedCurveAlgorithms = NamedCurveAlgorithm.x25519_29;
  protected clientRandom = new DtlsRandom();
  protected serverRandom = new DtlsRandom();
  protected sessionId = Buffer.alloc(0);

  /** Epoch protections: 0 plaintext, 2 handshake, 3 app, 4+ KeyUpdate */
  protected epochs = new Map<number, EpochProtection>();
  /** When each epoch's keys were installed (for TTL prune). */
  protected epochInstalledAt = new Map<number, number>();
  protected readEpoch = 0;
  protected writeEpoch = 0;

  protected clientHsTraffic?: Buffer;
  protected serverHsTraffic?: Buffer;
  protected clientAppTraffic?: Buffer;
  protected serverAppTraffic?: Buffer;
  protected exporterMasterSecret?: Buffer;
  protected handshakeSecret?: Buffer;

  protected firstClientHelloBody?: Buffer;
  protected awaitingHrr = false;
  /** Number of HelloRetryRequests processed (client) or sent (server). Max 1. */
  protected hrrCount = 0;
  /**
   * Groups offered in the first ClientHello key_share (client).
   * HRR selected_group must not already appear here (RFC 8446 §4.1.4).
   */
  protected initialKeyShareGroups: number[] = [];
  /**
   * Versions listed in ClientHello supported_versions (preference order).
   * Dual-stack association may include V1_2 for true negotiation.
   */
  protected readonly offeredProtocolVersions: DtlsVersion[];
  /**
   * Peer signature_algorithms from ClientHello (server) or CertificateRequest
   * schemes we will use for client CertificateVerify selection.
   */
  protected peerSignatureSchemes: number[] = [...DEFAULT_SIGNATURE_SCHEMES];
  /** Schemes we advertised in CertificateRequest (server mutual auth). */
  protected certificateRequestSignatureSchemes: number[] = [
    ...DEFAULT_SIGNATURE_SCHEMES,
  ];
  /** Schemes we advertise in ClientHello / accept for server CertificateVerify. */
  protected localOfferedSignatureSchemes: number[] = [
    ...DEFAULT_SIGNATURE_SCHEMES,
  ];
  protected peerFinishedReceived = false;
  protected localFinishedSent = false;
  protected flightId = 0;
  protected pendingFlight: DtlsHandshakeDatagram[] = [];
  /** Record numbers of the current retransmittable flight (for ACK matching). */
  protected pendingFlightRecords: AckRecordNumber[] = [];
  /**
   * Per-datagram record map for selective retransmit after partial ACK.
   * Index aligns with pendingFlight.
   */
  protected pendingFlightRecordGroups: AckRecordNumber[][] = [];
  /**
   * Wire bytes for each pending handshake record (parallel to pendingFlightRecords).
   * Enables selective retransmit of only un-ACK'd records after partial ACK.
   */
  protected pendingFlightRecordBytes: Buffer[] = [];
  /**
   * ServerHello (epoch 0) retransmitted with the encrypted server flight until
   * the flight is fully ACK'd (SH loss otherwise leaves client without keys).
   */
  protected pendingServerHello?: DtlsHandshakeDatagram;
  protected cancelRetransmit: (() => void) | undefined;
  protected cancelEpochPrune: (() => void) | undefined;
  protected retransmitCount = 0;
  protected readonly maxRetransmit = 10;
  protected closed = false;
  protected remoteCert?: Buffer;
  protected serverFlightComplete = false;
  protected clientExpectsServerFlight = false;
  protected negotiatedSrtpProfile?: number;
  /**
   * Named Groups (RFC 8446 §4.2.7 Supported Groups; DTLS 1.3 inherits via RFC 9147).
   * Each value identifies a finite-field or elliptic-curve group used for (EC)DHE
   * key exchange. Preference order drives ClientHello key_share offers and the
   * server's HRR selected_group when the client's share is unacceptable.
   */
  protected readonly groups: NamedCurveAlgorithms[];
  protected fragmentBuffer = new Map<
    string,
    {
      parts: FragmentedHandshake[];
      total: number;
      createdAt: number;
      coveredBytes: number;
    }
  >();
  protected fragmentBufferBytes = 0;
  /** Out-of-order complete handshake messages (by message_seq). */
  protected handshakeInbox = new Map<number, FragmentedHandshake>();
  protected nextReceiveSeq = 0;
  /**
   * Handshake records of the *current remote inbound flight* awaiting ACK
   * (RFC 9147 §7: ACK lists only the current outstanding remote flight).
   */
  protected receivedRecordNumbers: { epoch: number; sequenceNumber: number }[] =
    [];
  /**
   * After we send a local flight, the next successfully accepted peer handshake
   * record starts a new remote flight — clear the previous ACK list then.
   */
  protected clearRemoteAckOnNextInbound = false;
  /**
   * Set by handlers (e.g. onFinished / onKeyUpdate) so the RX layer sends ACK
   * only after the current record has been noted for ACK bookkeeping.
   */
  protected ackAfterCurrentRecord = false;
  /**
   * When peer KeyUpdate has request_update, send our KeyUpdate only after we
   * have ACKed theirs (response KeyUpdate is not an implicit ACK — RFC 9147 §8).
   */
  protected keyUpdateResponseAfterAck = false;
  /**
   * Peer requested update while our own KeyUpdate is still awaiting ACK.
   * Send response KeyUpdate only after applyPendingKeyUpdateWrite() (RFC 9147 §8:
   * no concurrent un-ACKed KeyUpdates; TLS 1.3 crossed update_requested case).
   */
  protected deferredKeyUpdateResponse = false;
  /**
   * Handshake records that were successfully accepted (processed or buffered).
   * Replay path re-ACKs only records present here — anti-replay alone does not
   * imply the peer may treat the record as acknowledged.
   */
  protected acceptedHandshakeRecords = new Set<string>();
  /**
   * After sending KeyUpdate, hold next write epoch until peer ACK (RFC 9147 §8).
   * Application data continues on the old writeEpoch until this is applied.
   */
  protected pendingKeyUpdateWrite?: {
    nextWriteEpoch: number;
    nextTrafficSecret: Buffer;
  };
  protected cookieSecret = randomBytes(16);
  protected tlsCookie = Buffer.alloc(0);
  protected addressValidated = false;
  protected bytesReceived = 0;
  protected bytesSent = 0;
  /** Last peer key (ip:port) for cookie binding / address validation. */
  protected peerKey = "unknown";
  /** Hash of first ClientHello used when minting the cookie. */
  protected cookieClientHelloHash?: Buffer;
  protected readonly addressValidation: AddressValidationMode;
  protected certificateRequestContext = Buffer.alloc(0);
  protected expectClientCertificate = false;
  protected clientCertificateReceived = false;
  protected clientCertificateVerified = false;
  protected peerRequestedClientCert = false;
  /** App data received before handshake marked connected (epoch 3 early data). */
  protected earlyAppData: Buffer[] = [];
  /** Serialize datagram handling to avoid races on keys / message_seq inbox. */
  protected rxChain: Promise<void> = Promise.resolve();

  constructor(
    protected readonly options: Dtls13Options,
    sessionType: SessionTypes,
  ) {
    this.role = sessionType === SessionType.CLIENT ? "client" : "server";
    if (this.role === "server") {
      if (!options.cert || !options.key) {
        throw new Error("DTLS 1.3 server requires cert and key options");
      }
      const parsed = parseCertAndKey(options.cert, options.key);
      this.certDer = parsed.certDer;
      this.keyPem = parsed.keyPem;
      this.hasLocalIdentity = true;
    } else if (options.cert && options.key) {
      const parsed = parseCertAndKey(options.cert, options.key);
      this.certDer = parsed.certDer;
      this.keyPem = parsed.keyPem;
      this.hasLocalIdentity = true;
    } else {
      // Server-auth-only client: no local certificate until CertificateRequest
      this.certDer = Buffer.alloc(0);
      this.keyPem = "";
      this.hasLocalIdentity = false;
    }
    this.groups = options.groups ?? [
      NamedCurveAlgorithm.x25519_29,
      NamedCurveAlgorithm.secp256r1_23,
    ];
    this.localKeyPair = generateKeyPair(this.groups[0]);
    this.selectedGroup = this.groups[0];
    this.offeredProtocolVersions = normalizeProtocolVersions(
      options.offeredProtocolVersions ?? [DtlsVersion.V1_3],
    );
    // Client key_share initially offers the preferred local group only
    this.initialKeyShareGroups = [this.selectedGroup];
    this.addressValidation = options.addressValidation ?? "dtls-cookie";
    // ICE-authenticated / none: address already trusted for amplification purposes
    this.addressValidated =
      this.addressValidation === "none" ||
      this.addressValidation === "ice-authenticated";
    this.installEpoch(0, createEpochProtection(0));
    this.carrier = new DirectHandshakeCarrier(options.transport, {
      mtu: options.mtu,
    });
    // Inject may carry peer from dual-engine reinject; fall back to transport.rinfo
    const self = this as this & {
      handleDatagram: (data: Buffer, addr?: any) => void;
      scheduleRetransmit: () => void;
    };
    this.carrier.setInjectHandler((bytes, peer) =>
      self.handleDatagram(bytes, peer),
    );
    options.transport.onData = (data, addr) =>
      self.handleDatagram(data, addr as [string, number] | undefined);
    // external → internal: resume retransmission timer for pending flight
    this.carrier.events.onRetransmissionModeChange = (mode) => {
      if (mode === "external") {
        this.cancelRetransmit?.();
        this.cancelRetransmit = undefined;
      } else if (
        mode === "internal" &&
        this.pendingFlight.length > 0 &&
        !this.closed
      ) {
        self.scheduleRetransmit();
      }
    };
    // Timer-driven epoch TTL prune so idle connections still drop old keys
    this.scheduleEpochPrune();
  }

  /**
   * Periodic prune so idle connections expire old epoch keys without new traffic.
   * Uses a dedicated timer (not carrier.schedule) so handshake-complete
   * cancelAllTimers() does not stop TTL expiry after connect.
   */
  protected scheduleEpochPrune(): void {
    this.cancelEpochPrune?.();
    if (this.closed) return;
    const id = setInterval(() => {
      if (this.closed) {
        clearInterval(id);
        return;
      }
      this.pruneStaleEpochs();
    }, EPOCH_PRUNE_INTERVAL_MS);
    // Unref so tests / process exit are not blocked by the idle prune timer
    if (typeof (id as NodeJS.Timeout).unref === "function") {
      (id as NodeJS.Timeout).unref();
    }
    this.cancelEpochPrune = () => {
      clearInterval(id);
      this.cancelEpochPrune = undefined;
    };
  }

  protected installEpoch(epoch: number, ep: EpochProtection): void {
    this.epochs.set(epoch, ep);
    this.epochInstalledAt.set(epoch, Date.now());
    this.pruneStaleEpochs();
  }

  protected handshakeRecordKey(epoch: number, sequenceNumber: number): string {
    return `${epoch}:${sequenceNumber}`;
  }

  /** Remember a successfully accepted handshake record for future re-ACK on replay. */
  protected markHandshakeRecordAccepted(
    epoch: number,
    sequenceNumber: number,
  ): void {
    const key = this.handshakeRecordKey(epoch, sequenceNumber);
    this.acceptedHandshakeRecords.add(key);
    // Bound memory: drop oldest-ish by re-creating from recent received list
    if (this.acceptedHandshakeRecords.size > MAX_ACCEPTED_HS_RECORDS) {
      const keys = [...this.acceptedHandshakeRecords];
      this.acceptedHandshakeRecords = new Set(
        keys.slice(-MAX_ACCEPTED_HS_RECORDS),
      );
    }
  }

  protected wasHandshakeRecordAccepted(
    epoch: number,
    sequenceNumber: number,
  ): boolean {
    return this.acceptedHandshakeRecords.has(
      this.handshakeRecordKey(epoch, sequenceNumber),
    );
  }

  protected zeroizeTrafficKeys(keys?: {
    key: Buffer;
    iv: Buffer;
    snKey: Buffer;
  }): void {
    if (!keys) return;
    keys.key.fill(0);
    keys.iv.fill(0);
    keys.snKey.fill(0);
  }

  /**
   * Drop expired / excess epochs. Active read/write are never dropped.
   * Handshake epochs 0/2 and initial app epoch 3 are retained until connected
   * (or still active); after that they follow TTL like KeyUpdate epochs.
   */
  protected pruneStaleEpochs(): void {
    const now = Date.now();
    const active = new Set([this.readEpoch, this.writeEpoch]);
    if (this.pendingKeyUpdateWrite) {
      active.add(this.pendingKeyUpdateWrite.nextWriteEpoch);
    }
    if (!this.connected) {
      active.add(0);
      active.add(2);
      active.add(3);
    }
    for (const [e, installedAt] of [...this.epochInstalledAt.entries()]) {
      if (active.has(e)) continue;
      if (now - installedAt <= EPOCH_KEY_TTL_MS) continue;
      this.dropEpoch(e);
    }
    // Cap retained non-active app/handshake epochs (includes stale epoch 3)
    const idle = [...this.epochs.keys()]
      .filter((e) => !active.has(e))
      .sort(
        (a, b) =>
          (this.epochInstalledAt.get(a) ?? 0) -
          (this.epochInstalledAt.get(b) ?? 0),
      );
    while (idle.length > MAX_RETAINED_APP_EPOCHS) {
      const e = idle.shift()!;
      this.dropEpoch(e);
    }
  }

  protected dropEpoch(e: number): void {
    const ep = this.epochs.get(e);
    if (ep) {
      this.zeroizeTrafficKeys(ep.readKeys);
      this.zeroizeTrafficKeys(ep.writeKeys);
      ep.readKeys = undefined;
      ep.writeKeys = undefined;
    }
    this.epochs.delete(e);
    this.epochInstalledAt.delete(e);
  }

  /**
   * Last UDP peer from transport (UdpTransport.rinfo), used when inject/onData
   * omits the address so cookie binding still sees a stable peerKey.
   */
  protected peerFromTransport():
    | [string, number]
    | { address?: string; port?: number }
    | undefined {
    const t = this.options.transport as {
      rinfo?: { address?: string; port?: number };
    };
    const r = t.rinfo;
    if (r?.address != null && r?.port != null) {
      return [r.address, r.port];
    }
    return r;
  }

  protected clearPendingFlight() {
    this.cancelRetransmit?.();
    this.cancelRetransmit = undefined;
    this.pendingFlight = [];
    this.pendingFlightRecords = [];
    this.pendingFlightRecordGroups = [];
    this.pendingFlightRecordBytes = [];
    this.pendingServerHello = undefined;
    this.retransmitCount = 0;
  }

  /** Drop pending remote-flight ACK record numbers. */
  protected clearAckAccumulator() {
    this.receivedRecordNumbers = [];
  }

  protected applyPendingKeyUpdateWrite() {
    if (!this.pendingKeyUpdateWrite) return;
    const { nextWriteEpoch, nextTrafficSecret } = this.pendingKeyUpdateWrite;
    if (this.role === "client") {
      this.clientAppTraffic = nextTrafficSecret;
    } else {
      this.serverAppTraffic = nextTrafficSecret;
    }
    this.writeEpoch = nextWriteEpoch;
    this.pendingKeyUpdateWrite = undefined;
    this.pruneStaleEpochs();
    log("KeyUpdate write epoch advanced after ACK", nextWriteEpoch);
  }

  protected markConnected(opts?: { keepPendingFlight?: boolean }) {
    this.connected = true;
    if (!opts?.keepPendingFlight) {
      this.clearPendingFlight();
      this.carrier.cancelAllTimers();
    }
    this.carrier.events.onHandshakeComplete?.();
    this.onConnect.execute();
    // Flush app data that arrived early due to reorder
    for (const buf of this.earlyAppData) {
      this.onData.execute(buf);
    }
    this.earlyAppData = [];
  }

  protected fail(err: Error) {
    if (this.closed) return;
    log("fail", err.message);
    // Always stop timers / pending retransmits and refuse further 1.3 RX
    this.clearPendingFlight();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    this.closed = true;
    this.onError.execute(err);

    // Protocol-version soft fail / dual version selection: keep UDP socket open
    // so association can rebind onData and continue as DTLS 1.2 on the same Transport.
    const softVersion =
      err instanceof ProtocolVersionError ||
      err.name === "ProtocolVersionError" ||
      err.name === "DtlsVersionSelected" ||
      (err as { code?: string }).code === "version_selected";
    if (softVersion) {
      return;
    }

    // Hard fail: tear down carrier + transport
    this.carrier.close();
    void this.options.transport.close().catch(() => {});
    this.onClose.execute();
  }
  get negotiatedVersion(): DtlsVersion {
    return DtlsVersion.V1_3;
  }

  get remoteCertificate(): Buffer | undefined {
    return this.remoteCert;
  }

  /** Negotiated SRTP profile from use_srtp (EncryptedExtensions / ClientHello). */
  get srtpProfile(): SrtpProfile | undefined {
    return this.negotiatedSrtpProfile as SrtpProfile | undefined;
  }

  /**
   * Package-internal: reinject a datagram (dual-engine association).
   * Not a stable Public API — Epic 2 may re-export a carrier interface.
   */
  injectDatagram(
    bytes: Buffer,
    peer?: [string, number] | { address?: string; port?: number } | string,
  ): void {
    this.carrier.inject(bytes, peer);
  }
}
