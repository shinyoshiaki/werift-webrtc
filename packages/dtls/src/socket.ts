import { setImmediate, setTimeout } from "timers/promises";
import {
  classifyAlert,
  createAlertRecord,
  type DtlsAlert,
  DtlsAlertError,
} from "./alert";
import type { DtlsHandshakeCarrier } from "./carrier/types";
import {
  NamedCurveAlgorithmList,
  type NamedCurveAlgorithms,
  type SignatureHash,
  signatures,
} from "./cipher/const";
import { exportKeyingMaterial } from "./cipher/prf";
import { SessionType, type SessionTypes } from "./cipher/suites/abstract";
import { CipherContext } from "./context/cipher";
import { DtlsContext } from "./context/dtls";
import { SrtpContext } from "./context/srtp";
import { TransportContext } from "./context/transport";
import type { Dtls13Connection } from "./engine/v1_3/connection";
import { peerKeyFromAddr } from "./handshake/extensions/cookie";
import { EllipticCurves } from "./handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "./handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "./handshake/extensions/renegotiationIndication";
import { Signature } from "./handshake/extensions/signature";
import { UseSRTP } from "./handshake/extensions/useSrtp";
import type { Address, Transport } from "./imports/common";
import { binaryData, debug, Event, EventDisposer } from "./imports/common";
import type { SrtpProfile } from "./imports/rtp";
import {
  associationHasPeerAuth,
  normalizeLoopbackHost,
  normalizePeerTuple,
  type PeerIdentityMode,
  resolvePeerIdentityMode,
} from "./peer";
import { createPlaintext } from "./record/builder";
import {
  AlertDesc,
  AlertLevel,
  alertDescName,
  ContentType,
} from "./record/const";
import { FragmentedHandshake } from "./record/message/fragment";
import { parsePacket, parsePlainText } from "./record/receive";
import type { Extension } from "./typings/domain";
import {
  DtlsVersion,
  normalizeProtocolVersions,
  ProtocolVersionError,
} from "./version";

export type { PeerIdentityMode } from "./peer";

const { decode, types } = binaryData;

const log = debug("werift-dtls : packages/dtls/src/socket.ts : log");
const err = debug("werift-dtls : packages/dtls/src/socket.ts : err");

export class DtlsSocket {
  /** Default upper bound (ms) for waiting until an alert has been sent. */
  static AlertSendTimeoutMs = 200;

  public options: Options;
  public sessionType: SessionTypes;

  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  /**
   * Fires with a {@link DtlsAlertError} when the connection ends with a fatal
   * alert (received from the peer, or sent by this side when it rejected the
   * peer certificate), and with other errors raised by the handshake.
   */
  readonly onError = new Event<[Error]>();
  /** Fires once when the peer closed the connection with close_notify. */
  readonly onClose = new Event();
  /** Fires for every alert received from the peer (before onClose / onError). */
  readonly onAlert = new Event<[DtlsAlert]>();
  readonly transport: TransportContext;
  cipher: CipherContext;
  dtls: DtlsContext;
  srtp: SrtpContext = new SrtpContext();

  connected = false;
  extensions: Extension[] = [];
  /**
   * Assembled handshake handler. `peer` is the source of the datagram that
   * produced these messages (explicit UDP/inject addr) — async handlers must
   * reply to this address rather than reading mutable transport.rinfo.
   */
  onHandleHandshakes!: (
    assembled: FragmentedHandshake[],
    peer?: Address,
  ) => Promise<void>;

  private bufferFragmentedHandshakes: FragmentedHandshake[] = [];
  /** close_notify or a fatal alert was sent: no record is sent any more. */
  private alertSent = false;
  /** The alert that is being sent (shared with concurrent close calls). */
  private alertSending?: Promise<void>;
  /**
   * The connection ended (close_notify / fatal alert sent or received, or
   * close()): received records are no longer processed.
   */
  private ended = false;

  /** When set, DTLS 1.3 engine owns the transport and crypto state. */
  protected engine13?: Dtls13Connection;
  /**
   * Bridge subscriptions for the active / parked 1.3 candidate.
   * Disposed on hard close, version commit to 1.2, or re-bridge so dead
   * candidates cannot surface stale onConnect / onError / onClose.
   */
  private engine13Bridge = new EventDisposer();
  /** Negotiated / configured protocol versions (priority order). */
  readonly protocolVersions: DtlsVersion[];

  constructor(options: Options, sessionType: SessionTypes) {
    this.options = options;
    this.sessionType = sessionType;
    this.protocolVersions = normalizeProtocolVersions(
      this.options.protocolVersions,
    );
    this.dtls = new DtlsContext(this.options, this.sessionType);
    this.cipher = new CipherContext(
      this.sessionType,
      this.options.cert,
      this.options.key,
      this.options.signatureHash,
    );
    this.transport = new TransportContext(this.options.transport);
    this.setupExtensions();
    this.transport.socket.onData = this.udpOnMessage;
  }

  /** True when this socket is operating on the DTLS 1.3 engine. */
  get isDtls13(): boolean {
    return !!this.engine13;
  }

  renegotiation() {
    // Terminal association must not re-init flight/cipher state (invariant:
    // reconnect / renegotiation on a closed association is prohibited).
    if (this.associationTornDown) {
      const error = new Error(
        "DTLS association is closed; cannot renegotiation",
      );
      this.onError.execute(error);
      return;
    }
    if (this.engine13) {
      // DTLS 1.3 renegotiation is not defined; reject.
      const error = new Error(
        "renegotiation is not supported after DTLS 1.3 handshake",
      );
      this.onError.execute(error);
      return;
    }
    log("renegotiation", this.sessionType);
    this.connected = false;
    // Cancel retransmit timers on the *old* context before abandoning it.
    // Otherwise Flight.transmit sleeps keep firing against a detached DtlsContext
    // and can still TX after renegotiation replaces cipher/dtls.
    this.abortLegacy12Flight();
    this.abortAssociationWaits();
    // Fresh AbortController for the new handshake waits (previous signal aborted).
    this.associationAbort = new AbortController();
    this.cipher = new CipherContext(
      this.sessionType,
      this.options.cert,
      this.options.key,
      this.options.signatureHash,
    );
    this.dtls = new DtlsContext(this.options, this.sessionType);
    this.srtp = new SrtpContext();
    this.extensions = [];
    this.bufferFragmentedHandshakes = [];
    this.setupExtensions();
  }

