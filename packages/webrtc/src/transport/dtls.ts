import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import {
  createDtlsClientInternal,
  createDtlsServerInternal,
} from "../../../dtls/src/internal";
import type { Connection } from "../../../ice/src";
import {
  connectionDatagramEvent,
  type IceDatagramContext,
} from "../../../ice/src/internal/datagram";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { SCTPSendPermissionRevokedError } from "../../../sctp/src";
import { EventTarget as DomEventTarget } from "../helper";
import { Event } from "../imports/common";
import { DtlsClient, DtlsServer, type DtlsSocket } from "../imports/dtls";
import {
  debug,
  isMedia,
  isRtcp,
  type RtcpPacket,
  type RtpHeader,
  type RtpPacket,
  type SrtcpSession,
  type SrtpProfile,
  type SrtpSession,
} from "../imports/rtp";
import { getStatsTimestamp, type RTCStats } from "../media/stats";
import { milliTime } from "../utils";
import { InboundApplicationGate } from "./dtls-application-gate";
import { TransportAttempts } from "./dtls-attempt";
import {
  createSelfSignedCertificate,
  type RTCCertificate,
  RTCDtlsParameters,
} from "./dtls-certificate";
import {
  deduplicateFingerprints,
  verifyRemoteCertificateFingerprint,
} from "./dtls-fingerprint";
import { createIceTransport } from "./dtls-ice-transport";
import { PreAuthMediaQueue } from "./dtls-media-queue";
import { TransportReadiness } from "./dtls-readiness";
import { isDtlsTransportSped } from "./dtls-sped";
import { runSpedHandshake } from "./dtls-sped-handshake";
import { decryptRtcp, decryptRtp, SrtpAccess } from "./dtls-srtp";
import { buildDtlsTransportStats } from "./dtls-stats";
import type {
  DtlsRole,
  DtlsState,
  DtlsTransportConfig,
  DtlsTransportStats,
  TransportAttempt,
} from "./dtls-types";
import type { RTCIceTransport } from "./ice";
import type { IceSpedTransport } from "./sped";

export {
  type DtlsKeys,
  RTCCertificate,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
} from "./dtls-certificate";
export {
  type DtlsRole,
  type DtlsState,
  DtlsStates,
  type DtlsTransportConfig,
  type DtlsTransportStats,
} from "./dtls-types";

const log = debug("werift:packages/webrtc/src/transport/dtls.ts");

type AddressValidation = "dtls-cookie" | "ice-authenticated";

/** Result of encrypting and enqueueing one RTP packet on ICE. */
export type DtlsSendRtpResult = {
  /** On-wire SRTP size in bytes. */
  size: number;
  /** Local clock immediately before ICE/UDP enqueue (RFC 8888 send time). */
  sendingAtMs: number;
};

// DTLS over an RTCIceTransport, with the WebRTC rules on top: nothing from
// the peer (application data, RTP, RTCP) reaches upper layers before its
// certificate matches the SDP fingerprint.
//
// The transport's state is split by concern, each part owning the fields
// that change together:
// - TransportAttempts (dtls-attempt.ts): which handshake / authentication
//   attempt owns the continuations (an ICE restart starts a new one);
// - TransportReadiness (dtls-readiness.ts): write-ready / peer-authenticated
//   / handshake-complete and the handshake timing;
// - SrtpAccess (dtls-srtp.ts): SRTP keys and the read / write permissions;
// - InboundApplicationGate (dtls-application-gate.ts) / PreAuthMediaQueue
//   (dtls-media-queue.ts): application data and media held until
//   authentication;
// - runSpedHandshake (dtls-sped-handshake.ts): the SPED carrier and runtime
//   when PeerConfig.sped is enabled.
export class RTCDtlsTransport implements DtlsTransportStats {
  readonly config: DtlsTransportConfig;
  readonly iceTransport: RTCIceTransport;
  public localCertificate?: RTCCertificate;
  private readonly srtpProfiles: SrtpProfile[];
  id = randomUUID().toString();
  state: DtlsState = "new";
  role: DtlsRole = "auto";
  /**
   * Internal: the ICE role when the handshake started. werift sets the ICE role at
   * every offer / answer, so an SCTP association that starts later on this
   * transport takes its client / server side from here, as both peers agreed
   * on it when they started DTLS.
   */
  iceRoleAtStart?: RTCIceTransport["role"];
  srtpStarted = false;
  /**
   * Monotonic transport-wide sequence allocated at ICE enqueue time.
   * Never wraps in JS Number. {@link transportSequenceNumber} is the wire
   * 16-bit view (`extended & 0xffff`).
   */
  transportSequenceNumberExtended = 0;
  /** Wire 16-bit TWCC sequence (low bits of {@link transportSequenceNumberExtended}). */
  transportSequenceNumber = 0;

  // Statistics tracking
  public bytesSent = 0;
  public bytesReceived = 0;
  public packetsSent = 0;
  public packetsReceived = 0;

  dataReceiver: (buf: Buffer) => void = () => {};
  dtls?: DtlsSocket;
  srtp!: SrtpSession;
  srtcp!: SrtcpSession;
  lastError?: Error;
  private startPromise?: Promise<void>;
  /** @internal Notifies SCTP that its pre-authenticated early start was revoked. */
  readonly onEarlyApplicationSendRevoked = new Event<[]>();
  /** @internal Cancels pre-established associations owned by an old attempt. */
  readonly onEarlyApplicationAttemptCancelled = new Event<[]>();

