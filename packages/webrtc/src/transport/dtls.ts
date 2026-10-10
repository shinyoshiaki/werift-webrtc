import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import { Event } from "../imports/common";

import { DirectHandshakeCarrier } from "../../../dtls/src/carrier/direct";
import {
  type EarlyDataBuffer,
  createDtlsClientInternal,
  createDtlsServerInternal,
  createPreAuthEarlyDataBuffer,
  refragmentPendingFlightIfNeeded,
} from "../../../dtls/src/internal";
import type { Connection } from "../../../ice/src";
import {
  type IceDatagramContext,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import { attachSpedToConnection } from "../../../ice/src/internal/sped";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { EventTarget as DomEventTarget } from "../helper";
import { DtlsClient, DtlsServer, type DtlsSocket } from "../imports/dtls";
import {
  type RtcpPacket,
  type RtpHeader,
  type RtpPacket,
  type SrtcpSession,
  type SrtpProfile,
  type SrtpSession,
  debug,
  isMedia,
  isRtcp,
} from "../imports/rtp";
import { type RTCStats, getStatsTimestamp } from "../media/stats";
import { InboundApplicationGate } from "./dtls-application-gate";
import {
  type RTCCertificate,
  RTCDtlsParameters,
  createSelfSignedCertificate,
} from "./dtls-certificate";
import {
  deduplicateFingerprints,
  verifyRemoteCertificateFingerprint,
} from "./dtls-fingerprint";
import { createIceTransport } from "./dtls-ice-transport";
import { isDtlsTransportSped } from "./dtls-sped";
import { createSrtpSessions, decryptRtcp, decryptRtp } from "./dtls-srtp";
import { buildDtlsTransportStats } from "./dtls-stats";
import type {
  DtlsRole,
  DtlsState,
  DtlsTransportConfig,
  DtlsTransportStats,
  TransportAttempt,
  WebRtcDtlsReadiness,
} from "./dtls-types";
import type { RTCIceTransport } from "./ice";
import { IceSpedTransport } from "./sped";

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

export class RTCDtlsTransport implements DtlsTransportStats {
  readonly config: DtlsTransportConfig;
  id = randomUUID().toString();
  state: DtlsState = "new";
  role: DtlsRole = "auto";
  srtpStarted = false;
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
  private readiness: WebRtcDtlsReadiness = {
    writeReady: false,
    peerAuthenticated: false,
    handshakeComplete: false,
  };
  private readonly onWriteReady = new Event<[]>();
  private readonly onPeerAuthenticated = new Event<[]>();
  private readonly onHandshakeComplete = new Event<[]>();
  /** @internal Notifies SCTP that its pre-authenticated early start was revoked. */
  readonly onEarlyApplicationSendRevoked = new Event<[]>();
  /** @internal Cancels pre-established associations owned by an old attempt. */
  readonly onEarlyApplicationAttemptCancelled = new Event<[]>();
  /** Wakes readiness waiters when a connected association adopts a new attempt. */
  private readonly onAttemptChanged = new Event<[]>();
  private readonly applicationGate: InboundApplicationGate;
  private mediaBuffer: EarlyDataBuffer;
  private retiredMediaDroppedPackets = 0;
  private retiredMediaDroppedBytes = 0;
  private srtpKeysInstalled = false;
  private srtpWriteReady = false;
  private srtpReadReady = false;
  private mediaListenerStarted = false;
  private attemptCounter = 0;
  private currentAttempt?: TransportAttempt;
  private handshakeStartedAt?: number;
  private peerAuthenticatedAt?: number;
  private handshakeWaitAttemptId?: number;
  private earlyServerSendUsed = false;
  private earlyModeDisabled = false;
  private spedTransport?: IceSpedTransport;
  private iceDatagramSubscription?: { unSubscribe(): void };

  readonly onStateChange = new Event<[DtlsState]>();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly onRtp = new Event<[RtpPacket]>();
  private readonly events = new DomEventTarget();
  onstatechange?: () => void;

  static localCertificate?: RTCCertificate;
  static localCertificatePromise?: Promise<RTCCertificate>;
  private remoteParameters?: RTCDtlsParameters;

  constructor(
    config: DtlsTransportConfig,
    readonly iceTransport: RTCIceTransport,
    public localCertificate?: RTCCertificate,
    private readonly srtpProfiles: SrtpProfile[] = [],
  ) {
    // Keep the transport-local policy independent from the caller's mutable
    // PeerConfig object. setConfiguration() updates this copy explicitly.
    this.config = {
      ...config,
      warp: config.warp ? { ...config.warp } : undefined,
    };
    this.localCertificate ??= RTCDtlsTransport.localCertificate;
    this.applicationGate = new InboundApplicationGate((data) =>
      this.dataReceiver?.(data),
    );
    this.mediaBuffer = createPreAuthEarlyDataBuffer({
      enabled: this.config.warp?.earlyMediaPolicy === "buffer",
    });
    // start() までの到着も落とさないよう、ICE datagram 購読は生成直後に開始
    // する。認証前の到着は gate / mediaBuffer 側で保持し、上位へは出さない。
    const ice = this.iceTransport.connection as Connection;
    this.iceDatagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => this.onIceDatagram(ctx),
    );
  }

  /** @internal Update the live WARP policy without leaving a stale snapshot. */
  updateWarpConfig(warp: DtlsTransportConfig["warp"]): void {
    const previousAllowEarlyServerData =
      this.config.warp?.allowEarlyServerData === true;
    const nextWarp = {
      allowEarlyServerData: warp?.allowEarlyServerData === true,
      earlyMediaPolicy: warp?.earlyMediaPolicy ?? "drop",
    } as const;
    const previousPolicy = this.config.warp?.earlyMediaPolicy ?? "drop";

    this.config.warp = nextWarp;
    this.spedTransport?.setEarlyApplicationSendEnabled(
      nextWarp.allowEarlyServerData,
    );
    if (previousAllowEarlyServerData && !nextWarp.allowEarlyServerData) {
      this.onEarlyApplicationSendRevoked.execute();
    }
    if (previousPolicy !== nextWarp.earlyMediaPolicy) {
      // A policy change invalidates protected media accumulated under the old
      // policy. Dispose the old retention timer before replacing the queue.
      this.replaceMediaBuffer();
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

  static async SetupCertificate() {
    if (this.localCertificate) {
      return this.localCertificate;
    }

    if (this.localCertificatePromise) {
      return this.localCertificatePromise;
    }

    this.localCertificatePromise = (async () => {
      this.localCertificate = await createSelfSignedCertificate();
      return this.localCertificate;
    })();

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
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
        this.failAuthenticatedTransport();
      }
    }
  }

  /**
   * 認証済み association の事後失敗処理。fingerprint 不一致の再検証など、
   * handshake 完了後に認証が崩れた場合に状態・gate・queue を確実に落とす。
   */
  private failAuthenticatedTransport(): void {
    this.readiness.peerAuthenticated = false;
    this.peerAuthenticatedAt = undefined;
    this.srtpReadReady = false;
    this.srtpWriteReady = false;
    this.setState("failed");
    this.applicationGate.abort();
    this.mediaBuffer.clear(true);
    this.mediaBuffer.dispose();
    this.abortSpedSession();
    this.dtls?.close();
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

    if (this.role === "auto") {
      if (this.iceTransport.role === "controlling") {
        this.role = "server";
      } else {
        this.role = "client";
      }
    }

    this.setState("connecting");
    this.bindMediaListener();
    this.startPromise = this.completeHandshake();
    await this.startPromise;
  }

  /** @internal */
  async waitForWriteReady(): Promise<void> {
    if (this.readiness.writeReady) return;
    if (!this.dtls) await Promise.resolve();
    if (!this.dtls) throw new Error("DTLS handshake has not started");
    const attempt = this.currentAttempt;
    await this.dtls.waitForWriteReady();
    // The lower socket can finish an old carrier generation after ICE restart.
    // That completion may never re-grant upper-layer permission: only the
    // current attempt's handshake path may call markWriteReady().
    if (attempt && this.isCurrentAttempt(attempt)) {
      this.markWriteReady(attempt);
      return;
    }
    if (this.readiness.writeReady) return;
    await this.waitForCurrentWriteReady();
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
    const attempt = this.currentAttempt;
    return (
      isDtlsTransportSped(this) &&
      this.role === "server" &&
      this.config.warp?.allowEarlyServerData === true &&
      !this.earlyModeDisabled &&
      this.readiness.writeReady &&
      this.dtls?.isDtls13 === true &&
      attempt !== undefined &&
      this.isCurrentAttempt(attempt)
    );
  }

  /** @internal */
  waitForPeerAuthenticated(): Promise<void> {
    return this.waitForWebRtcMilestone(
      () => this.readiness.peerAuthenticated,
      this.onPeerAuthenticated,
    );
  }

  /** @internal */
  waitForHandshakeComplete(): Promise<void> {
    return this.waitForWebRtcMilestone(
      () => this.readiness.handshakeComplete,
      this.onHandshakeComplete,
    );
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
    // start() 前にも authenticated media は mediaBuffer に到着し得る。
    // attempt 未発行のまま ICE restart された場合も、旧世代の queue と
    // retention timer を新世代へ持ち越さない。
    if (!this.currentAttempt) {
      this.resetMediaBufferForNewAttempt();
      return;
    }
    if (isDtlsTransportSped(this)) return;

    const generation = (this.iceTransport.connection as Connection).generation;
    if (generation === this.currentAttempt.iceGeneration) return;
    if (this.state === "connected") {
      // 認証済み association は維持し、新 generation へ attempt を付け替える。
      this.onEarlyApplicationAttemptCancelled.execute();
      this.rebindConnectedAttempt(this.beginAttempt(generation));
      return;
    }
    if (this.state !== "connecting") return;

    // A restart never mutates an in-flight attempt.  Continuations captured
    // by the previous generation must fail the identity check below.
    this.onEarlyApplicationAttemptCancelled.execute();
    this.beginAttempt(generation);
    // 新 attempt 用に gate を開き直す (旧 drain 残余は呼び出し側が破棄する)。
    this.applicationGate.restartForNewAttempt();
    this.resetMediaBufferForNewAttempt();
    this.dtls?.clearEarlyDataBuffer();
    this.readiness.writeReady = false;
    this.srtpWriteReady = false;
    this.srtpReadReady = false;
    this.handshakeStartedAt = Date.now();
    this.peerAuthenticatedAt = undefined;
  }

  private waitForWebRtcMilestone(
    reached: () => boolean,
    event: Event<[]>,
  ): Promise<void> {
    if (reached()) return Promise.resolve();
    if (this.state === "failed" || this.state === "closed") {
      return Promise.reject(
        this.lastError ?? new Error("DTLS transport closed before readiness"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const ready = event.subscribe(() => {
        cleanup();
        resolve();
      });
      const attempt = this.onAttemptChanged.subscribe(() => {
        if (!reached()) return;
        cleanup();
        resolve();
      });
      const state = this.onStateChange.subscribe((next) => {
        if (next !== "failed" && next !== "closed") return;
        cleanup();
        reject(
          this.lastError ?? new Error("DTLS transport closed before readiness"),
        );
      });
      const cleanup = () => {
        ready.unSubscribe();
        attempt.unSubscribe();
        state.unSubscribe();
      };
      if (reached()) {
        cleanup();
        resolve();
      }
    });
  }

  /** Wait for the current attempt's upper write-ready edge after a drift. */
  private waitForCurrentWriteReady(): Promise<void> {
    if (this.readiness.writeReady) return Promise.resolve();
    if (this.state === "failed" || this.state === "closed") {
      return Promise.reject(
        this.lastError ??
          new Error("DTLS transport closed before write readiness"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const ready = this.onWriteReady.subscribe(() => {
        if (!this.readiness.writeReady) return;
        cleanup();
        resolve();
      });
      const attempt = this.onAttemptChanged.subscribe(() => {
        if (!this.readiness.writeReady) return;
        cleanup();
        resolve();
      });
      const state = this.onStateChange.subscribe((next) => {
        if (next !== "failed" && next !== "closed") return;
        cleanup();
        reject(
          this.lastError ??
            new Error("DTLS transport closed before write readiness"),
        );
      });
      const cleanup = () => {
        ready.unSubscribe();
        attempt.unSubscribe();
        state.unSubscribe();
      };
      if (this.readiness.writeReady) {
        cleanup();
        resolve();
      }
    });
  }

  private async completeHandshake() {
    let attempt = this.beginAttempt(
      (this.iceTransport.connection as Connection).generation,
    );
    this.handshakeStartedAt = Date.now();
    const sped = isDtlsTransportSped(this);
    const addressValidation = sped
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
        const current = this.currentAttempt;
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
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
        this.failAuthenticatedTransport();
        throw error;
      }

      if (!this.isCurrentAttempt(attempt)) continue;
      if (this.state !== "connecting") return;
      this.readiness.peerAuthenticated = true;
      this.peerAuthenticatedAt = Date.now();
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
        if (this.currentAttempt) {
          this.bindHandshakeCompletion(this.currentAttempt);
          return;
        }
        continue;
      }
      if (this.isTerminated()) return;
      this.onPeerAuthenticated.execute();
      this.bindHandshakeCompletion(attempt);

      log("dtls connected");
      return;
    }
  }

  private isCurrentAttempt(attempt: TransportAttempt): boolean {
    if (this.state === "closed" || this.state === "failed") return false;
    return (
      this.currentAttempt?.id === attempt.id &&
      this.currentAttempt.iceGeneration === attempt.iceGeneration &&
      (this.iceTransport.connection as Connection).generation ===
        attempt.iceGeneration
    );
  }

  private beginAttempt(iceGeneration: number): TransportAttempt {
    const attempt: TransportAttempt = {
      id: ++this.attemptCounter,
      iceGeneration,
    };
    this.currentAttempt = attempt;
    this.onAttemptChanged.execute();
    return attempt;
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
    if (!dtls || this.handshakeWaitAttemptId === attempt.id) return;
    this.handshakeWaitAttemptId = attempt.id;

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
    if (this.readiness.handshakeComplete) return;
    this.readiness.handshakeComplete = true;
    this.onHandshakeComplete.execute();
  }

  private markWriteReady(attempt?: TransportAttempt): void {
    const current = attempt ?? this.currentAttempt;
    if (!current || !this.isCurrentAttempt(current)) return;
    if (this.readiness.writeReady) return;
    this.readiness.writeReady = true;
    this.spedTransport?.markApplicationWriteReady();
    this.ensureEarlySrtpKeys();
    this.updateSrtpPermissions();
    this.onWriteReady.execute();
  }

  private ensureEarlySrtpKeys(): void {
    if (this.srtpProfiles.length > 0 && this.isEarlyServerOutboundReady()) {
      this.installSrtpKeys();
    }
  }

  private async startSerial(
    addressValidation: "dtls-cookie" | "ice-authenticated",
  ) {
    await new Promise<void>(async (r, f) => {
      if (this.role === "server") {
        this.dtls = new DtlsServer({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
          certificateRequest: true,
          protocolVersions: this.config.protocolVersions,
          peerIdentityMode: "authenticated-single-peer",
          addressValidation,
        });
      } else {
        this.dtls = new DtlsClient({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
          protocolVersions: this.config.protocolVersions,
          peerIdentityMode: "authenticated-single-peer",
          addressValidation,
        });
      }
      this.bindDtlsSocketEvents(r, f);

      if (this.dtls instanceof DtlsClient) {
        const startedAttempt = this.currentAttempt;
        await setTimeout(100);
        this.dtls.connect().catch((error) => {
          // stop()/close() 後の遅延失敗で closed を failed へ上書きしない。
          if (this.isTerminated()) return;
          if (startedAttempt && !this.isCurrentAttempt(startedAttempt)) return;
          this.lastError = error;
          this.setState("failed");
          log("dtls connect failed", error);
          f(error);
        });
      }
    });
  }

  private async startWithSped(
    addressValidation: "dtls-cookie" | "ice-authenticated",
  ) {
    const ice = this.iceTransport.connection as Connection;
    const transport = new IceSpedTransport(ice);
    this.spedTransport = transport;
    transport.setEarlyApplicationSendEnabled(
      this.config.warp?.allowEarlyServerData === true,
    );
    const carrier = new DirectHandshakeCarrier(transport);
    carrier.setWireSendEnabled(false);
    carrier.setRetransmissionMode("external");

    let lastFlight: Buffer[] = [];
    let handshakeDone = false;
    let dtlsSocket: DtlsSocket | undefined;
    const handle = attachSpedToConnection(ice, {
      inject: async (bytes, peer, generation) => {
        if (ice.generation !== generation) {
          return;
        }
        await carrier.inject(bytes, peer ? [peer[0], peer[1]] : undefined, {
          rxGeneration: generation,
        });
      },
      onSessionReset: () => {
        carrier.invalidateInboundInjects?.();
        this.onEarlyApplicationAttemptCancelled.execute();
        this.resetMediaBufferForNewAttempt();
        transport.setEarlyApplicationSendEnabled(
          this.config.warp?.allowEarlyServerData === true,
        );
        dtlsSocket?.clearEarlyDataBuffer();
        if (
          this.state === "connected" &&
          this.currentAttempt &&
          this.currentAttempt.iceGeneration !== ice.generation
        ) {
          // SPED owns the generation reset callback; connected associations
          // still need to rebind upper readiness waiters to the new attempt.
          this.rebindConnectedAttempt(this.beginAttempt(ice.generation));
        }
        if (this.state === "connecting" && this.currentAttempt) {
          // The cryptographic association continues, but every subsequent
          // continuation is now owned by the new authenticated ICE generation.
          // Invalidate every closure that captured the prior ICE generation.
          // The owning completeHandshake loop adopts this new immutable token.
          this.beginAttempt(ice.generation);
          // 新 attempt 用に gate を開き直す (旧 drain 残余は呼び出し側が破棄する)。
          this.applicationGate.restartForNewAttempt();
          this.earlyModeDisabled = false;
          this.readiness.writeReady = false;
          this.srtpWriteReady = false;
          this.handshakeStartedAt = Date.now();
          this.peerAuthenticatedAt = undefined;
        } else {
          this.applicationGate.discardPending();
        }
        if (this.state === "connected" || handshakeDone) {
          if (handle.runtime.isDirectCarrierSelected()) {
            if (dtlsSocket?.isDtls13) {
              handle.runtime.completeDirectFallback();
            } else {
              handle.runtime.commitDirectFallback();
            }
          } else if (dtlsSocket?.isDtls13) {
            handle.runtime.completeHandshake();
          } else {
            handle.runtime.commitDirectFallback();
          }
          return;
        }
        // New ICE generation starts SPED probing again.
        transport.disableHandshakeDirect();
        carrier.setWireSendEnabled(false);
        carrier.setRetransmissionMode("external");
        if (this.state === "connecting" && lastFlight.length > 0) {
          handle.onFlightCreated(lastFlight);
          if (dtlsSocket?.readiness.writeReady) {
            this.markWriteReady(this.currentAttempt);
          }
        }
      },
      onSessionAbort: () => {
        this.onEarlyApplicationAttemptCancelled.execute();
        this.earlyModeDisabled = true;
        transport.setEarlyApplicationSendEnabled(false);
        transport.disableHandshakeDirect();
        // ICE/SPED abort invalidates early SRTP permission immediately.  The
        // DTLS association may still be connecting, so peer authentication is
        // not sufficient to reconstruct this permission until a new attempt.
        this.srtpWriteReady = false;
        this.srtpReadReady = false;
        this.applicationGate.discardPending();
        this.mediaBuffer.clear(true);
        dtlsSocket?.clearEarlyDataBuffer();
        carrier.invalidateInboundInjects?.();
        carrier.cancelAllTimers();
      },
      onFallbackFlight: async () => {
        this.onEarlyApplicationAttemptCancelled.execute();
        this.earlyModeDisabled = true;
        transport.setEarlyApplicationSendEnabled(false);
        this.srtpWriteReady = false;
        this.applicationGate.discardPending();
        this.mediaBuffer.clear(true);
        dtlsSocket?.clearEarlyDataBuffer();
        carrier.setWireSendEnabled(true);
      },
      onHandshakeComplete: () => {
        handshakeDone = true;
        carrier.setWireSendEnabled(true);
        transport.markApplicationReady();
      },
      onDirectHandshakeReady: (readiness) => {
        if (readiness.generation !== ice.generation) {
          return;
        }
        if (!readiness.ready || !readiness.pair) {
          transport.disableHandshakeDirect();
          if (this.state === "connecting" && !handshakeDone) {
            carrier.setWireSendEnabled(false);
            carrier.setRetransmissionMode("external");
          }
          return;
        }
        transport.enableHandshakeDirect(readiness.pair, readiness.generation);
        carrier.setWireSendEnabled(true);
      },
      setRetransmissionMode: (mode) => carrier.setRetransmissionMode(mode),
      updateRtt: (rttMs) => carrier.updateRtt(rttMs),
      resetRtt: () => carrier.resetRtt(),
      setMtu: (mtu) => carrier.setMtu(mtu),
      refragmentPendingFlight: () => {
        if (dtlsSocket) {
          refragmentPendingFlightIfNeeded(dtlsSocket);
        }
      },
    });
    transport.setRuntime(handle.runtime);

    carrier.events.onFlightCreated = (_flightId, packets) => {
      if (handle.runtime.isStaleCarrierFlight()) {
        return;
      }
      lastFlight = packets.map((packet) => Buffer.from(packet.bytes));
      handle.onFlightCreated(lastFlight, { fromCarrier: true });
    };

    const common = {
      cert: this.localCertificate?.certPem,
      key: this.localCertificate?.privateKey,
      signatureHash: this.localCertificate?.signatureHash,
      transport,
      srtpProfiles: this.srtpProfiles,
      extendedMasterSecret: true,
      // The association owns version selection. SPED carries the 1.3
      // candidate while a negotiated 1.2 candidate commits to direct DTLS.
      protocolVersions: this.config.protocolVersions,
      peerIdentityMode: "authenticated-single-peer" as const,
      addressValidation,
      handshakeCarrier: carrier,
    };

    await new Promise<void>(async (r, f) => {
      if (this.role === "server") {
        this.dtls = createDtlsServerInternal({
          ...common,
          certificateRequest: true,
        });
      } else {
        this.dtls = createDtlsClientInternal(common);
      }
      dtlsSocket = this.dtls;
      this.bindDtlsSocketEvents(r, f);
      this.dtls.onConnect.once(() => {
        const directFallback =
          handle.runtime.fallbackStarted ||
          handle.runtime.session.state === "fallback" ||
          handle.runtime.session.peerSupport === "unsupported";
        if (this.dtls?.isDtls13 && !directFallback) {
          handle.onHandshakeComplete();
        } else if (this.dtls?.isDtls13) {
          handshakeDone = true;
          this.earlyModeDisabled = true;
          carrier.setWireSendEnabled(true);
          handle.runtime.completeDirectFallback();
          transport.markApplicationReady();
        } else {
          handshakeDone = true;
          this.earlyModeDisabled = true;
          carrier.setWireSendEnabled(true);
          handle.runtime.commitDirectFallback();
          transport.markApplicationReady();
        }
      });

      if (this.dtls instanceof DtlsClient) {
        const startedAttempt = this.currentAttempt;
        this.dtls.connect().catch((error) => {
          // stop()/close() 後の遅延失敗で closed を failed へ上書きしない。
          if (this.isTerminated()) return;
          if (startedAttempt && !this.isCurrentAttempt(startedAttempt)) return;
          this.lastError = error;
          this.setState("failed");
          this.abortSpedSession();
          log("dtls connect failed", error);
          f(error);
        });
      }
    });
  }

  private bindDtlsSocketEvents(r: () => void, f: (error: Error) => void) {
    if (!this.dtls) {
      return;
    }
    // engine RX queue の stale 実行を世代で遮断する (ICE restart race)。
    this.dtls.setExpectedRxGeneration(
      () => (this.iceTransport.connection as Connection).generation,
    );
    this.dtls.onData.subscribe((buf) => {
      if (
        this.config.debug?.inboundPacketLoss &&
        this.config.debug?.inboundPacketLoss / 100 < Math.random()
      ) {
        return;
      }
      // restart 後に engine queue から遅延配送された旧世代 data は gate に入れない。
      if (!this.isFreshApplicationReceive()) return;
      this.applicationGate.receive(buf);
    });
    this.dtls.onClose.subscribe(() => {
      // 全 close 経路で送信許可を解除し、close 後の SRTP/SRTCP 送信を防ぐ。
      this.srtpReadReady = false;
      this.srtpWriteReady = false;
      if (this.state === "connecting") {
        this.abortSpedSession();
        this.abortPreAuthBuffers();
      }
      if (this.state !== "failed") {
        this.setState("closed");
      }
      // onClose may be the only terminal edge observed by the start wrapper
      // (notably when stop() closes a handshake before onConnect).  Reject it
      // so every caller awaiting the shared startPromise is released.
      f(
        this.lastError ??
          new Error("DTLS transport closed before start completed"),
      );
    });
    this.dtls.onConnect.once(r);
    this.dtls.onError.once((error) => {
      this.lastError = error;
      this.srtpReadReady = false;
      this.srtpWriteReady = false;
      this.setState("failed");
      this.abortSpedSession();
      this.abortPreAuthBuffers();
      log("dtls failed", error);
      f(error);
    });
  }

  private abortSpedSession() {
    const ice = this.iceTransport.connection as Connection;
    getConnectionSpedRuntime(ice)?.abort();
  }

  /**
   * engine から届いた application data を gate へ入れてよいか判定する。
   * connecting 中の旧 attempt 由来や close/failed 後の遅延配送を遮断する。
   * connected 中の answerer restart はここで attempt を付け替えて継続する。
   */
  private isFreshApplicationReceive(): boolean {
    if (this.isTerminated()) return false;
    const ice = this.iceTransport.connection as Connection;
    if (this.state === "connected") {
      this.syncConnectedAttempt();
      const synced = this.currentAttempt;
      if (!synced) return false;
      return ice.generation === synced.iceGeneration;
    }
    const current = this.currentAttempt;
    if (!current) return true;
    return ice.generation === current.iceGeneration;
  }

  private abortPreAuthBuffers() {
    if (this.readiness.peerAuthenticated) return;
    this.applicationGate.abort();
    this.mediaBuffer.clear(true);
    this.mediaBuffer.dispose();
  }

  /**
   * ICE generation をまたぐ media queue の所有権を切り替える。
   * clear() だけでは旧 buffer を再利用でき、dispose() だけでは drop
   * 計上を失うため、旧 queue を明示的に破棄してから新しい buffer を作る。
   */
  private resetMediaBufferForNewAttempt(): void {
    this.mediaBuffer.clear(true);
    this.retainMediaDroppedStats();
    this.mediaBuffer.dispose();
    this.mediaBuffer = createPreAuthEarlyDataBuffer({
      enabled: this.config.warp?.earlyMediaPolicy === "buffer",
    });
  }

  private replaceMediaBuffer(): void {
    this.resetMediaBufferForNewAttempt();
  }

  private retainMediaDroppedStats(): void {
    const stats = this.mediaBuffer.snapshot();
    this.retiredMediaDroppedPackets += stats.droppedPackets;
    this.retiredMediaDroppedBytes += stats.droppedBytes;
  }

  private mediaBufferStats() {
    const current = this.mediaBuffer.snapshot();
    return {
      ...current,
      droppedPackets: current.droppedPackets + this.retiredMediaDroppedPackets,
      droppedBytes: current.droppedBytes + this.retiredMediaDroppedBytes,
    };
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
    if (this.srtpKeysInstalled) return;
    if (!this.dtls) throw new Error();

    const { srtp, srtcp } = createSrtpSessions(this.dtls);
    this.srtp = srtp;
    this.srtcp = srtcp;
    this.srtpKeysInstalled = true;
  }

  startSrtp() {
    this.bindMediaListener();
    this.installSrtpKeys();
    this.updateSrtpPermissions();
  }

  /** Key availability never grants media access by itself. */
  private updateSrtpPermissions() {
    this.srtpReadReady =
      this.srtpKeysInstalled && this.readiness.peerAuthenticated;
    this.srtpWriteReady =
      this.srtpKeysInstalled &&
      (this.readiness.peerAuthenticated || this.isEarlyServerWriteAllowed());
  }

  private bindMediaListener() {
    if (this.mediaListenerStarted) return;
    this.mediaListenerStarted = true;
    this.srtpStarted = true;
  }

  /**
   * ICE datagram 受信層の media 処理。購読は constructor 時に開始済みのため、
   * DTLS `start()` 前に届いた early RTP/RTCP もここで保持する。認証前の到着
   * は encrypted のまま buffer/drop し、復号・配送は fingerprint 認証後だけ。
   */
  private onIceDatagram(ctx: IceDatagramContext): void {
    if (
      this.config.debug?.inboundPacketLoss &&
      this.config.debug?.inboundPacketLoss / 100 < Math.random()
    ) {
      return;
    }

    // 旧 generation・close 後・未認証 pair の media は配送も buffer もしない。
    if (this.isTerminated()) return;
    this.syncConnectedAttempt();
    const ice = this.iceTransport.connection as Connection;
    const current = this.currentAttempt;
    if (ctx.generation !== ice.generation) return;
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

    // Track received data statistics
    this.bytesReceived += data.length;
    this.packetsReceived++;

    if (!this.srtpReadReady) {
      // handshake 開始前 (attempt 未発行) の pre-auth media は現世代に
      // 限り buffer し、配送は認証後の drain に委ねる。
      if (current && !this.isCurrentAttempt(current)) return;
      if (current && ctx.generation !== current.iceGeneration) return;
      this.mediaBuffer.push(data);
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

  private drainMediaBuffer(attempt: TransportAttempt) {
    const buffer = this.mediaBuffer;
    while (true) {
      // 各要素配送前と配送後に attempt/state を再検証し、close/restart で中断する。
      if (
        !this.isCurrentAttempt(attempt) ||
        !this.srtpReadReady ||
        this.isTerminated()
      ) {
        buffer.clear(true);
        return;
      }
      const data = buffer.takeOne();
      if (!data) return;
      this.handleMediaPacket(data, attempt);
      if (
        !this.isCurrentAttempt(attempt) ||
        this.isTerminated() ||
        !this.srtpReadReady
      ) {
        buffer.clear(true);
        return;
      }
    }
  }

  private canDeliverMedia(attempt: TransportAttempt): boolean {
    return (
      this.srtpReadReady &&
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
    if (this.state !== "connected" || !this.currentAttempt) return;
    const generation = (this.iceTransport.connection as Connection).generation;
    if (generation !== this.currentAttempt.iceGeneration) {
      this.rebindConnectedAttempt(this.beginAttempt(generation));
    }
  }

  readonly sendData = async (data: Buffer) => {
    if (
      this.config.debug?.outboundPacketLoss &&
      this.config.debug?.outboundPacketLoss / 100 < Math.random()
    ) {
      return;
    }

    if (!this.dtls) {
      throw new Error("dtls not established");
    }
    if (!this.readiness.peerAuthenticated) {
      if (!this.isEarlyServerOutboundReady()) {
        throw new Error("DTLS peer is not authenticated");
      }
      this.earlyServerSendUsed = true;
    }
    await this.dtls.send(data);
  };

  async sendRtp(payload: Buffer, header: RtpHeader): Promise<number> {
    try {
      if (this.isTerminated()) return 0;
      if (!this.srtpWriteReady) return 0;
      if (!this.readiness.peerAuthenticated) this.earlyServerSendUsed = true;
      const enc = this.srtp.encrypt(payload, header);

      if (
        this.config.debug?.outboundPacketLoss &&
        this.config.debug?.outboundPacketLoss / 100 < Math.random()
      ) {
        return enc.length;
      }

      await this.sendProtectedMedia(enc);
      // 実際の wire 送信が成功した後だけ統計を更新する。SPED の early
      // path は authenticated pair 待ちで reject することがある。
      this.bytesSent += enc.length;
      this.packetsSent++;
      return enc.length;
    } catch (error) {
      log("failed to send", error);
      return 0;
    }
  }

  async sendRtcp(packets: RtcpPacket[]) {
    if (this.isTerminated()) return 0;
    if (!this.srtpWriteReady) return 0;
    if (!this.readiness.peerAuthenticated) this.earlyServerSendUsed = true;
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    const enc = this.srtcp.encrypt(payload);

    if (
      this.config.debug?.outboundPacketLoss &&
      this.config.debug?.outboundPacketLoss / 100 < Math.random()
    ) {
      return enc.length;
    }

    try {
      await this.sendProtectedMedia(enc);
      // 実際の wire 送信が成功した後だけ統計を更新する。
      this.bytesSent += enc.length;
      this.packetsSent++;
      return;
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

  async stop() {
    // 旧 attempt の callback・drain が再開しないよう先に無効化する。
    this.currentAttempt = undefined;
    this.iceDatagramSubscription?.unSubscribe();
    this.iceDatagramSubscription = undefined;
    this.srtpReadReady = false;
    this.srtpWriteReady = false;
    this.setState("closed", false);
    this.applicationGate.abort();
    this.mediaBuffer.clear(true);
    this.mediaBuffer.dispose();
    // DTLS engine の early queue・pending flight・再送 timer を確実に破棄し、
    // close 後の遅延実行を残さない。失敗しても ICE 停止は継続する。
    try {
      this.dtls?.close();
    } catch (error) {
      log("dtls close failed", error);
    }
    // todo impl send alert
    await this.iceTransport.stop();
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
        mediaQueue: this.mediaBufferStats(),
        handshakeStartedAt: this.handshakeStartedAt,
        peerAuthenticatedAt: this.peerAuthenticatedAt,
        earlyServerSendUsed: this.earlyServerSendUsed,
      },
      timestamp,
    );

    // Get ICE stats
    const iceStats = await this.iceTransport.getStats(timestamp, transportId);
    stats.push(...iceStats);

    return stats;
  }
}