  protected udpOnMessage = (data: Buffer, addr?: Address) => {
    this.handleUdpDatagram(data, addr);
  };

  /** Normalize host so 0.0.0.0 / :: match loopback pin keys used by Flight. */
  private normalizePeerHost(host: string): string {
    return normalizeLoopbackHost(host);
  }

  /**
   * Resolve inbound peer for RX ownership: explicit UDP/inject addr first,
   * else last transport rinfo (may be spoofed — always gate with pin).
   */
  protected resolveInboundPeer(addr?: Address): Address | undefined {
    if (addr != null && addr[0] != null && addr[1] != null) {
      return [addr[0], addr[1]];
    }
    // Some Transport implementations expose Node's AddressInfo object instead
    // of the tuple shape; normalize it before cookie pinning and RX checks.
    const addressInfo = addr as unknown as
      | { address?: string; port?: number }
      | undefined;
    if (addressInfo?.address != null && addressInfo.port != null) {
      return [addressInfo.address, addressInfo.port];
    }
    const r = (
      this.options.transport as {
        rinfo?: { address?: string; port?: number };
      }
    ).rinfo;
    if (r?.address != null && r?.port != null) {
      return [r.address, r.port];
    }
    return undefined;
  }

  /**
   * True when inbound source matches association TX/RX pin, or no pin yet
   * (pre-cookie server / pre-connect). After pin, unknown or non-pin peer
   * must not drive handshake / app / alert lifecycle (RX ownership).
   *
   * Peer-authentication vs address pin are separate:
   * - UDP 5-tuple pin: require matching source address when present
   * - authenticated-single-peer transport (ICE / peerAuthenticated): the
   *   transport path is the identity; addressless RX is accepted even if a
   *   pin was set for TX convenience (WebRTC does not pass rinfo into DTLS)
   */
  protected matchesPinnedPeer(addr?: Address): boolean {
    // Transport identity is the peer: 5-tuple is not an auth boundary.
    // Accept addressless and alternate addresses (ICE may not expose stable rinfo).
    if (this.isAuthenticatedSinglePeerTransport()) return true;
    const pin = this.transport.pinnedPeer;
    if (!pin) return true;
    if (!addr) {
      // datagram-address after pin: addressless RX is a drop.
      return false;
    }
    const a: [string, number] = [this.normalizePeerHost(addr[0]), addr[1]];
    const p: [string, number] = [this.normalizePeerHost(pin[0]), pin[1]];
    return peerKeyFromAddr(a) === peerKeyFromAddr(p);
  }

  /**
   * Resolved peer-identity policy for this association.
   * Prefer explicit {@link Options.peerIdentityMode}; otherwise infer from
   * transport.peerAuthenticated / addressValidation for backward compatibility.
   */
  get peerIdentityMode(): PeerIdentityMode {
    return resolvePeerIdentityMode({
      peerIdentityMode: this.options.peerIdentityMode,
      addressValidation: this.options.addressValidation,
      transport: this.options.transport as { peerAuthenticated?: boolean },
    });
  }

  /**
   * Transport path already authenticates a single peer (ICE / equivalent).
   * Distinct from TransportContext.pinnedPeer (UDP return-routability).
   * Driven by {@link peerIdentityMode} (public Options) when set.
   */
  protected isAuthenticatedSinglePeerTransport(): boolean {
    return this.peerIdentityMode === "authenticated-single-peer";
  }

  /**
   * After keys exist (connected or write epoch advanced), only epoch>0 records
   * are cryptographically authenticated for lifecycle alerts. Epoch-0 fatal /
   * close_notify must not tear down a post-handshake association (unauth DoS).
   */
  protected isAuthenticatedLegacy12Record(epoch: number): boolean {
    // During the handshake, a peer may still send a plaintext fatal alert
    // after this side has advanced its write epoch. Require AEAD only once the
    // association is connected; the source/cookie identity gate still applies.
    return !this.connected || epoch > 0;
  }

  /**
   * Peer-auth boundary for DTLS 1.2 association lifecycle (alerts / HS errors).
   *
   * - UDP pin after cookie / connect (classic return-routability / datagram-address)
   * - authenticated-single-peer transport (ICE peerAuthenticated / ice-authenticated):
   *   AEAD-protected records must not be treated as "pre-auth" merely because
   *   the transport does not expose a 5-tuple (WebRTC IceTransport).
   *
   * These modes are not interchangeable for TX routing (pin still owns UDP TX),
   * but either is sufficient for association-lifecycle alert decisions.
   */
  protected hasAssociationPeerAuth(): boolean {
    // A DTLS client has an outbound association owner; source pinning (when
    // available) is still enforced by matchesPinnedPeer(). Servers remain
    // silent until ICE identity or a return-routability pin is established.
    if (this.sessionType === SessionType.CLIENT) return true;
    return associationHasPeerAuth({
      hasPinnedPeer: !!this.transport.pinnedPeer,
      identityMode: this.peerIdentityMode,
    });
  }

  /** Restore transport.rinfo to pin so spoof sources do not stick for later TX fallbacks. */
  protected restorePinnedRinfo(): void {
    const pin = this.transport.pinnedPeer;
    if (!pin) return;
    const t = this.options.transport as {
      rinfo?: { address?: string; port?: number };
    };
    t.rinfo = { address: pin[0], port: pin[1] };
  }