  private readonly attempts = new TransportAttempts();
  private readonly readiness: TransportReadiness;
  private readonly srtpAccess = new SrtpAccess();
  private readonly applicationGate: InboundApplicationGate;
  private readonly mediaQueue: PreAuthMediaQueue;
  /**
   * WARP early server output was withdrawn for this attempt (SPED abort,
   * direct DTLS fallback); a new attempt allows it again.
   */
  private earlyModeDisabled = false;
  /** Application data or media left before peer authentication (stats). */
  private earlyServerSendUsed = false;
  private spedTransport?: IceSpedTransport;
  private iceDatagramSubscription?: { unSubscribe(): void };

  readonly onStateChange = new Event<[DtlsState]>();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly onRtp = new Event<[RtpPacket]>();
  /**
   * Fires once when {@link RTCDtlsTransport.stop} has finished, i.e. ICE has
   * stopped too. The DTLS "closed" state alone (e.g. a received alert) does
   * not mean ICE has released its resources.
   */
  readonly onStopped = new Event<[]>();
  private readonly events = new DomEventTarget();
  onstatechange?: () => void;

  /** Process-wide default certificate cache, see {@link RTCDtlsTransport.SetupCertificate}. */
  static localCertificate?: RTCCertificate;
  static localCertificatePromise?: Promise<RTCCertificate>;
  private remoteParameters?: RTCDtlsParameters;

