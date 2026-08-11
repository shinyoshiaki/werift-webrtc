import { randomBytes } from "crypto";

import { DirectHandshakeCarrier } from "../../carrier/direct";
import type {
  DtlsHandshakeCarrier,
  DtlsHandshakeDatagram,
} from "../../carrier/types";
import {
  NamedCurveAlgorithm,
  type NamedCurveAlgorithms,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import { SessionType, type SessionTypes } from "../../cipher/suites/abstract";
import { defaultKeySchedule } from "../../cipher/tls13/keySchedule";
import { parseCertAndKey } from "../../cipher/tls13/signature";
import { peerKeyFromAddr } from "../../handshake/extensions/cookie";
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
  supportsVersion,
} from "../../version";
import { HandshakeTranscript } from "./transcript";
import {
  type AddressValidationMode,
  type Dtls13Options,
  EPOCH_KEY_TTL_MS,
  EPOCH_PRUNE_INTERVAL_MS,
  MAX_ACCEPTED_HS_RECORDS,
  MAX_PRE_COOKIE_ATTEMPTS,
  MAX_RETAINED_APP_EPOCHS,
  PRE_COOKIE_ATTEMPT_TTL_MS,
  type Role,
  log,
} from "./types";

/**
 * Full-handshake message order (RFC 8446). Post-handshake KeyUpdate uses
 * `connected` phase. Unexpected types → unexpected_message.
 */