  /**
   * Process one UDP datagram on the DTLS 1.2 record path.
   * Subclasses (dual client) may intercept before calling this.
   *
   * RX ownership (when pin set): drop non-pin peers before parse/decrypt so
   * spoofed UDP / carrier inject cannot deliver app data or force terminal
   * via unauthenticated alerts.
   */
  protected handleUdpDatagram(data: Buffer, addr?: Address): void {
    // Terminal association: drop all RX (no onData / handshake resume after fatal).
    if (this.associationTornDown || this.ended) return;

    const peer = this.resolveInboundPeer(addr);
    // Association peer pin owns RX as well as TX once set (cookie / connect).
    if (!this.matchesPinnedPeer(peer)) {
      log(
        this.dtls.sessionId,
        "DTLS 1.2: drop RX from non-association peer",
        peerKeyFromAddr(
          peer
            ? ([this.normalizePeerHost(peer[0]), peer[1]] as [string, number])
            : undefined,
        ),
        peerKeyFromAddr(
          this.transport.pinnedPeer
            ? ([this.transport.pinnedPeer[0], this.transport.pinnedPeer[1]] as [
                string,
                number,
              ])
            : undefined,
        ),
      );
      this.restorePinnedRinfo();
      return;
    }

    const packets = parsePacket(data);

    for (const packet of packets) {
      // An alert earlier in this datagram may have ended the connection.
      if (this.ended) return;
      try {
        // Re-check: async fatal during multi-record datagram must stop mid-loop.
        if (this.associationTornDown) return;
        const recordEpoch = packet.recordLayerHeader.epoch;
        const messages = parsePlainText(this.dtls, this.cipher)(packet);
        for (const message of messages) {
          if (this.associationTornDown) return;
          if (this.ended) return;
          switch (message.type) {
            case ContentType.handshake:
              {
                // Post-handshake epoch-0 HS is unauthenticated plaintext — same
                // invariant as DTLS 1.3 (drop without lifecycle change). Must not
                // call renegotiation() / reset cipher on garbage or spoofed CH.
                if (
                  !this.isAuthenticatedLegacy12Record(recordEpoch) ||
                  (this.connected && recordEpoch < this.dtls.remoteEpoch)
                ) {
                  log(
                    this.dtls.sessionId,
                    "DTLS 1.2: drop unauthenticated handshake record",
                    recordEpoch,
                    this.connected,
                  );
                  break;
                }
                const handshake = message.data as FragmentedHandshake;
                const handshakes = this.handleFragmentHandshake([handshake]);
                const assembled = Object.values(
                  handshakes.reduce(
                    (acc: { [type: string]: FragmentedHandshake[] }, cur) => {
                      if (!acc[cur.msg_type]) acc[cur.msg_type] = [];
                      acc[cur.msg_type].push(cur);
                      return acc;
                    },
                    {},
                  ),
                )
                  .map((v) => FragmentedHandshake.assemble(v))
                  .sort((a, b) => a.msg_type - b.msg_type);

                // Pass the datagram source so async Flight2 / protocol alerts
                // do not depend on mutable UdpTransport.rinfo after await.
                this.onHandleHandshakes(assembled, peer).catch((error) => {
                  err(this.dtls.sessionId, "onHandleHandshakes error", error);
                  const e =
                    error instanceof Error ? error : new Error(String(error));
                  // Pre-cookie / unpinned: drop per-source only — never tear down
                  // the listening association (unauthenticated DoS).
                  if (!this.hasAssociationPeerAuth()) {
                    log(
                      this.dtls.sessionId,
                      "DTLS 1.2: drop pre-auth handshake error (no association fatal)",
                      e.message,
                    );
                    return;
                  }
                  // Post-pin: handshake failure is association-fatal.
                  this.reportLegacy12Fatal(e);
                });
              }
              break;
            case ContentType.applicationData:
              {
                // Never deliver app data after association terminal teardown.
                if (this.associationTornDown || this.ended) return;
                // App data is always epoch>0 AEAD; unauthenticated epoch-0 must not deliver.
                if (!this.isAuthenticatedLegacy12Record(recordEpoch)) {
                  log(
                    this.dtls.sessionId,
                    "DTLS 1.2: drop unauthenticated application_data",
                    recordEpoch,
                  );
                  break;
                }
                this.notify(this.onData, message.data as Buffer);
              }
              break;
            case ContentType.alert:
              {
                const alert = message.data as DtlsAlert | undefined;
                if (!alert) break;
                // Pre-cookie (no pin): any alert is unauthenticated — drop only.
                if (
                  !this.hasAssociationPeerAuth() &&
                  !(this.connected && recordEpoch > 0)
                ) {
                  log(
                    this.dtls.sessionId,
                    "DTLS 1.2: ignore pre-auth alert (no association fatal)",
                    alertDescName(alert.description) ?? alert.description,
                  );
                  break;
                }
                // Unauthenticated (epoch-0 after keys) alerts must not change
                // association lifecycle — only AEAD-protected records may.
                if (!this.isAuthenticatedLegacy12Record(recordEpoch)) {
                  log(
                    this.dtls.sessionId,
                    "DTLS 1.2: ignore unauthenticated alert (no terminal)",
                    alertDescName(alert.description) ?? alert.description,
                    "epoch",
                    recordEpoch,
                  );
                  break;
                }
                // Alert records can contain multiple alerts; each remains in
                // the authenticated peer / epoch boundary above.
                this.handleAlert(alert);
              }
              break;
          }
        }
      } catch (error) {
        // An invalid record (e.g. failed to decrypt) is discarded
        // (RFC 6347 §4.1.2.1).
        err(this.dtls.sessionId, "catch udpOnMessage error", error);
      }
    }
  }

  /** Resolves once an in-flight alert has been handed to the transport. */
  alertFlushed(): Promise<void> {
    return this.alertSending ?? Promise.resolve();
  }

  /**
   * A local close() ended the connection: received records are no longer
   * processed and no handshake flight is (re)sent.
   */
  protected markEndedByLocalClose() {
    this.ended = true;
    this.transport.stopFlights();
  }

  /** Whether the connection ended (alert, or close()). */
  get terminated() {
    return this.ended;
  }

  /** Whether this handshake must stop after a terminal alert or close. */
  protected get handshakeStopped() {
    return this.ended || this.alertSent;
  }

  /**
   * Run the listeners of an event this socket reports, each isolated
   * (`Event.executeIsolated`): a listener's exception is logged, so an
   * application listener can never interrupt the socket's own processing
   * (ending the connection, closing the transport, the receive loop) nor
   * skip a listener registered after it.
   */
  protected notify<T extends any[]>(event: Event<T>, ...args: T) {
    // Per listener: one that throws neither skips the later listeners (e.g.
    // werift's own, if the application subscribed first) nor this socket.
    event.executeIsolated(
      (error) => err(this.dtls.sessionId, "event listener failed", error),
      ...args,
    );
  }