  constructor(
    config: DtlsTransportConfig,
    iceTransport: RTCIceTransport,
    localCertificate?: RTCCertificate,
    srtpProfiles: SrtpProfile[] = [],
  ) {
    this.iceTransport = iceTransport;
    this.localCertificate = localCertificate;
    this.srtpProfiles = srtpProfiles;
    // Keep the transport-local policy independent from the caller's mutable
    // PeerConfig object. setConfiguration() updates this copy explicitly.
    this.config = {
      ...config,
      warp: config.warp ? { ...config.warp } : undefined,
    };
    this.localCertificate ??= RTCDtlsTransport.localCertificate;
    this.readiness = new TransportReadiness({
      onAttemptChanged: this.attempts.onChanged,
      onStateChange: this.onStateChange,
      isTerminated: () => this.isTerminated(),
      lastError: () => this.lastError,
    });
    this.applicationGate = new InboundApplicationGate((data) =>
      this.dataReceiver?.(data),
    );
    this.mediaQueue = new PreAuthMediaQueue(this.bufferEarlyMedia);
    // start() までの到着も落とさないよう、ICE datagram 購読は生成直後に開始
    // する。認証前の到着は gate / mediaQueue 側で保持し、上位へは出さない。
    const ice = this.iceTransport.connection as Connection;
    this.iceDatagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => this.onIceDatagram(ctx),
    );
  }

  /** WARP: the DTLS server may send before the peer is authenticated. */
  private get allowsEarlyServerData(): boolean {
    return this.config.warp?.allowEarlyServerData === true;
  }

  /** WARP: keep (instead of drop) media that arrives before authentication. */
  private get bufferEarlyMedia(): boolean {
    return this.config.warp?.earlyMediaPolicy === "buffer";
  }

  private get liveIceGeneration(): number {
    return (this.iceTransport.connection as Connection).generation;
  }

  /** @internal Update the live WARP policy without leaving a stale snapshot. */
  updateWarpConfig(warp: DtlsTransportConfig["warp"]): void {
    const previousAllowEarlyServerData = this.allowsEarlyServerData;
    const previousPolicy = this.config.warp?.earlyMediaPolicy ?? "drop";
    const nextWarp = {
      allowEarlyServerData: warp?.allowEarlyServerData === true,
      earlyMediaPolicy: warp?.earlyMediaPolicy ?? "drop",
      sendBeforeNomination: warp?.sendBeforeNomination === true,
    } as const;

    this.config.warp = nextWarp;
    this.spedTransport?.setEarlyApplicationSendEnabled(
      nextWarp.allowEarlyServerData,
    );
    this.spedTransport?.setSendBeforeNomination(nextWarp.sendBeforeNomination);
    // Early server send exists only on SPED transports; never revoke (and so
    // never cancel an SCTP start) on the default non-SPED path.
    if (
      isDtlsTransportSped(this) &&
      previousAllowEarlyServerData &&
      !nextWarp.allowEarlyServerData
    ) {
      this.onEarlyApplicationSendRevoked.execute();
    }
    if (previousPolicy !== nextWarp.earlyMediaPolicy) {
      // A policy change invalidates protected media accumulated under the old
      // policy; the old retention timer is disposed with its queue.
      this.mediaQueue.renew(this.bufferEarlyMedia);
    }
    // A live policy change can happen after DTLS 1.3 write-ready.  Re-run the
    // same key-install edge used by markWriteReady so enabling early outbound
    // cannot leave permissions true while SRTP remains unavailable.
    this.ensureEarlySrtpKeys();
    this.updateSrtpPermissions();
  }

  addEventListener = (
    type: string,
    listener: (...args: any[]) => void,
    options?: boolean | { once?: boolean },
  ) => {
    this.events.addEventListener(type, listener, options);
  };

  removeEventListener = (type: string, listener: (...args: any[]) => void) => {
    this.events.removeEventListener(type, listener);
  };

  dispatchEvent = (event: globalThis.Event) => this.events.dispatchEvent(event);

  get localParameters() {
    return new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : [],
      this.role,
    );
  }

  /**
   * Generates a new self-signed certificate (ECDSA P-256 / SHA-256) on every call.
   * Used by an RTCPeerConnection created with `certificateScope: "peerConnection"`
   * when `RTCConfiguration.certificates` is not given.
   */
  static async generateCertificate() {
    return createSelfSignedCertificate();
  }

  /**
   * Returns the default certificate cached for the whole process
   * (the default `certificateScope: "process"`).
   */
  static async SetupCertificate() {
    if (this.localCertificate) {
      return this.localCertificate;
    }

    this.localCertificatePromise ??= this.generateCertificate().then(
      (certificate) => {
        this.localCertificate = certificate;
        return certificate;
      },
    );

    return this.localCertificatePromise;
  }

  setRemoteParams(remoteParameters: RTCDtlsParameters) {
    // A new remote SDP supersedes the previous authentication assertion.
    // Keep alternatives advertised by this SDP, but never let an old
    // fingerprint remain valid across an ICE restart / re-negotiation.
    const fingerprints = deduplicateFingerprints(remoteParameters.fingerprints);
    const role =
      remoteParameters.role === "auto" && this.remoteParameters?.role
        ? this.remoteParameters.role
        : remoteParameters.role;
    this.remoteParameters = new RTCDtlsParameters(fingerprints, role);
    // 接続済み transport に新 fingerprint が来たら現 association の証明書で
    // 再検証する。不一致は旧 SDP に基づく認証状態の残留を許さず失敗させる。
    if (this.readiness.peerAuthenticated && !this.isTerminated()) {
      try {
        this.verifyRemoteCertificateFingerprint();
      } catch (error) {
        this.failAuthenticatedTransport(toError(error));
      }
    }
  }

  /**
   * 認証済み association の事後失敗処理。fingerprint 不一致の再検証など、
   * handshake 完了後に認証が崩れた場合に状態・gate・queue を確実に落とす。
   */
  private failAuthenticatedTransport(error: Error): void {
    this.readiness.revokePeerAuthentication();
    this.enterFailed(error);
    this.releasePreAuthData();
    this.abortSpedSession();
    this.dtls?.close();
  }

  /** Internal: whether a description gave this transport the peer's DTLS parameters. */
  get hasRemoteParameters() {
    return (this.remoteParameters?.fingerprints.length ?? 0) > 0;
  }

  async start() {
    if (this.state === "connected") {
      return;
    }
    if (this.state === "closed") {
      throw new Error("RTCDtlsTransport is closed");
    }
    if (this.state === "failed") {
      throw this.lastError ?? new Error("dtls failed");
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.state !== "new") {
      throw new Error("state must be new");
    }
    if (
      !this.remoteParameters ||
      this.remoteParameters.fingerprints.length === 0
    ) {
      throw new Error("remote fingerprint not exist");
    }

    this.iceRoleAtStart = this.iceTransport.role;
    if (this.role === "auto") {
      if (this.iceTransport.role === "controlling") {
        this.role = "server";
      } else {
        this.role = "client";
      }
    }

    this.setState("connecting");
    this.srtpStarted = true;
    this.startPromise = this.completeHandshake();
    await this.startPromise;
  }

  /** @internal */
  async waitForWriteReady(): Promise<void> {
    if (this.readiness.writeReady) return;
    if (!this.dtls) await Promise.resolve();
    if (!this.dtls) throw new Error("DTLS handshake has not started");
    const attempt = this.attempts.current;
    await this.dtls.waitForWriteReady();
    // The lower socket can finish an old carrier generation after ICE restart.
    // That completion may never re-grant upper-layer permission: only the
    // current attempt's handshake path may call markWriteReady().
    if (attempt && this.isCurrentAttempt(attempt)) {
      this.markWriteReady(attempt);
      return;
    }
    await this.readiness.waitFor("writeReady");
  }

  /** @internal */
  isEarlyServerWriteAllowed(): boolean {
    return this.isEarlyServerOutboundReady();
  }

  /**
   * Single permission boundary for server 0.5-RTT application/media output.
   * Public RTCDtlsTransport instances are deliberately not WARP transports;
   * the marker is installed only by SecureTransportManager for PeerConfig.sped.
   */
  private isEarlyServerOutboundReady(): boolean {
    const attempt = this.attempts.current;
    return (
      isDtlsTransportSped(this) &&
      this.role === "server" &&
      this.allowsEarlyServerData &&
      !this.earlyModeDisabled &&
      this.readiness.writeReady &&
      this.dtls?.isDtls13 === true &&
      attempt !== undefined &&
      this.isCurrentAttempt(attempt)
    );
  }

  /** @internal */
  waitForPeerAuthenticated(): Promise<void> {
    return this.readiness.waitFor("peerAuthenticated");
  }

  /** @internal */
  waitForHandshakeComplete(): Promise<void> {
    return this.readiness.waitFor("handshakeComplete");
  }

  /** @internal Rebind an in-flight direct handshake to the new ICE generation. */
  handleIceRestart(): void {
    this.syncAttemptToIceGeneration();
  }

  /**
   * answerer 側の ICE restart は DTLS への明示通知なしに generation だけが
   * 進む。offerer の明示 restart と datagram 受信時・handshake 待機中の
   * drift 検出を同じ処理にまとめ、旧 attempt の継続を無効化する。
   */
  private syncAttemptToIceGeneration(): void {
    const current = this.attempts.current;
    // start() 前にも authenticated media は mediaQueue に到着し得る。
    // attempt 未発行のまま ICE restart された場合も、旧世代の queue と
    // retention timer を新世代へ持ち越さない。
    if (!current) {
      this.mediaQueue.renew(this.bufferEarlyMedia);
      return;
    }
    if (isDtlsTransportSped(this)) return;

    const generation = this.liveIceGeneration;
    if (generation === current.iceGeneration) return;
    // ここに来るのは SPED でない transport だけで、early 送信は SPED 専用
    // (isEarlyServerOutboundReady) なので early attempt は存在しない。
    // onEarlyApplicationAttemptCancelled を発火すると、確立前の通常 SCTP
    // association まで cancelStart で閉じてしまうため発火しない。
    if (this.state === "connected") {
      // 認証済み association は維持し、新 generation へ attempt を付け替える。
      this.rebindConnectedAttempt(this.attempts.begin(generation));
      return;
    }
    if (this.state !== "connecting") return;
    this.restartConnectingAttempt(generation);
  }

  /**
   * An ICE restart replaced the generation of a handshake that is still
   * connecting. The cryptographic association continues as a new attempt:
   * continuations captured by the previous generation fail the identity
   * check, and the pre-authentication state starts over for the new one.
   */
  private restartConnectingAttempt(generation: number): void {
    // A restart never mutates an in-flight attempt; the owning
    // completeHandshake loop adopts this new immutable token.
    this.attempts.begin(generation);
    // 新 attempt 用に gate を開き直す (旧 drain 残余は呼び出し側が破棄する)。
    this.applicationGate.restartForNewAttempt();
    this.mediaQueue.renew(this.bufferEarlyMedia);
    this.dtls?.clearEarlyDataBuffer();
    this.earlyModeDisabled = false;
    this.readiness.restartAttempt();
    this.srtpAccess.revoke();
  }

  /**
   * SPED: the session restarted for `generation` (ICE restart, or a reset in
   * the same generation). The early attempt is cancelled; a connected
   * association moves to a new attempt, a connecting one starts over.
   */
  private resetSpedGeneration(generation: number): void {
    this.onEarlyApplicationAttemptCancelled.execute();
    this.mediaQueue.renew(this.bufferEarlyMedia);
    this.spedTransport?.setEarlyApplicationSendEnabled(
      this.allowsEarlyServerData,
    );
    this.dtls?.clearEarlyDataBuffer();
    const current = this.attempts.current;
    if (
      this.state === "connected" &&
      current &&
      current.iceGeneration !== generation
    ) {
      // SPED owns the generation reset callback; connected associations
      // still need to rebind upper readiness waiters to the new attempt.
      this.rebindConnectedAttempt(this.attempts.begin(generation));
    }
    if (this.state === "connecting" && this.attempts.current) {
      this.restartConnectingAttempt(generation);
    } else {
      this.applicationGate.discardPending();
    }
  }

  /**
   * SPED: early application data of the current attempt is abandoned (SPED
   * session abort, direct DTLS fallback). Early server output stays off until
   * a new attempt; `revoke` names the SRTP permissions withdrawn now.
   */
  private abandonEarlyApplication(revoke: "read-and-write" | "write"): void {
    this.onEarlyApplicationAttemptCancelled.execute();
    this.earlyModeDisabled = true;
    this.spedTransport?.setEarlyApplicationSendEnabled(false);
    if (revoke === "write") this.srtpAccess.revokeWrite();
    else this.srtpAccess.revoke();
    this.applicationGate.discardPending();
    this.mediaQueue.discard();
    this.dtls?.clearEarlyDataBuffer();
  }

  private async completeHandshake() {
    let attempt = this.attempts.begin(this.liveIceGeneration);
    this.readiness.startHandshake();
    const sped = isDtlsTransportSped(this);
    const addressValidation: AddressValidation = sped
      ? "ice-authenticated"
      : this.config.helloRetryRequest
        ? "dtls-cookie"
        : "ice-authenticated";

    if (sped) {
      await this.startWithSped(addressValidation);
    } else {
      await this.startSerial(addressValidation);
    }

    // An ICE restart can retain the cryptographic association while changing
    // its carrier generation.  Every authentication/drain phase is therefore
    // owned by an immutable attempt.  If a callback restarts the ICE
    // generation, abandon only the old phase and run the phase again for the
    // new attempt before allowing start() to resolve.
    while (true) {
      // answerer 側の restart では generation drift をここで吸収し、旧 attempt
      // での無限待機を防ぐ (SPED は runtime 側が所有するため対象外)。
      this.syncAttemptToIceGeneration();
      if (!this.isCurrentAttempt(attempt)) {
        if (this.isTerminated()) return;
        const current = this.attempts.current;
        if (!current) return;
        attempt = current;
        continue;
      }
      await this.dtls?.waitForPeerHandshakeAuthenticated();
      if (!this.isCurrentAttempt(attempt)) continue;
      if (this.dtls?.readiness.writeReady) this.markWriteReady(attempt);

      try {
        this.verifyRemoteCertificateFingerprint();
      } catch (error) {
        this.failAuthenticatedTransport(toError(error));
        throw error;
      }

      if (!this.isCurrentAttempt(attempt)) continue;
      if (this.state !== "connecting") return;
      this.readiness.authenticatePeer();
      if (this.srtpProfiles.length > 0) {
        this.installSrtpKeys();
        this.updateSrtpPermissions();
        this.drainMediaBuffer(attempt);
        // drain 中の close/restart では認証確定へ進まず、新 attempt で
        // readiness と保留データの処理をやり直す。
        if (!this.isCurrentAttempt(attempt)) continue;
        if (this.state !== "connecting") return;
      }
      this.applicationGate.authenticate(
        () => this.isCurrentAttempt(attempt) && this.state === "connecting",
        () => this.isTerminated(),
      );
      // deliver callback 内の restart は start() を成功扱いにせず、次の
      // attempt が同じ association の認証完了処理を引き継ぐ。
      if (!this.isCurrentAttempt(attempt)) continue;
      if (this.state !== "connecting") return;
      this.setState("connected");
      // state callback 内の restart/close で attempt が変わり得るため、通知直前に再検証する。
      if (!this.isCurrentAttempt(attempt)) {
        if (this.isTerminated()) return;
        // connected association の restart は rebindConnectedAttempt() が
        // readiness waiter と DTLS 完了待機を新 attempt へ引き継いだ。
        if (this.attempts.current) {
          this.bindHandshakeCompletion(this.attempts.current);
          return;
        }
        continue;
      }
      if (this.isTerminated()) return;
      this.readiness.announcePeerAuthenticated();
      this.bindHandshakeCompletion(attempt);

      log("dtls connected");
      return;
    }
  }

  private isCurrentAttempt(attempt: TransportAttempt): boolean {
    if (this.isTerminated()) return false;
    return this.attempts.isCurrent(attempt, this.liveIceGeneration);
  }

  /**
   * Keep a connected association's readiness waiters attached after ICE
   * restart. The cryptographic association remains valid, so the readiness
   * latch is preserved; only callbacks that captured the old attempt need a
   * new identity-bound continuation.
   */
  private rebindConnectedAttempt(attempt: TransportAttempt): void {
    if (!this.isCurrentAttempt(attempt) || this.isTerminated()) return;
    // SPED abort invalidates both SRTP permissions.  A connected association
    // remains cryptographically authenticated across ICE restart, so the new
    // attempt must explicitly re-evaluate those permissions after the path is
    // rebound instead of leaving media permanently disabled.
    this.updateSrtpPermissions();
    this.bindHandshakeCompletion(attempt);
    // Do not re-fire onPeerAuthenticated/onHandshakeComplete here: those are
    // one-shot notifications. Re-evaluate only waiters registered before the
    // restart, which otherwise have no event edge after their attempt drifted.
  }

  /** Attach the lower DTLS completion latch to the current transport attempt. */
  private bindHandshakeCompletion(attempt: TransportAttempt): void {
    if (this.readiness.handshakeComplete) return;
    const dtls = this.dtls;
    if (!dtls || !this.attempts.claimHandshakeWait(attempt)) return;

    if (dtls.readiness.handshakeComplete) {
      this.markHandshakeComplete(attempt);
      return;
    }
    void dtls.waitForHandshakeComplete().then(
      () => this.markHandshakeComplete(attempt),
      () => {
        // Terminal state is surfaced by the DTLS socket state bridge.
      },
    );
  }

  private markHandshakeComplete(attempt: TransportAttempt): void {
    if (!this.isCurrentAttempt(attempt) || this.isTerminated()) return;
    this.readiness.reachHandshakeComplete();
  }

  private markWriteReady(attempt?: TransportAttempt): void {
    const current = attempt ?? this.attempts.current;
    if (!current || !this.isCurrentAttempt(current)) return;
    this.readiness.reachWriteReady(() => {
      this.spedTransport?.markApplicationWriteReady();
      this.ensureEarlySrtpKeys();
      this.updateSrtpPermissions();
    });
  }

  private ensureEarlySrtpKeys(): void {
    if (this.srtpProfiles.length > 0 && this.isEarlyServerOutboundReady()) {
      this.installSrtpKeys();
    }
  }

  /** Options every DTLS socket of this transport shares. */
  private dtlsSocketOptions(addressValidation: AddressValidation) {
    return {
      cert: this.localCertificate?.certPem,
      key: this.localCertificate?.privateKey,
      signatureHash: this.localCertificate?.signatureHash,
      srtpProfiles: this.srtpProfiles,
      extendedMasterSecret: true,
      // The association owns version selection. SPED carries the 1.3
      // candidate while a negotiated 1.2 candidate commits to direct DTLS.
      protocolVersions: this.config.protocolVersions,
      peerIdentityMode: "authenticated-single-peer" as const,
      addressValidation,
    };
  }

  private async startSerial(addressValidation: AddressValidation) {
    await new Promise<void>(async (resolve, reject) => {
      const options = {
        ...this.dtlsSocketOptions(addressValidation),
        transport: createIceTransport(this.iceTransport.connection),
      };
      this.dtls =
        this.role === "server"
          ? new DtlsServer({ ...options, certificateRequest: true })
          : new DtlsClient(options);
      this.bindDtlsSocketEvents(resolve, reject);

      if (this.dtls instanceof DtlsClient) {
        await setTimeout(100);
        this.dtls.connect().catch((error) => this.failStart(error, reject));
      }
    });
  }

  private startWithSped(addressValidation: AddressValidation) {
    return runSpedHandshake({
      connection: this.iceTransport.connection as Connection,
      allowsEarlyServerData: () => this.allowsEarlyServerData,
      sendsBeforeNomination: () =>
        this.config.warp?.sendBeforeNomination === true,
      state: () => this.state,
      adoptSpedTransport: (transport) => {
        this.spedTransport = transport;
      },
      createSocket: (transport, carrier, resolve, reject) => {
        const options = {
          ...this.dtlsSocketOptions(addressValidation),
          transport,
          handshakeCarrier: carrier,
        };
        const socket =
          this.role === "server"
            ? createDtlsServerInternal({ ...options, certificateRequest: true })
            : createDtlsClientInternal(options);
        this.dtls = socket;
        this.bindDtlsSocketEvents(resolve, reject);
        return socket;
      },
      failStart: (error, reject) => this.failStart(error, reject),
      resetForGeneration: (generation) => this.resetSpedGeneration(generation),
      abandonEarlyApplication: (revoke) => this.abandonEarlyApplication(revoke),
      endEarlyServerMode: () => {
        this.earlyModeDisabled = true;
      },
      markWriteReady: () => this.markWriteReady(),
    });
  }

  /** connect() of the DTLS client failed: the start fails with `error`. */
  private failStart(error: Error, reject: (error: Error) => void): void {
    // stop()/close() 後の遅延失敗で closed を failed へ上書きしない。
    if (this.isTerminated()) return;
    // ICE restart で attempt を付け替えても DTLS socket は同じで、
    // connect() をやり直す経路はない。失敗を捨てると start() が
    // 終わらないため、attempt に関係なく現在の失敗として扱う。
    this.enterFailed(error);
    this.abortSpedSession();
    log("dtls connect failed", error);
    reject(error);
  }

  private bindDtlsSocketEvents(
    resolve: () => void,
    reject: (error: Error) => void,
  ) {
    if (!this.dtls) {
      return;
    }
    // engine RX queue の stale 実行を世代で遮断する (ICE restart race)。
    // 対象は世代ごとに注入される SPED carrier だけ。非 SPED では restart を
    // またいでも同じ DTLS association の datagram なので遮断しない (warp と同じ)。
    if (isDtlsTransportSped(this)) {
      this.dtls.setExpectedRxGeneration(() => this.liveIceGeneration);
    }
    this.dtls.onData.subscribe((buf) => {
      if (this.dropForDebug("inbound")) return;
      // restart 後に engine queue から遅延配送された旧世代 data は gate に入れない。
      if (!this.isFreshApplicationReceive()) return;
      this.applicationGate.receive(buf);
    });
    this.dtls.onClose.subscribe(() => {
      // 全 close 経路で送信許可を解除し、close 後の SRTP/SRTCP 送信を防ぐ。
      this.srtpAccess.revoke();
      if (this.state === "connecting") {
        this.abortSpedSession();
        this.discardUnauthenticatedData();
      }
      if (this.state !== "failed") {
        this.setState("closed");
      }
      // onClose may be the only terminal edge observed by the start wrapper
      // (notably when stop() closes a handshake before onConnect).  Reject it
      // so every caller awaiting the shared startPromise is released.
      reject(
        this.lastError ??
          new Error("DTLS transport closed before start completed"),
      );
    });
    this.dtls.onConnect.once(resolve);
    // Reflect the core's write readiness (DTLS 1.3 server: after its own
    // Finished) as soon as it exists, independent of SCTP. Media-only early
    // server sends depend on it; the permission itself is still decided by
    // updateSrtpPermissions() (peer authentication or the early-server policy).
    this.waitForWriteReady().catch((error) => {
      // close / failure is reported by the handshake path above.
      log("core write readiness not reached", error);
    });
    this.dtls.onError.once((error) => {
      this.enterFailed(error);
      this.abortSpedSession();
      this.discardUnauthenticatedData();
      log("dtls failed", error);
      reject(error);
    });
  }

  /** Enter "failed" with `error`; media permissions end with it. */
  private enterFailed(error: Error): void {
    this.lastError = error;
    this.srtpAccess.revoke();
    this.setState("failed");
  }

  private abortSpedSession() {
    const ice = this.iceTransport.connection as Connection;
    getConnectionSpedRuntime(ice)?.abort();
  }

  /** Drop every application / media record held for authentication, for good. */
  private releasePreAuthData(): void {
    this.applicationGate.abort();
    this.mediaQueue.close();
  }

  /** {@link releasePreAuthData}, unless the peer was already authenticated. */
  private discardUnauthenticatedData(): void {
    if (this.readiness.peerAuthenticated) return;
    this.releasePreAuthData();
  }

  /**
   * engine から届いた application data を gate へ入れてよいか判定する。
   * connecting 中の旧 attempt 由来や close/failed 後の遅延配送を遮断する。
   * connected 中の answerer restart はここで attempt を付け替えて継続する。
   */
  private isFreshApplicationReceive(): boolean {
    if (this.isTerminated()) return false;
    const generation = this.liveIceGeneration;
    if (this.state === "connected") {
      this.syncConnectedAttempt();
      const synced = this.attempts.current;
      if (!synced) return false;
      return generation === synced.iceGeneration;
    }
    const current = this.attempts.current;
    if (!current) return true;
    return generation === current.iceGeneration;
  }

  private verifyRemoteCertificateFingerprint() {
    verifyRemoteCertificateFingerprint(
      this.remoteParameters?.fingerprints,
      this.dtls?.remoteCertificate,
    );
  }

  updateSrtpSession() {
    this.installSrtpKeys();
  }

  private installSrtpKeys() {
    if (this.srtpAccess.keysInstalled) return;
    if (!this.dtls) throw new Error();
    const { srtp, srtcp } = this.srtpAccess.installKeys(this.dtls);
    this.srtp = srtp;
    this.srtcp = srtcp;
  }

  startSrtp() {
    this.srtpStarted = true;
    this.installSrtpKeys();
    this.updateSrtpPermissions();
  }

  /** Key availability never grants media access by itself. */
  private updateSrtpPermissions() {
    this.srtpAccess.update({
      peerAuthenticated: this.readiness.peerAuthenticated,
      earlyServerWriteAllowed: this.isEarlyServerOutboundReady(),
    });
  }

  /**
   * ICE datagram 受信層の media 処理。購読は constructor 時に開始済みのため、
   * DTLS `start()` 前に届いた early RTP/RTCP もここで保持する。認証前の到着
   * は encrypted のまま buffer/drop し、復号・配送は fingerprint 認証後だけ。
   */
  private onIceDatagram(ctx: IceDatagramContext): void {
    if (this.dropForDebug("inbound")) return;

    // 旧 generation・close 後・未認証 pair の media は配送も buffer もしない。
    if (this.isTerminated()) return;
    this.syncConnectedAttempt();
    const current = this.attempts.current;
    if (ctx.generation !== this.liveIceGeneration) return;
    // ICE restart 後も相手が新 pair へ移るまでは、旧世代の選択 pair の media を
    // 受け付ける (RFC 8445 §9)。DTLS の認証経路には使わない。
    if (!ctx.fromPreviousSelectedPair) {
      if (!ctx.authenticated || !ctx.pair) return;
      if (ctx.protocol !== ctx.pair.protocol) return;
      const remote = ctx.pair.remoteAddr;
      if (ctx.source[0] !== remote[0] || ctx.source[1] !== remote[1]) return;
    }

    const data = ctx.bytes;
    if (!isMedia(data)) return;
    this.recordReceived(data.length);

    if (!this.srtpAccess.canRead) {
      // handshake 開始前 (attempt 未発行) の pre-auth media は現世代に
      // 限り buffer し、配送は認証後の drain に委ねる。
      if (current && !this.isCurrentAttempt(current)) return;
      if (current && ctx.generation !== current.iceGeneration) return;
      this.mediaQueue.push(data);
      return;
    }

    // 配送は現 attempt のみに限定し、close/restart 後の旧 queue は扱わない。
    if (!current || !this.isCurrentAttempt(current)) return;
    if (ctx.generation !== current.iceGeneration) return;
    this.handleMediaPacket(data, current);
  }

  private handleMediaPacket(data: Buffer, attempt: TransportAttempt) {
    if (!this.canDeliverMedia(attempt)) return;
    if (isRtcp(data)) {
      const rtcpPackets = decryptRtcp(this.srtcp, data);
      if (!rtcpPackets) return;
      for (const rtcp of rtcpPackets) {
        // 1つの SRTCP datagram に複数 packet が含まれる場合も、先頭の
        // callback 内の close/restart/fingerprint failure を直ちに反映する。
        if (!this.canDeliverMedia(attempt)) return;
        try {
          this.onRtcp.execute(rtcp);
        } catch (error) {
          log("RTCP error", error);
        }
      }
    } else {
      const rtp = decryptRtp(this.srtp, data);
      if (!rtp) return;
      if (!this.canDeliverMedia(attempt)) return;
      try {
        this.onRtp.execute(rtp);
      } catch (error) {
        log("RTP error", error);
      }
    }
  }

  /** Deliver media queued before authentication while `attempt` stays current. */
  private drainMediaBuffer(attempt: TransportAttempt) {
    // 各要素配送前と配送後に attempt/state を再検証し、close/restart で中断する。
    this.mediaQueue.drain(
      (data) => this.handleMediaPacket(data, attempt),
      () => this.canDeliverMedia(attempt),
    );
  }

  private canDeliverMedia(attempt: TransportAttempt): boolean {
    return (
      this.srtpAccess.canRead &&
      !this.isTerminated() &&
      this.isCurrentAttempt(attempt)
    );
  }

  private isTerminated(): boolean {
    const state: DtlsState = this.state;
    return state === "closed" || state === "failed";
  }

  /**
   * answerer 側の ICE restart は DTLS への明示通知なしに generation だけが
   * 進む。認証済み association は維持し、新 generation へ attempt を付け替える。
   * queue 破棄を伴わないため SPED でも共通に扱える。
   */
  private syncConnectedAttempt(): void {
    const current = this.attempts.current;
    if (this.state !== "connected" || !current) return;
    const generation = this.liveIceGeneration;
    if (generation !== current.iceGeneration) {
      this.rebindConnectedAttempt(this.attempts.begin(generation));
    }
  }

  /** `config.debug` packet loss simulation for `direction`. */
  private dropForDebug(direction: "inbound" | "outbound"): boolean {
    const loss =
      direction === "inbound"
        ? this.config.debug?.inboundPacketLoss
        : this.config.debug?.outboundPacketLoss;
    return !!loss && loss / 100 < Math.random();
  }

  /** Record that output left before the peer was authenticated (stats). */
  private noteEarlyServerSend(): void {
    if (!this.readiness.peerAuthenticated) this.earlyServerSendUsed = true;
  }

  private recordSent(size: number): void {
    this.bytesSent += size;
    this.packetsSent++;
  }

  private recordReceived(size: number): void {
    this.bytesReceived += size;
    this.packetsReceived++;
  }

  readonly sendData = async (data: Buffer) => {
    if (this.dropForDebug("outbound")) return;

    if (!this.dtls) {
      throw new Error("dtls not established");
    }
    if (
      !this.readiness.peerAuthenticated &&
      !this.isEarlyServerOutboundReady()
    ) {
      throw new SCTPSendPermissionRevokedError(
        "DTLS peer is not authenticated",
      );
    }
    this.noteEarlyServerSend();
    await this.dtls.send(data);
  };

  /**
   * Allocate the next transport-wide sequence at send time.
   * Call immediately before DTLS/ICE enqueue so BUNDLE senders cannot
   * reserve a TSN then wait in a per-sender pacer.
   */
  allocateTransportWideSequence(): { wire: number; extended: number } {
    const wireNow = this.transportSequenceNumber & 0xffff;
    if ((this.transportSequenceNumberExtended & 0xffff) !== wireNow) {
      const gen = Math.floor(this.transportSequenceNumberExtended / 0x10000);
      this.transportSequenceNumberExtended = gen * 0x10000 + wireNow;
    }
    this.transportSequenceNumberExtended += 1;
    this.transportSequenceNumber =
      this.transportSequenceNumberExtended & 0xffff;
    return {
      wire: this.transportSequenceNumber,
      extended: this.transportSequenceNumberExtended,
    };
  }

  /**
   * Encrypt RTP and enqueue on ICE. Returns on-wire size.
   * Send-time metadata: {@link sendRtpWithMeta}.
   */
  async sendRtp(payload: Buffer, header: RtpHeader): Promise<number> {
    const { size } = await this.sendRtpWithMeta(payload, header);
    return size;
  }

  /**
   * Encrypt RTP and enqueue on ICE, capturing the clock immediately before
   * the ICE write (RFC 8888). Prefer {@link sendRtp} unless send time is needed.
   */
  async sendRtpWithMeta(
    payload: Buffer,
    header: RtpHeader,
  ): Promise<DtlsSendRtpResult> {
    try {
      if (this.isTerminated() || !this.srtpAccess.canWrite) {
        return { size: 0, sendingAtMs: milliTime() };
      }
      this.noteEarlyServerSend();
      const enc = this.srtp.encrypt(payload, header);

      if (this.dropForDebug("outbound")) {
        return { size: enc.length, sendingAtMs: milliTime() };
      }

      const sendingAtMs = milliTime();
      await this.sendProtectedMedia(enc);
      // 実際の wire 送信が成功した後だけ統計を更新する。SPED の early
      // path は authenticated pair 待ちで reject することがある。
      this.recordSent(enc.length);
      return { size: enc.length, sendingAtMs };
    } catch (error) {
      log("failed to send", error);
      return { size: 0, sendingAtMs: milliTime() };
    }
  }

  async sendRtcp(packets: RtcpPacket[]): Promise<number> {
    if (this.isTerminated() || !this.srtpAccess.canWrite) return 0;
    this.noteEarlyServerSend();
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    const enc = this.srtcp.encrypt(payload);

    if (this.dropForDebug("outbound")) {
      return enc.length;
    }

    try {
      await this.sendProtectedMedia(enc);
      // 実際の wire 送信が成功した後だけ統計を更新する。
      this.recordSent(enc.length);
      return enc.length;
    } catch (error) {
      log("failed to send RTCP", error);
      return 0;
    }
  }

  private async sendProtectedMedia(data: Buffer) {
    if (this.spedTransport) {
      // メディア統計は実 wire 送信後に更新するため、nomination/consent
      // 前はキューが実際に flush されるまで待機する。
      await this.spedTransport.sendMediaAndWait(data);
      return;
    }
    // Connection.send() intentionally keeps its compatibility no-op contract
    // when ICE consent is unavailable. Media must not turn that no-op into a
    // successful SRTP send or a misleading transport statistic.
    if (!this.iceTransport.connection.canSendApplicationData()) {
      throw new Error("ICE application path is not ready");
    }
    await this.iceTransport.connection.send(data);
  }

  /**
   * Stats-only remote certificate. The DTLS socket throws if the association
   * is torn down, so skip the getter unless this transport is connected.
   * Unexpected throws while connected are left to propagate.
   */
  private remoteCertificateForStats() {
    if (!this.dtls || this.state !== "connected") {
      return;
    }
    return this.dtls.remoteCertificate;
  }

  private setState(state: DtlsState, emitEvent = true) {
    if (state != this.state) {
      this.state = state;
      this.onStateChange.execute(state);
      if (emitEvent) {
        this.onstatechange?.();
        this.events.emit("statechange");
      }
    }
  }

  private stopPromise?: Promise<void>;

  /** Resolves once ICE has stopped; concurrent callers share one stop. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Publish the shared promise before runStop() notifies "closed": a
    // subscriber that re-enters stop() must get this same promise.
    let settle!: (stopping: Promise<void>) => void;
    this.stopPromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    settle(this.runStop());
    return this.stopPromise;
  }

  private async runStop() {
    try {
      // 旧 attempt の callback・drain が再開しないよう先に無効化する。
      this.attempts.invalidate();
      this.iceDatagramSubscription?.unSubscribe();
      this.iceDatagramSubscription = undefined;
      this.srtpAccess.revoke();
      this.setState("closed", false);
      this.releasePreAuthData();
      // DTLS engine の early queue・pending flight・再送 timer を破棄する。
      try {
        this.dtls?.close();
      } catch (error) {
        log("dtls close failed", error);
      }
      await this.iceTransport.stop();
    } finally {
      // SPED transport の ICE datagram / state 購読を解放し、保留中の early
      // 送信を reject する。close_notify を拒否しないよう ICE 停止の後に閉じる。
      const spedTransport = this.spedTransport;
      this.spedTransport = undefined;
      await spedTransport
        ?.close()
        .catch((error) => log("sped transport close failed", error));
      this.onStopped.execute();
      this.onStopped.complete();
    }
  }

  async getStats(timestamp = getStatsTimestamp()): Promise<RTCStats[]> {
    const { transportId, stats } = buildDtlsTransportStats(
      {
        id: this.id,
        state: this.state,
        role: this.role,
        iceTransport: this.iceTransport,
        dtls: this.dtls,
        localCertificate: this.localCertificate,
        remoteCertificate: this.remoteCertificateForStats(),
        remoteFingerprints: this.remoteParameters?.fingerprints,
        bytesSent: this.bytesSent,
        bytesReceived: this.bytesReceived,
        packetsSent: this.packetsSent,
        packetsReceived: this.packetsReceived,
        applicationQueue: this.applicationGate.snapshot(),
        mediaQueue: this.mediaQueue.snapshot(),
        handshakeStartedAt: this.readiness.handshakeStartedAt,
        peerAuthenticatedAt: this.readiness.peerAuthenticatedAt,
        earlyServerSendUsed: this.earlyServerSendUsed,
        preNominationSendUsed:
          this.spedTransport?.preNominationSendUsed ?? false,
      },
      timestamp,
    );

    // Get ICE stats
    const iceStats = await this.iceTransport.getStats(timestamp, transportId);
    stats.push(...iceStats);

    return stats;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