export type HsPhase =
  | "start"
  | "wait_server_hello" // client after CH
  | "wait_ee" // client after SH
  | "wait_cert_or_cr" // client after EE
  | "wait_cert" // client after CR
  | "wait_cv" // client after peer Certificate
  | "wait_finished" // client after CV (or server after client CV)
  | "wait_client_hello" // server start
  | "wait_client_cert" // server after own flight, mutual auth
  | "wait_client_cv"
  | "wait_client_finished"
  | "connected";

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
  /** Handshake carrier (injectable; default DirectHandshakeCarrier). */
  protected readonly carrier: DtlsHandshakeCarrier;
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
   * Cipher suite selected by HRR (client). Final ServerHello must match.
   * RFC 8446 §4.1.4.
   */
  protected hrrCipherSuite?: number;
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
  /**
   * Dual-stack HVR probe: engine stays open with CH-A retransmit while the
   * association also runs the DTLS 1.2 cookie candidate. Not a hard fail.
   */
  protected dualProbeParked = false;
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
  /**
   * Pre-cookie anti-amplification budget owner (peerKey).
   * Unassociated RX resets the global counters for *this* source only — TX
   * charged against that budget must target the same peer (never retransmit
   * A's HRR using B's inflated RX).
   */
  protected antiAmpBudgetPeerKey?: string;
  /** Current peer key (ip:port) for cookie binding / address validation. */
  protected peerKey = "unknown";
  /**
   * After address validation / connect, only this peer may deliver datagrams
   * and all TX is directed here (Epic 1: no CID migration).
   */
  protected pinnedPeerKey?: string;
  /**
   * First *associated* remote 5-tuple (pre-cookie provisional, or post-cookie pin).
   * Server with dtls-cookie: NOT set on the first cookie-less ClientHello —
   * only after cookie verification (return-routability). Until then HRR replies
   * use currentPeerAddr and an unauthenticated source cannot lock the association.
   * Client: set/pinned at connect() to the configured destination.
   */
  protected provisionalPeerKey?: string;
  /**
   * Source of the datagram currently being processed (temporary).
   * Used for cookie binding / reply TX before provisional promotion.
   */
  protected currentPeerKey?: string;
  protected currentPeerAddr?: [string, number];
  protected currentDatagramBytes = 0;
  protected currentDatagramCounted = false;
  /**
   * Where to retransmit the pending flight when peer is not yet pinned
   * (e.g. server HRR with cookie before address validation).
   */
  protected pendingFlightReplyTo?: [string, number];
  /** Explicit send address for transport.send (never rely on last rinfo). */
  protected peerAddr?: [string, number];
  /**
   * Handshake message-order state machine (RFC 8446 full handshake order).
   * Unexpected HandshakeType → unexpected_message.
   */
  protected hsPhase: HsPhase = "start";
  /** ClientHello-offered use_srtp MKI (for RFC 5764 response check). */
  protected clientOfferedSrtpMki = Buffer.alloc(0);
  /** Hash of first ClientHello used when minting the cookie. */
  protected cookieClientHelloHash?: Buffer;
  /**
   * Per-source pre-cookie HRR attempts (CH1 body for optional field checks).
   * Cookie itself is stateless (embeds CH1 message_hash); this map is an
   * optimization and must never be a single global slot shared by all peers.
   */
  protected preCookieAttempts = new Map<
    string,
    {
      ch1Body: Buffer;
      ch1MessageHash: Buffer;
      selectedGroup?: number;
      createdAt: number;
    }
  >();
  /**
   * HRR deltas that ClientHello2 may apply (RFC 8446 §4.1.4).
   * Set when processing / sending HelloRetryRequest.
   */
  protected hrrHadCookie = false;
  protected hrrSelectedGroup?: number;
  /** Extension types offered in the (last accepted) ClientHello — for EE allowlist. */
  protected clientOfferedExtensionTypes = new Set<number>();
  protected readonly addressValidation: AddressValidationMode;
  protected certificateRequestContext = Buffer.alloc(0);
  protected expectClientCertificate = false;
  protected clientCertificateReceived = false;
  protected clientCertificateVerified = false;
  protected peerRequestedClientCert = false;
  /**
   * After CertificateRequest: whether we will present a local certificate
   * (false → empty Certificate decline when schemes/key do not match).
   */
  protected presentClientCertificate = false;
  /**
   * Epoch-3 app data received before markConnected (UDP reorder window).
   * Bounded — see MAX_EARLY_APP_DATA_* in types.ts.
   */
  protected earlyAppData: Buffer[] = [];
  protected earlyAppDataBytes = 0;
  /**
   * Peer close_notify boundary (RFC 9147: ignore app data with larger epoch/seq).
   * Not mere receive-order — UDP may reorder.
   */
  protected peerCloseBoundary?: { epoch: number; sequenceNumber: number };
  /** We have sent close_notify (or fatal alert) on the write path. */
  protected localCloseNotifySent = false;
  /**
   * Source fragments for pending retransmittable flight (pre-chunk) so
   * retransmit can re-fragment under a smaller MTU.
   */
  protected pendingFlightSource?: {
    fragments: import("../../record/message/fragment").FragmentedHandshake[];
    epoch: number;
  };
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
    this.hsPhase =
      this.role === "client" ? "wait_server_hello" : "wait_client_hello";
    this.installEpoch(0, createEpochProtection(0));
    // Injectable carrier for SPED / tests; default wraps transport directly
    this.carrier =
      options.carrier ??
      new DirectHandshakeCarrier(options.transport, {
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

  protected addrToTuple(
    addr?: [string, number] | { address?: string; port?: number } | string,
  ): [string, number] | undefined {
    if (!addr) return undefined;
    if (typeof addr === "string") {
      const i = addr.lastIndexOf(":");
      if (i <= 0) return undefined;
      const port = Number(addr.slice(i + 1));
      if (!Number.isFinite(port)) return undefined;
      return [addr.slice(0, i), port];
    }
    if (Array.isArray(addr)) return [addr[0], addr[1]];
    if (addr.address != null && addr.port != null) {
      return [addr.address, addr.port];
    }
    return undefined;
  }

  /**
   * Bind association to the first *accepted* remote 5-tuple (provisional until pin).
   * Subsequent different sources are dropped (Epic 1: no CID / migration).
   */
  protected lockProvisionalPeer(key: string, addr?: [string, number]): void {
    if (!key || key === "unknown") return;
    if (this.provisionalPeerKey || this.pinnedPeerKey) return;
    this.provisionalPeerKey = key;
    this.peerKey = key;
    if (addr) this.peerAddr = addr;
  }

  /**
   * Promote the temporary source of the current datagram to the association peer.
   * Server dtls-cookie: call only after cookie verification (or when address is
   * already trusted via ice/none) — never on the first cookie-less ClientHello.
   * Client: destination is pinned at connect(); this only accounts anti-amp RX.
   */
  protected acceptAssociationPeer(): void {
    const key =
      this.currentPeerKey && this.currentPeerKey !== "unknown"
        ? this.currentPeerKey
        : this.peerKey;
    const addr = this.currentPeerAddr ?? this.peerAddr;
    if (!key || key === "unknown") {
      this.accountCurrentDatagramForAntiAmp();
      return;
    }
    // Already pinned (e.g. client connect destination): do not rebind to a
    // different source — demux already drops non-expected peers.
    if (this.pinnedPeerKey && this.pinnedPeerKey !== key) {
      return;
    }
    this.lockProvisionalPeer(key, addr);
    // ICE / none: address already trusted — pin on first accepted association
    if (this.addressValidated && !this.pinnedPeerKey) {
      this.pinPeer(key, addr);
    }
    this.accountCurrentDatagramForAntiAmp();
  }

  /**
   * Count the current datagram toward the anti-amplification budget.
   * Unassociated (no provisional/pin): treat this datagram as a fresh
   * unauthenticated exchange — reset counters so attacker B cannot lock
   * budget, and each CH reply is budgeted only against that CH.
   * The budget owner peerKey is recorded so TX/retransmit cannot charge
   * another source's RX against a different destination.
   */
  protected accountCurrentDatagramForAntiAmp(): void {
    if (this.currentDatagramCounted) return;
    if (this.currentDatagramBytes <= 0) return;
    if (!this.provisionalPeerKey && !this.pinnedPeerKey) {
      this.bytesReceived = this.currentDatagramBytes;
      this.bytesSent = 0;
      this.antiAmpBudgetPeerKey =
        this.currentPeerKey && this.currentPeerKey !== "unknown"
          ? this.currentPeerKey
          : undefined;
      this.currentDatagramCounted = true;
      return;
    }
    this.bytesReceived += this.currentDatagramBytes;
    this.currentDatagramCounted = true;
  }

  /**
   * Server with dtls-cookie before address validation: unauthenticated epoch-0
   * semantic errors must not fail()/close the whole association (spoofed-source
   * DoS). ICE/none keep prompt failure.
   */
  protected isPreCookieUnvalidatedServer(): boolean {
    return (
      this.role === "server" &&
      this.addressValidation === "dtls-cookie" &&
      !this.addressValidated
    );
  }

  /**
   * Pre-cookie: outbound bytes may only use budget owned by the destination.
   * Prevents "TX to A, budget from B" after a second source overwrites counters.
   */
  protected antiAmpAllowsSendTo(dest?: [string, number] | undefined): boolean {
    if (
      this.role !== "server" ||
      this.addressValidated ||
      this.addressValidation !== "dtls-cookie"
    ) {
      return true;
    }
    if (!this.antiAmpBudgetPeerKey) {
      // No owner yet (or unknown source) — deny amplification-sensitive TX
      return false;
    }
    const destKey = peerKeyFromAddr(dest);
    if (!destKey || destKey === "unknown") return false;
    return destKey === this.antiAmpBudgetPeerKey;
  }

  protected prunePreCookieAttempts(now = Date.now()): void {
    for (const [k, v] of this.preCookieAttempts) {
      if (now - v.createdAt > PRE_COOKIE_ATTEMPT_TTL_MS) {
        this.preCookieAttempts.delete(k);
      }
    }
    while (this.preCookieAttempts.size > MAX_PRE_COOKIE_ATTEMPTS) {
      // Drop oldest
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.preCookieAttempts) {
        if (v.createdAt < oldestAt) {
          oldestAt = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.preCookieAttempts.delete(oldestKey);
      else break;
    }
  }

  protected storePreCookieAttempt(
    peerKey: string,
    attempt: {
      ch1Body: Buffer;
      ch1MessageHash: Buffer;
      selectedGroup?: number;
    },
  ): void {
    if (!peerKey || peerKey === "unknown") return;
    this.prunePreCookieAttempts();
    this.preCookieAttempts.set(peerKey, {
      ch1Body: Buffer.from(attempt.ch1Body),
      ch1MessageHash: Buffer.from(attempt.ch1MessageHash),
      selectedGroup: attempt.selectedGroup,
      createdAt: Date.now(),
    });
    this.prunePreCookieAttempts();
  }

  protected getPreCookieAttempt(peerKey: string):
    | {
        ch1Body: Buffer;
        ch1MessageHash: Buffer;
        selectedGroup?: number;
        createdAt: number;
      }
    | undefined {
    this.prunePreCookieAttempts();
    return this.preCookieAttempts.get(peerKey);
  }

  protected clearPreCookieAttempts(): void {
    this.preCookieAttempts.clear();
  }

  /** Pin association to a single remote 5-tuple (no migration in Epic 1). */
  protected pinPeer(key: string, addr?: [string, number]): void {
    if (!key || key === "unknown") return;
    this.pinnedPeerKey = key;
    this.provisionalPeerKey = key;
    this.peerKey = key;
    if (addr) this.peerAddr = addr;
    this.pendingFlightReplyTo = undefined;
  }

  /** Expected peer key for inbound demux (pinned preferred, else provisional). */
  protected expectedPeerKey(): string | undefined {
    return this.pinnedPeerKey ?? this.provisionalPeerKey;
  }

  /**
   * Peer key for cookie binding during the current datagram (before or after promote).
   */
  protected associationPeerKey(): string {
    return (
      this.pinnedPeerKey ??
      this.provisionalPeerKey ??
      (this.currentPeerKey && this.currentPeerKey !== "unknown"
        ? this.currentPeerKey
        : this.peerKey)
    );
  }

  /** Address for all outbound datagrams — never depend on last UDP rinfo alone. */
  protected getSendAddr(): [string, number] | undefined {
    // Prefer pinned/provisional peerAddr; pending HRR reply-to; current source
    return this.peerAddr ?? this.pendingFlightReplyTo ?? this.currentPeerAddr;
  }

  protected clearPendingFlight() {
    this.cancelRetransmit?.();
    this.cancelRetransmit = undefined;
    this.pendingFlight = [];
    this.pendingFlightRecords = [];
    this.pendingFlightRecordGroups = [];
    this.pendingFlightRecordBytes = [];
    this.pendingFlightSource = undefined;
    this.pendingServerHello = undefined;
    this.pendingFlightReplyTo = undefined;
    this.retransmitCount = 0;
  }

  /**
   * Tear down the association: pending flights, timers, carrier, optional UDP.
   * Used by local close() and peer close_notify so public lifecycle stays consistent
   * (connected=false, onClose fires).
   */
  protected teardownAssociation(opts?: { closeTransport?: boolean }): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.clearPendingFlight();
    this.clearEarlyAppData();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    this.carrier.close();
    if (opts?.closeTransport !== false) {
      void this.options.transport.close().catch(() => {});
    }
    this.onClose.execute();
  }

  /**
   * Peer close_notify half-close entry (overridden in Dtls13Connection to reply
   * with close_notify before teardown).
   */
  protected onPeerCloseNotify(epoch: number, sequenceNumber: number): void {
    this.peerCloseBoundary = { epoch, sequenceNumber };
    this.clearPendingFlight();
    if (!this.closed && this.connected) {
      this.teardownAssociation();
    }
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
    this.hsPhase = "connected";
    // Pin peer at handshake complete if not already (ICE/none or dual reinject)
    if (this.peerKey !== "unknown") {
      this.pinPeer(this.peerKey, this.peerAddr);
    }
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
    this.earlyAppDataBytes = 0;
  }

  protected clearEarlyAppData() {
    this.earlyAppData = [];
    this.earlyAppDataBytes = 0;
  }

  /**
   * Dual HVR: park for parallel 1.2 cookie probe without killing CH-A retransmit.
   * Returns true when the error was handled as a soft dual probe (not a hard fail).
   */
  protected tryParkDualProbe(err: Error): boolean {
    if (this.role !== "client" || this.closed || this.dualProbeParked) {
      return false;
    }
    const isDualHvr =
      err.name === "DtlsVersionSelected" ||
      (err as { code?: string }).code === "version_selected";
    if (!isDualHvr) return false;
    if (!supportsVersion(this.offeredProtocolVersions, DtlsVersion.V1_2)) {
      return false;
    }
    // Keep pendingFlight + retransmit timers so original CH-A is still RTO'd
    // (RFC 9147: lost HRR/SH is recovered by ClientHello retransmit).
    this.dualProbeParked = true;
    this.connected = false;
    log(
      "dual probe park: keep CH-A retransmit, signal association",
      err.message,
    );
    this.onError.execute(err);
    return true;
  }

  protected fail(err: Error) {
    if (this.closed) return;
    // Dual HVR with 1.2 fallback offered: park rather than tear down CH-A.
    if (this.tryParkDualProbe(err)) return;

    log("fail", err.message);
    // Always stop timers / pending retransmits and refuse further 1.3 RX
    this.clearPendingFlight();
    this.clearEarlyAppData();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    this.closed = true;
    this.connected = false;
    this.dualProbeParked = false;
    this.onError.execute(err);

    // Protocol-version soft fail: keep UDP socket open so association can
    // rebind onData and continue as DTLS 1.2 on the same Transport.
    const softVersion =
      err instanceof ProtocolVersionError ||
      err.name === "ProtocolVersionError" ||
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