  /**
   * RFC 5246 §7.2: react to an alert received from the peer. The connection
   * is ended (flights stopped, close_notify answered or the transport
   * closed) before any listener runs, and each notification is isolated, so
   * a throwing listener does not leave the socket ended but unreported.
   */
  private handleAlert(alert: DtlsAlert) {
    if (this.ended || this.associationTornDown) return;
    if (alert.description === AlertDesc.ProtocolVersion) {
      // protocol_version at any level: the peer rejected the version, so the
      // association fails with ProtocolVersionError (not a silent timeout).
      err(this.dtls.sessionId, "received protocol_version alert", alert);
      this.alertSent = true;
      this.transport.stopFlights();
      this.failFromRemoteAlert(
        alert,
        new ProtocolVersionError(
          "peer rejected protocol version (alert protocol_version)",
        ),
      );
      return;
    }
    const action = classifyAlert(alert);
    if (action === "ignore") {
      log(this.dtls.sessionId, "ignore warning alert", alert);
      this.notify(this.onAlert, alert);
      return;
    }

    this.ended = true;
    // Retransmitting a handshake flight makes no sense any more.
    this.transport.stopFlights();

    if (action === "close") {
      log(this.dtls.sessionId, "received close_notify");
      this.abortLegacy12Flight();
      this.connected = false;
      this.associationTornDown = true;
      this.abortAssociationWaits();
      this.notify(this.onAlert, alert);
      // RFC 5246 §7.2.1: respond with close_notify; nothing is sent after it.
      void this.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
      // The connection is over: the socket closes its transport once the
      // reply has been sent or timed out, like after a fatal alert (the
      // application does not need to call close()).
      void this.alertFlushed().then(() => this.finishPeerCloseNotify());
    } else {
      err(this.dtls.sessionId, "received fatal alert", alert);
      // A fatal alert is not answered (RFC 5246 §7.2.2).
      this.alertSent = true;
      this.failFromRemoteAlert(alert, new DtlsAlertError(alert, "remote"));
    }
  }

  /**
   * Fatal teardown for a received alert: the association is torn down before
   * the listeners run, then onAlert, onError and onClose fire once each.
   */
  private failFromRemoteAlert(alert: DtlsAlert, error: Error) {
    if (!this.failLegacy12Association(error)) return;
    this.notify(this.onAlert, alert);
    this.notify(this.onError, error);
    this.notify(this.onClose);
  }

  /**
   * After the reply to the peer's close_notify was sent (or timed out):
   * fire onClose once and close the transport. The dual client overrides it
   * to also hard-close its 1.3 candidates and carrier.
   */
  protected finishPeerCloseNotify(): Promise<void> {
    this.clearSendPeerPin();
    this.notify(this.onClose);
    return this.closeTransport();
  }

  /**
   * Send an alert to the peer, protected with the current epoch (plaintext
   * before ChangeCipherSpec, encrypted after it).
   *
   * Resolves once the transport has sent the record, or after `timeoutMs`
   * (default {@link DtlsSocket.AlertSendTimeoutMs}). It never rejects: a
   * failed send is only logged. Nothing is sent once close_notify or a fatal
   * alert has been sent or the transport is closed. Sending close_notify or a
   * fatal alert also stops the handshake flights (no retransmission). The
   * record is handed to the transport synchronously, so closing the socket
   * right after calling this does not drop it.
   *
   * A fatal alert ends the connection like a fatal error this side detected
   * itself: `onError` fires synchronously with a local {@link DtlsAlertError},
   * and the transport is closed once the alert has been sent (the returned
   * promise resolves after that).
   */
  sendAlert(
    level: AlertLevel,
    description: AlertDesc,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (level === AlertLevel.fatal) {
      return this.endWithFatalAlert(description, undefined, options);
    }
    return this.transmitAlert(level, description, options);
  }

  /** Encode, protect and send one alert record (see {@link sendAlert}). */
  private transmitAlert(
    level: AlertLevel,
    description: AlertDesc,
    options: { timeoutMs?: number },
  ): Promise<void> {
    if (this.alertSent || this.transport.closed) {
      // A concurrent caller waits for the alert that is still being sent.
      return this.alertSending ?? Promise.resolve();
    }
    if (level === AlertLevel.fatal || description === AlertDesc.CloseNotify) {
      this.alertSent = true;
      // A terminating alert ends the handshake too: no handshake flight is
      // sent or retransmitted after it.
      this.transport.stopFlights();
    }
    if (level === AlertLevel.fatal) {
      this.ended = true;
    }

    let sending: Promise<void>;
    try {
      const record = createAlertRecord(this.dtls, this.cipher, {
        level,
        description,
      });
      log(this.dtls.sessionId, "send alert", {
        level,
        description,
        epoch: this.dtls.epoch,
        sequenceNumber: this.dtls.recordSequenceNumber,
      });
      sending = this.transport.send(record);
    } catch (error) {
      err(this.dtls.sessionId, "failed to send alert", error);
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? DtlsSocket.AlertSendTimeoutMs;
    const timer = new AbortController();
    const done = Promise.race([
      sending,
      setTimeout(timeoutMs, undefined, { signal: timer.signal }).then(() => {
        log(this.dtls.sessionId, "alert send timeout", timeoutMs);
      }),
    ])
      .catch((error) => {
        if (timer.signal.aborted) return;
        err(this.dtls.sessionId, "failed to send alert", error);
      })
      .finally(() => timer.abort())
      // A UDP transport hands the datagram to the socket on a later tick
      // (dgram resolves the address asynchronously): closing the socket
      // right after send() resolved would drop the alert.
      .then(() => setImmediate());
    this.alertSending = done;
    return done;
  }

  /**
   * Abort the handshake (or the connection) because this side detected a
   * fatal error: see {@link endWithFatalAlert}.
   */
  protected abortWithFatalAlert(description: AlertDesc, reason?: unknown) {
    void this.endWithFatalAlert(description, reason);
  }

  /**
   * The single ending path for a fatal alert sent by this side (the public
   * {@link sendAlert} and an internal abort): send the alert, stop the
   * flights, report a local {@link DtlsAlertError} on onError (once), and
   * close the transport once the alert has been sent or timed out. Does
   * nothing more once the connection already ended.
   */
  private endWithFatalAlert(
    description: AlertDesc,
    reason?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.ended || this.alertSent || this.transport.closed) {
      return this.alertSending ?? Promise.resolve();
    }
    const sending = this.transmitAlert(AlertLevel.fatal, description, options);
    this.ended = true;
    this.transport.stopFlights();
    // The transport closes once the alert was sent, whatever a listener does.
    const done = sending.then(() => this.closeTransport());
    this.alertSending = done;
    this.notify(
      this.onError,
      new DtlsAlertError(
        { level: AlertLevel.fatal, description },
        "local",
        reason,
      ),
    );
    return done;
  }

  /**
   * Call `options.verifyRemoteCertificate` with the received peer
   * certificate. When it returns false or throws, the handshake is aborted
   * with a fatal bad_certificate alert and false is returned.
   */
  protected verifyRemoteCertificate() {
    const verify = this.options.verifyRemoteCertificate;
    if (!verify) return true;
    const certificate = this.cipher.remoteCertificate;
    let reason: unknown;
    try {
      if (certificate && verify(Buffer.from(certificate))) {
        return true;
      }
    } catch (error) {
      reason = error;
    }
    err(this.dtls.sessionId, "remote certificate rejected", reason);
    this.abortWithFatalAlert(AlertDesc.BadCertificate, reason);
    return false;
  }

  /**
   * Close the transport (once; concurrent callers share the same close) and
   * resolve when it has closed. A failure (a rejection or a synchronous
   * throw of the transport's close()) is only logged: it never interrupts
   * the caller, e.g. the onError notification of a received fatal alert.
   */
  private closeTransport() {
    return this.transport.close().catch((error: unknown) => {
      err(this.dtls.sessionId, "failed to close transport", error);
    });
  }

  protected setupExtensions() {
    log(this.dtls.sessionId, "support srtpProfiles", this.options.srtpProfiles);
    if (this.options.srtpProfiles && this.options.srtpProfiles.length > 0) {
      // Empty MKI payload (length byte is written by UseSRTP.serialize).
      const useSrtp = UseSRTP.create(
        this.options.srtpProfiles,
        Buffer.alloc(0),
      );
      this.extensions.push(useSrtp.extension);
    }

    {
      const curve = EllipticCurves.createEmpty();
      curve.data = NamedCurveAlgorithmList;
      this.extensions.push(curve.extension);
    }

    {
      const signature = Signature.createEmpty();
      // libwebrtc/OpenSSL require 4=1 , 4=3 signatureHash
      signature.data = signatures;
      this.extensions.push(signature.extension);
    }
    if (this.options.extendedMasterSecret) {
      this.extensions.push({
        type: ExtendedMasterSecret.type,
        data: Buffer.alloc(0),
      });
    }

    {
      const renegotiationIndication = RenegotiationIndication.createEmpty();
      this.extensions.push(renegotiationIndication.extension);
    }
  }

  /**
   * Aborts association-owned async waits ({@link waitForReady} sleeps).
   * Invoked on every terminal transition so pending timers/promises cancel
   * immediately (not only "wake later and check torn-down").
   */
  protected abortAssociationWaits(): void {
    if (!this.associationAbort.signal.aborted) {
      this.associationAbort.abort();
    }
  }

  protected waitForReady = (condition: () => boolean) =>
    new Promise<void>(async (r, f) => {
      for (let i = 0; i < 10; i++) {
        if (this.associationTornDown || this.associationAbort.signal.aborted) {
          f(new Error("association closed during waitForReady"));
          return;
        }
        if (condition()) {
          r();
          return;
        }
        try {
          // AbortSignal: close/fatal cancels this sleep immediately.
          await setTimeout(100 * i, undefined, {
            signal: this.associationAbort.signal,
          });
        } catch {
          f(new Error("association closed during waitForReady"));
          return;
        }
      }
      f(new Error("waitForReady timeout"));
    });

  handleFragmentHandshake(messages: FragmentedHandshake[]) {
    let handshakes = messages.filter((v) => {
      // find fragmented
      if (v.fragment_length !== v.length) {
        this.bufferFragmentedHandshakes.push(v);
        return false;
      }
      return true;
    });

    if (this.bufferFragmentedHandshakes.length > 1) {
      const [last] = this.bufferFragmentedHandshakes.slice(-1);
      if (last.fragment_offset + last.fragment_length === last.length) {
        handshakes = [...this.bufferFragmentedHandshakes, ...handshakes];
        this.bufferFragmentedHandshakes = [];
      }
    }
    return handshakes; // return un fragmented handshakes
  }

  /**
   * True after association hard/graceful/fatal teardown so Public APIs stay
   * disabled for pure 1.2, pure 1.3, and dual paths alike (even if transport
   * close is still racing or engine13 has already been cleared).
   * Dual client also flips dualPhase=closed; this flag is the base guard.
   */
  protected associationTornDown = false;

  /**
   * Cancels pending {@link waitForReady} association sleeps on terminal teardown.
   * Replaced only if a future multi-HS redesign needs a fresh controller mid-life.
   */
  protected associationAbort = new AbortController();

  /**
   * Guard for send / exporter / remoteCertificate.
   * Dual client overrides to reject `closed` and `probing` (no 1.2 fallthrough).
   */
  protected assertReadyForApplicationApi(op: string): void {
    if (this.associationTornDown) {
      throw new Error(`DTLS association is closed; cannot ${op}`);
    }
    // Engine may enter closing (onClosing) before associationTornDown if a
    // direct engine path races; still reject Public API.
    if (this.engine13?.isClosed()) {
      throw new Error(`DTLS association is closed; cannot ${op}`);
    }
  }

  /**
   * Normalize and store association TX peer pin on TransportContext.
   *
   * Why association-owned: UdpTransport.rinfo is overwritten by every inbound
   * datagram (including spoof). Flight retransmit and application send must not
   * follow last-rinfo alone (ticket peer-pinning / TX ownership).
   *
   * @param mode `set-if-empty` keeps the first authenticated pin (server Flight4 /
   *   connect). `replace` is for dual association re-pin / client connect.
   */
  protected pinSendPeer(
    addr?: Address,
    mode: "set-if-empty" | "replace" = "set-if-empty",
  ): void {
    if (!addr || addr[0] == null || addr[1] == null) return;
    if (mode === "set-if-empty" && this.transport.pinnedPeer) return;
    this.transport.pinnedPeer = normalizePeerTuple([addr[0], addr[1]]);
  }

  /**
   * Pin from last transport rinfo when present.
   * Default mode is `set-if-empty` (keeps an existing authenticated pin).
   * Pass `replace` when the association deliberately re-pins (e.g. client connect).
   */
  protected pinSendPeerFromTransportRinfo(
    mode: "set-if-empty" | "replace" = "set-if-empty",
  ): void {
    const r = (
      this.options.transport as {
        rinfo?: { address?: string; port?: number };
      }
    ).rinfo;
    if (r?.address != null && r?.port != null) {
      this.pinSendPeer([r.address, r.port], mode);
    }
  }

  /** Clear TX pin on association terminal teardown. */
  protected clearSendPeerPin(): void {
    this.transport.pinnedPeer = undefined;
  }

  /**send application data */
  send = async (buf: Buffer, addr?: Address) => {
    // A torn-down association rejects (see the lifecycle table in README);
    // after this side only sent an alert, application data is dropped.
    this.assertReadyForApplicationApi("send");
    if (this.alertSent || this.ended) {
      log(this.dtls.sessionId, "drop application data after alert");
      return;
    }
    if (this.engine13) {
      await this.engine13.send(buf);
      return;
    }
    // Pure 1.2 only after version commit / handshake; require pin so we never
    // fall back to spoofed last-rinfo when the caller omits addr.
    if (!addr && !this.transport.pinnedPeer) {
      this.pinSendPeerFromTransportRinfo("set-if-empty");
    }
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    // Prefer explicit addr, else TransportContext.pinnedPeer (association pin).
    // Never rely solely on last UDP rinfo (spoof hijack).
    await this.transport.send(this.cipher.encryptPacket(pkt).serialize(), addr);
  };

  /**
   * Cancel pending DTLS 1.2 flight retransmit sleeps only (leave flight number).
   * Use on successful handshake complete so Flight4/Flight5 sleep does not
   * linger until the next RTO after onConnect.
   */
  protected cancelLegacy12FlightTimers(): void {
    this.dtls.cancelFlightTimers();
  }

  /**
   * Abort legacy DTLS 1.2 flight: optional fatalError, flight=99, cancel timers.
   * Use on close / fatal alert / version commit away from 1.2 — not on
   * successful handshake complete (that only needs cancelLegacy12FlightTimers).
   */
  protected abortLegacy12Flight(error?: Error): void {
    if (error) this.dtls.fatalError = error;
    this.dtls.flight = 99;
    this.dtls.cancelFlightTimers();
  }

  /**
   * Association-wide fatal teardown for DTLS 1.2 (TLS: immediate connection end).
   * Stops flight timers, clears connected, closes transport, disables Public API.
   * Dual client overrides to also set dualPhase=closed and close carrier/candidates.
   *
   * @returns true when the caller should fire public onClose after onError
   *   (same ordering as 1.3 {@link failAssociationFromEngine13}).
   */
  protected failLegacy12Association(error: Error): boolean {
    if (this.associationTornDown) return false;
    this.abortLegacy12Flight(error);
    this.connected = false;
    this.associationTornDown = true;
    this.ended = true;
    this.abortAssociationWaits();
    this.clearSendPeerPin();
    void this.transport.close().catch(() => {});
    return true;
  }

  /**
   * Tear down the 1.2 association then fire onError + onClose once.
   * Used for fatal alerts, handshake failures, probing DOWNGRD / classify error,
   * and ProtocolVersionError paths. Idempotent: concurrent terminal paths must
   * not double-fire public events.
   */
  protected reportLegacy12Fatal(error: Error): void {
    // failLegacy12Association returns false when already terminal.
    if (!this.failLegacy12Association(error)) return;
    this.notify(this.onError, error);
    this.notify(this.onClose);
  }

  /**
   * Local close for pure DTLS 1.2 (server and non-overridden paths).
   * Terminal transition + optional single public onClose (client dual uses
   * closeAssociationHard instead).
   */
  protected closeLegacy12Association(
    firePublicOnClose = true,
    closeTransport = true,
  ): void {
    if (this.associationTornDown) return;
    this.abortLegacy12Flight();
    this.connected = false;
    this.associationTornDown = true;
    this.ended = true;
    this.abortAssociationWaits();
    this.clearSendPeerPin();
    if (firePublicOnClose) {
      this.notify(this.onClose);
    }
    if (closeTransport) {
      void this.transport.close().catch(() => {});
    }
  }

  /**
   * Close this association. The Public API becomes terminal synchronously
   * (send() rejects right after close()), before any await. DTLS 1.2
   * optionally sends close_notify first; an alert already handed to the
   * transport is flushed before the transport closes. A live DTLS 1.3 engine
   * sends its close_notify and closes the transport itself
   * (teardownAssociation), so it is not closed here.
   */
  async close(options: { notify?: boolean; timeoutMs?: number } = {}) {
    const sending =
      options.notify && !this.engine13
        ? this.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify, {
            ...(options.timeoutMs !== undefined && {
              timeoutMs: options.timeoutMs,
            }),
          })
        : undefined;
    this.markEndedByLocalClose();
    if (this.engine13) {
      // onClosing from the engine is idempotent with prepareAssociationClosed.
      this.prepareAssociationClosedFromEngine();
      this.engine13.close();
      await this.alertFlushed();
      return;
    }
    // DTLS 1.2 server (and any non-overridden close): terminal + onClose once.
    this.closeLegacy12Association(true, false);
    await sending;
    // Closing the transport now would drop an alert handed to it but not
    // yet written (a UDP datagram goes out on a later tick).
    await this.alertFlushed();
    // Waits for a close already in progress (e.g. after a fatal alert).
    await this.closeTransport();
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
    this.assertReadyForApplicationApi("extractSessionKeys");
    if (this.engine13) {
      return this.engine13.extractSessionKeys(keyLength, saltLength);
    }
    const keyingMaterial = this.exportKeyingMaterial(
      "EXTRACTOR-dtls_srtp",
      keyLength * 2 + saltLength * 2,
    );

    const { clientKey, serverKey, clientSalt, serverSalt } = decode(
      keyingMaterial,
      {
        clientKey: types.buffer(keyLength),
        serverKey: types.buffer(keyLength),
        clientSalt: types.buffer(saltLength),
        serverSalt: types.buffer(saltLength),
      },
    );

    if (this.sessionType === SessionType.CLIENT) {
      return {
        localKey: clientKey,
        localSalt: clientSalt,
        remoteKey: serverKey,
        remoteSalt: serverSalt,
      };
    } else {
      return {
        localKey: serverKey,
        localSalt: serverSalt,
        remoteKey: clientKey,
        remoteSalt: clientSalt,
      };
    }
  }

  exportKeyingMaterial(label: string, length: number) {
    this.assertReadyForApplicationApi("exportKeyingMaterial");
    if (this.engine13) {
      return this.engine13.exportKeyingMaterial(label, length);
    }
    return exportKeyingMaterial(
      label,
      length,
      this.cipher.masterSecret,
      this.cipher.localRandom.serialize(),
      this.cipher.remoteRandom.serialize(),
      this.sessionType === SessionType.CLIENT,
    );
  }

  get remoteCertificate() {
    this.assertReadyForApplicationApi("remoteCertificate");
    if (this.engine13) {
      return this.engine13.remoteCertificate;
    }
    return this.cipher.remoteCertificate;
  }

  /** Request KeyUpdate on DTLS 1.3 connections. */
  async keyUpdate(requestUpdate = false): Promise<void> {
    this.assertReadyForApplicationApi("keyUpdate");
    if (!this.engine13) {
      throw new Error("KeyUpdate is only available for DTLS 1.3");
    }
    await this.engine13.keyUpdate(requestUpdate);
  }

  /** Drop bridge subscriptions for a disposed or replaced 1.3 candidate. */
  protected unbridgeEngine13(): void {
    this.engine13Bridge.dispose();
  }

  /**
   * Association-level fatal teardown after a non-soft 1.3 engine error.
   * Clears public engine13 (isDtls13 → false), stops bridge callbacks, and
   * hard-disposes candidate resources. HVR dual soft transition must not call
   * this (filterError swallows DtlsVersionSelected before we reach here).
   *
   * Subclasses (dual client) override to also flip dualPhase → closed and
   * tear down parked candidates / 1.2 flight timers.
   *
   * @returns true when public onClose should be fired after onError (caller
   *   owns ordering so handlers observe isDtls13 === false first).
   */
  protected failAssociationFromEngine13(_err: Error): boolean {
    // Terminal for pure 1.3 and dual-server 1.3: same Public-API disable as 1.2.
    // Without associationTornDown, send/exporter fall through to an empty 1.2
    // cipher path after engine13 is cleared (role/version asymmetry / P1).
    if (this.associationTornDown && !this.engine13) {
      return false;
    }
    this.connected = false;
    this.associationTornDown = true;
    this.ended = true;
    this.abortAssociationWaits();
    this.clearSendPeerPin();
    // Unbridge first so subsequent engine onClose/onError cannot re-enter or
    // double-fire public callbacks when fail() continues to onClose.
    this.unbridgeEngine13();
    const eng = this.engine13;
    this.engine13 = undefined;
    if (eng) {
      // Soft ProtocolVersionError leaves carrier open; hard fail may already
      // have closed it. Always force resource dispose without re-firing events.
      eng.hardDisposeResources();
    }
    // Always close transport (hardDispose does not). Double-close is fine.
    void this.transport.close().catch(() => {});
    // Engine hard-fail would have fired onClose after onError, but unbridge
    // removed that subscription — association owns the single public onClose.
    return true;
  }

  /**
   * Before public onClose for engine teardown: mark association closed so
   * re-entrant client.close() inside onClose handlers is idempotent and
   * Public APIs reject (send/exporter/cert) without 1.2 fallthrough.
   * Dual client also sets dualPhase → closed here.
   */
  protected prepareAssociationClosedFromEngine(): void {
    this.connected = false;
    this.associationTornDown = true;
    this.abortAssociationWaits();
    this.clearSendPeerPin();
  }

  /**
   * After engine onClose (peer close_notify or local engine close) has been
   * delivered publicly: drop the 1.3 handle. Dual client overrides to also
   * hard-close carrier / transport / candidates.
   */
  protected onEngine13PeerOrLocalClose(): void {
    // Idempotent terminal mark (prepareAssociationClosedFromEngine already ran).
    this.associationTornDown = true;
    this.connected = false;
    this.clearSendPeerPin();
    this.unbridgeEngine13();
    this.engine13 = undefined;
    void this.transport.close().catch(() => {});
  }

  /**
   * Wire DTLS 1.3 engine events onto this socket.
   * @param engine DTLS 1.3 connection to bridge.
   * @param options Optional bridge options. When `options.filterError` returns
   *   true, swallow the error (e.g. dual-stack version mismatch handled by
   *   transparent fallback without public onError).
   */
  protected bridgeEngine13(
    engine: Dtls13Connection,
    options?: { filterError?: (e: Error) => boolean },
  ) {
    // Replace any prior bridge so only the current candidate is public.
    this.unbridgeEngine13();
    this.engine13 = engine;
    engine.onConnect
      .subscribe(() => {
        // Terminal mid-handshake: do not flip connected back to true / re-fire.
        if (this.associationTornDown) return;
        this.connected = true;
        // Bridge negotiated use_srtp into public DtlsSocket.srtp (DTLS 1.2 path parity)
        const profile = engine.srtpProfile;
        if (profile !== undefined) {
          this.srtp.srtpProfile = profile;
        }
        this.onConnect.execute();
      })
      .disposer(this.engine13Bridge);
    engine.onData
      .subscribe((data) => this.onData.execute(data))
      .disposer(this.engine13Bridge);
    // Graceful close start (local close / peer close_notify): Public API off
    // immediately — before async close_notify completes.
    engine.onClosing
      .subscribe(() => {
        this.prepareAssociationClosedFromEngine();
      })
      .disposer(this.engine13Bridge);
    engine.onError
      .subscribe((e) => {
        // HVR soft dual transition only: do not public-error or fatal-teardown.
        if (options?.filterError?.(e)) return;
        this.connected = false;
        // Tear down association before public onError so handlers observe
        // isDtls13 === false and dualPhase === closed (client override).
        const fireClose = this.failAssociationFromEngine13(e);
        this.onError.execute(e);
        // Single public onClose (engine's own onClose is unsubscribed above).
        if (fireClose) {
          this.onClose.execute();
        }
      })
      .disposer(this.engine13Bridge);
    engine.onClose
      .subscribe(() => {
        // Mark closed before public onClose so handlers that call close()
        // re-entrantly do not double-fire onClose. (Often already set via onClosing.)
        this.prepareAssociationClosedFromEngine();
        // Fire public onClose while engine13 is still inspectable.
        this.onClose.execute();
        // Then association-level close: carrier/transport/candidates.
        this.onEngine13PeerOrLocalClose();
      })
      .disposer(this.engine13Bridge);
  }

  /**
   * Send a fatal DTLSPlaintext alert (used for protocol_version mismatch).
   * @param description Alert description code.
   * @param dest Explicit peer for this reply. Required pre-cookie so a concurrent
   *   spoof cannot redirect via mutable transport.rinfo; post-pin falls back to
   *   TransportContext.pinnedPeer when omitted.
   */
  protected async sendPlaintextAlert(
    description: number,
    dest?: Address,
  ): Promise<void> {
    const alert = Buffer.from([2, description]); // fatal
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.alert, fragment: alert }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    await this.transport.send(pkt.serialize(), dest);
  }
}

export interface Options {
  transport: Transport;
  srtpProfiles?: SrtpProfile[];
  cert?: string;
  key?: string;
  signatureHash?: SignatureHash;
  certificateRequest?: boolean;
  extendedMasterSecret?: boolean;
  /**
   * Protocol versions in **preference order** (first = highest priority).
   * Default: `[DtlsVersion.V1_2]` (backward compatible).
   * DTLS 1.3 requires explicit opt-in.
   *
   * Supported configurations:
   * - `[V1_2]` — DTLS 1.2 only (default)
   * - `[V1_3]` — DTLS 1.3 only
   * - `[V1_3, V1_2]` — prefer DTLS 1.3; fall back to 1.2-only peers
   *
   * `[V1_2, V1_3]` is normalized to `[V1_3, V1_2]`. A 1.2-first dual is not
   * viable under RFC 8446/9147 downgrade protection (DOWNGRD): dual×dual peers
   * cannot complete a deliberate 1.2 selection without aborting.
   *
   * Both roles use the same association version-selection semantics:
   * first local preference that appears in the peer's supported set.
   * ClientHello `supported_versions` is advertised in this order.
   */
  protocolVersions?: readonly DtlsVersion[];
  /**
   * Address validation policy for the server.
   * Default for generic DTLS: `"dtls-cookie"`.
   * WebRTC ICE-authenticated peers use `"ice-authenticated"` (Epic 2/3).
   */
  addressValidation?: "dtls-cookie" | "ice-authenticated" | "none";
  /**
   * Peer-identity policy for association TX/RX lifecycle.
   * Default (when omitted): inferred as `"authenticated-single-peer"` when
   * `transport.peerAuthenticated` or `addressValidation: "ice-authenticated"`,
   * otherwise `"datagram-address"`.
   *
   * Prefer setting this explicitly for custom carriers / ICE so call sites do
   * not depend on inference.
   */
  peerIdentityMode?: PeerIdentityMode;
  /**
   * DTLS 1.3 named groups preference order (key_share).
   * Default: X25519 then P-256. Use `[NamedCurveAlgorithm.secp256r1_23]` for P-256 only.
   */
  namedGroups?: readonly NamedCurveAlgorithms[];
  /** DTLS 1.3 carrier MTU hint for handshake fragmentation (bytes). */
  mtu?: number;
  /**
   * Max epoch-3 application-data records buffered before `onConnect`
   * (UDP reorder / 0.5-RTT early server data).
   * Default 256 — sized for WebRTC DataChannel (64 KiB `maxMessageSize`
   * plus SCTP control and reorder burst).
   * Pass `EARLY_APP_DATA_UNLIMITED` (`Infinity`) for trusted P2P with no cap.
   */
  maxEarlyAppDataRecords?: number;
  /**
   * Max bytes of epoch-3 application data buffered before `onConnect`.
   * Default 256 KiB. Raise together with `maxEarlyAppDataRecords`, or pass
   * `EARLY_APP_DATA_UNLIMITED` (`Infinity`) for trusted P2P with no cap.
   */
  maxEarlyAppDataBytes?: number;
  /**
   * Verify the peer certificate (DER) during the handshake. Returning false
   * or throwing aborts the handshake with a fatal bad_certificate alert, so
   * the peer learns the failure before it considers the connection
   * established: the client checks the server certificate before sending
   * flight 5, the server checks the client certificate before sending its
   * Finished. onError receives a {@link DtlsAlertError} with
   * `source: "local"`.
   */
  verifyRemoteCertificate?: (certificate: Buffer) => boolean;
}

/**
 * @internal
 * Internal options for unit tests and Epic 2 SPED carrier injection.
 * **Not part of the stable Public API** — never pass to the public constructors.
 * Use {@link createDtlsClientInternal} / {@link createDtlsServerInternal} instead.
 * `handshakeCarrier` is intentionally excluded from {@link Options}.
 */
export type DtlsInternalOptions = Options & {
  handshakeCarrier?: DtlsHandshakeCarrier;
};

export { DtlsVersion };
