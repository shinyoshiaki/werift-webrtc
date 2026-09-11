import { Certificate, PrivateKey } from "@fidm/x509";

import { randomUUID } from "crypto";
import { setTimeout } from "timers/promises";
import {
  type Address,
  type DatagramRxMeta,
  Event,
  type Transport,
} from "../imports/common";

import { DirectHandshakeCarrier } from "../../../dtls/src/carrier/direct";
import {
  EarlyDataBuffer,
  createDtlsClientInternal,
  createDtlsServerInternal,
  refragmentPendingFlightIfNeeded,
} from "../../../dtls/src/internal";
import type { Connection } from "../../../ice/src";
import {
  type IceDatagramContext,
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import { attachSpedToConnection } from "../../../ice/src/internal/sped";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { EventTarget as DomEventTarget } from "../helper";
import {
  CipherContext,
  DtlsClient,
  DtlsServer,
  type DtlsSocket,
  type DtlsVersion,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
  type SignatureHash,
} from "../imports/dtls";
import type { IceConnection } from "../imports/ice";
import {
  type RtcpPacket,
  RtcpPacketConverter,
  type RtpHeader,
  RtpPacket,
  SrtcpSession,
  SrtpAuthenticationError,
  type SrtpProfile,
  SrtpSession,
  debug,
  isMedia,
  isRtcp,
  keyLength,
  saltLength,
} from "../imports/rtp";
import {
  type RTCCertificateStats,
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCStats,
  type RTCTransportStats,
  generateStatsId,
  getStatsTimestamp,
} from "../media/stats";
import type { DebugConfig } from "../peerConnection";
import {
  fingerprint,
  isDtls,
  normalizeFingerprintAlgorithm,
  normalizeFingerprintValue,
} from "../utils";
import { isDtlsTransportSped } from "./dtls-sped";
import type { RTCIceTransport } from "./ice";
import { IceSpedTransport } from "./sped";

const log = debug("werift:packages/webrtc/src/transport/dtls.ts");

export interface DtlsTransportConfig {
  debug?: DebugConfig;
  protocolVersions?: readonly DtlsVersion[];
  helloRetryRequest?: boolean;
  warp?: {
    allowEarlyServerData?: boolean;
    earlyMediaPolicy?: "drop" | "buffer";
  };
}

interface WebRtcDtlsReadiness {
  writeReady: boolean;
  peerAuthenticated: boolean;
  handshakeComplete: boolean;
}

interface TransportAttempt {
  readonly id: number;
  readonly iceGeneration: number;
}

class InboundApplicationGate {
  private authenticated = false;
  private aborted = false;
  private buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
  private retiredDroppedPackets = 0;
  private retiredDroppedBytes = 0;

  constructor(private readonly deliver: (data: Buffer) => void) {}

  /** Read-only snapshot source for stats; instance may rotate on restart. */
  snapshot() {
    const current = this.buffer.snapshot();
    return {
      ...current,
      droppedPackets: current.droppedPackets + this.retiredDroppedPackets,
      droppedBytes: current.droppedBytes + this.retiredDroppedBytes,
    };
  }

  receive(data: Buffer): void {
    if (this.aborted) return;
    if (this.authenticated) this.deliver(data);
    else this.buffer.push(data);
  }

  authenticate(
    shouldContinue?: () => boolean,
    isTerminal?: () => boolean,
  ): void {
    if (this.aborted || this.authenticated) return;
    if (shouldContinue && !shouldContinue()) {
      // restart による drift では新 attempt 用に gate を残し、terminal 時のみ廃棄する。
      if (isTerminal?.()) this.abort();
      return;
    }
    this.authenticated = true;
    const buffer = this.buffer;
    while (true) {
      // close/restart が deliver callback 内で発生したら残りを破棄する。
      if (this.aborted) {
        buffer.clear(true);
        return;
      }
      if (shouldContinue && !shouldContinue()) {
        if (isTerminal?.()) this.abort();
        else buffer.clear(true);
        return;
      }
      const data = buffer.takeOne();
      if (!data) return;
      this.deliver(data);
      if (this.aborted) {
        buffer.clear(true);
        return;
      }
      if (shouldContinue && !shouldContinue()) {
        if (isTerminal?.()) this.abort();
        else buffer.clear(true);
        return;
      }
    }
  }

  abort(): void {
    this.aborted = true;
    this.buffer.clear(true);
    this.buffer.dispose();
  }

  /**
   * ICE restart 後の新 attempt 用に gate を再初期化する。旧 drain の残余は
   * 呼び出し側が破棄済みとし、buffer と認証状態だけを新世代用に開き直す。
   * fingerprint mismatch 等の terminal abort とは別扱いである。
   */
  restartForNewAttempt(): void {
    // A generation change owns the old queue's complete lifecycle.  Dispose it
    // before replacing the instance so its retention timer cannot survive the
    // restart and mutate detached state two seconds later.
    this.buffer.clear(true);
    this.retainDroppedStats();
    this.buffer.dispose();
    this.authenticated = false;
    this.aborted = false;
    // dispose 済みの buffer は復活できないため新世代用に作り直す。
    this.buffer = new EarlyDataBuffer(256, 256 * 1024, 2_000);
  }

  clearPending(): void {
    if (!this.authenticated && !this.aborted) this.buffer.clear(true);
  }

  resetPending(): void {
    if (!this.authenticated && !this.aborted) this.buffer.clear(true);
  }

  private retainDroppedStats(): void {
    const stats = this.buffer.snapshot();
    this.retiredDroppedPackets += stats.droppedPackets;
    this.retiredDroppedBytes += stats.droppedBytes;
  }
}

function formatDtlsVersion(socket?: DtlsSocket) {
  if (!socket) {
    return;
  }
  if (socket.isDtls13) {
    return "DTLS 1.3";
  }
  const version = socket.dtls?.version;
  if (!version) return;
  if (version.major === 0xfe && version.minor === 0xfd) {
    return "DTLS 1.2";
  }
  if (version.major === 0xfe && version.minor === 0xff) {
    return "DTLS 1.0";
  }
}

function formatDtlsCipher(socket?: DtlsSocket) {
  if (!socket) {
    return;
  }
  if (socket.isDtls13) {
    return "TLS_AES_128_GCM_SHA256";
  }
  return socket.cipher?.cipher?.name;
}

function formatSrtpCipher(profile?: number) {
  switch (profile) {
    case 0x0001:
      return "AES_CM_128_HMAC_SHA1_80";
    case 0x0007:
      return "AEAD_AES_128_GCM";
    default:
      return;
  }
}

export interface DtlsTransportStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

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
  /** RFC 8842 association-local tls-id advertised in SDP. */
  private localTlsId = randomUUID();

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
    this.mediaBuffer = new EarlyDataBuffer(
      this.config.warp?.earlyMediaPolicy === "buffer" ? 256 : 0,
      this.config.warp?.earlyMediaPolicy === "buffer" ? 256 * 1024 : 0,
      2_000,
    );
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
    const parameters = new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : [],
      this.role,
    );
    parameters.tlsId = this.localTlsId;
    return parameters;
  }

  static async SetupCertificate() {
    if (this.localCertificate) {
      return this.localCertificate;
    }

    if (this.localCertificatePromise) {
      return this.localCertificatePromise;
    }

    this.localCertificatePromise = (async () => {
      const { certPem, keyPem, signatureHash } =
        await CipherContext.createSelfSignedCertificateWithKey(
          {
            signature: SignatureAlgorithm.ecdsa_3,
            hash: HashAlgorithm.sha256_4,
          },
          NamedCurveAlgorithm.secp256r1_23,
        );
      this.localCertificate = new RTCCertificate(
        keyPem,
        certPem,
        signatureHash,
      );
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
    this.remoteParameters.tlsId = remoteParameters.tlsId;
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

  /** @internal
   * Validate a pending SDP fingerprint without replacing the current
   * authentication assertion.  A connected transport may inspect a remote
   * offer before its BUNDLE migration is committed; rollback must not leave
   * that offer's parameters installed on the current graph.
   */
  validateRemoteFingerprint(remoteParameters: RTCDtlsParameters): void {
    if (!this.readiness.peerAuthenticated || !this.dtls?.remoteCertificate) {
      return;
    }

    const previousParameters = this.remoteParameters;
    this.remoteParameters = remoteParameters;
    try {
      this.verifyRemoteCertificateFingerprint();
    } finally {
      this.remoteParameters = previousParameters;
    }
  }

  /**
   * RFC 8842: a changed fingerprint set on an authenticated transport proposes
   * a new DTLS association.  It is not an attack on the current certificate.
   */
  proposesNewDtlsAssociation(remoteParameters: RTCDtlsParameters): boolean {
    if (!this.readiness.peerAuthenticated || !this.dtls?.remoteCertificate) {
      return false;
    }
    if (this.fingerprintSetDiffers(remoteParameters)) {
      return true;
    }
    try {
      this.validateRemoteFingerprint(remoteParameters);
      return false;
    } catch {
      return true;
    }
  }

  private fingerprintSetDiffers(remoteParameters: RTCDtlsParameters): boolean {
    const current = this.remoteParameters?.fingerprints ?? [];
    if (current.length === 0) {
      return false;
    }
    const currentKeys = fingerprintSetKeys(current);
    const offeredKeys = fingerprintSetKeys(remoteParameters.fingerprints);
    if (currentKeys.size !== offeredKeys.size) {
      return true;
    }
    for (const key of currentKeys) {
      if (!offeredKeys.has(key)) {
        return true;
      }
    }
    return false;
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
        await setTimeout(100);
        this.dtls.connect().catch((error) => {
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
          this.applicationGate.resetPending();
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
        this.applicationGate.clearPending();
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
        this.applicationGate.clearPending();
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
        this.dtls.connect().catch((error) => {
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
    const buffering = this.config.warp?.earlyMediaPolicy === "buffer";
    this.mediaBuffer = new EarlyDataBuffer(
      buffering ? 256 : 0,
      buffering ? 256 * 1024 : 0,
      2_000,
    );
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
    if (
      !this.remoteParameters ||
      this.remoteParameters.fingerprints.length === 0
    ) {
      throw new Error("remote fingerprint not exist");
    }

    const remoteCertificate = this.dtls?.remoteCertificate;
    if (!remoteCertificate) {
      throw new Error("remote certificate not available");
    }

    const supportedFingerprints = this.remoteParameters.fingerprints.flatMap(
      ({ algorithm, value }) => {
        const normalizedAlgorithm = normalizeFingerprintAlgorithm(algorithm);
        if (!normalizedAlgorithm) {
          return [];
        }

        const normalizedValue = normalizeFingerprintValue(value);
        if (!normalizedValue) {
          throw new Error("remote fingerprint value is empty");
        }

        return [{ normalizedAlgorithm, normalizedValue }];
      },
    );
    if (supportedFingerprints.length === 0) {
      throw new Error("no supported remote fingerprint algorithms");
    }

    const preferredAlgorithm = selectPreferredFingerprintAlgorithm(
      supportedFingerprints,
    );
    const expectedFingerprints = supportedFingerprints.filter(
      ({ normalizedAlgorithm }) => normalizedAlgorithm === preferredAlgorithm,
    );

    const actualFingerprints = expectedFingerprints.reduce(
      (acc, { normalizedAlgorithm }) => {
        if (!acc.has(normalizedAlgorithm)) {
          acc.set(
            normalizedAlgorithm,
            normalizeFingerprintValue(
              fingerprint(remoteCertificate, normalizedAlgorithm),
            ),
          );
        }
        return acc;
      },
      new Map<string, string>(),
    );

    const matched = expectedFingerprints.some(
      ({ normalizedAlgorithm, normalizedValue }) =>
        actualFingerprints.get(normalizedAlgorithm) === normalizedValue,
    );

    if (!matched) {
      throw new Error("remote certificate fingerprint mismatch");
    }
  }

  updateSrtpSession() {
    this.installSrtpKeys();
  }

  private installSrtpKeys() {
    if (this.srtpKeysInstalled) return;
    if (!this.dtls) throw new Error();

    const profile = this.dtls.srtp.srtpProfile;
    if (!profile) {
      throw new Error("need srtpProfile");
    }
    log("selected SRTP Profile", profile);

    const { localKey, localSalt, remoteKey, remoteSalt } =
      this.dtls.extractSessionKeys(keyLength(profile), saltLength(profile));

    const config = {
      keys: {
        localMasterKey: localKey,
        localMasterSalt: localSalt,
        remoteMasterKey: remoteKey,
        remoteMasterSalt: remoteSalt,
      },
      profile,
    };
    this.srtp = new SrtpSession(config);
    this.srtcp = new SrtcpSession(config);
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
    if (!ctx.authenticated || !ctx.pair) return;
    if (ctx.protocol !== ctx.pair.protocol) return;
    const remote = ctx.pair.remoteAddr;
    if (ctx.source[0] !== remote[0] || ctx.source[1] !== remote[1]) return;

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
      let dec: Buffer;
      try {
        dec = this.srtcp.decrypt(data);
      } catch (error) {
        if (error instanceof SrtpAuthenticationError) {
          log("dropping invalid SRTCP packet", error);
          return;
        }
        throw error;
      }
      let rtcpPackets;
      try {
        rtcpPackets = RtcpPacketConverter.deSerialize(dec);
      } catch (error) {
        log("dropping malformed SRTCP packet", error);
        return;
      }
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
      let dec: Buffer;
      try {
        dec = this.srtp.decrypt(data);
      } catch (error) {
        if (error instanceof SrtpAuthenticationError) {
          log("dropping invalid SRTP packet", error);
          return;
        }
        throw error;
      }
      let rtp;
      try {
        rtp = RtpPacket.deSerialize(dec);
      } catch (error) {
        log("dropping malformed SRTP packet", error);
        return;
      }
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
    const stats: RTCStats[] = [];

    const transportId = generateStatsId("transport", this.id);

    // Transport stats
    const appQueue = this.applicationGate.snapshot();
    const mediaQueue = this.mediaBufferStats();
    const dtlsQueue = this.dtls?.earlyDataStats;
    const spedDiagnostics = getConnectionSpedRuntime(
      this.iceTransport.connection as Connection,
    )?.diagnosticsSnapshot();
    const transportStats: RTCTransportStats = {
      type: "transport",
      id: transportId,
      timestamp,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      dtlsState: this.state,
      iceState: this.iceTransport.state,
      iceRole:
        this.iceTransport.role === "unknown"
          ? undefined
          : this.iceTransport.role,
      iceLocalUsernameFragment:
        this.iceTransport.localParameters.usernameFragment,
      selectedCandidatePairId: this.iceTransport.connection.nominated
        ? generateStatsId(
            "candidate-pair",
            this.iceTransport.connection.nominated.id,
          )
        : undefined,
      localCertificateId: this.localCertificate
        ? generateStatsId("certificate", this.id, "local")
        : undefined,
      remoteCertificateId: this.remoteCertificateForStats()
        ? generateStatsId("certificate", this.id, "remote")
        : undefined,
      dtlsRole: this.role === "auto" ? undefined : this.role,
      tlsVersion: formatDtlsVersion(this.dtls),
      dtlsCipher: formatDtlsCipher(this.dtls),
      srtpCipher: formatSrtpCipher(this.dtls?.srtp.srtpProfile),
      iceRestarts: this.iceTransport.iceRestarts,
      warpSpedState: spedDiagnostics?.state ?? "disabled",
      warpCarrier: spedDiagnostics?.carrier ?? "direct",
      warpHandshakeRttMs:
        this.handshakeStartedAt !== undefined &&
        this.peerAuthenticatedAt !== undefined
          ? this.peerAuthenticatedAt - this.handshakeStartedAt
          : undefined,
      warpDtlsRetransmissions: this.dtls?.totalRetransmitCount ?? 0,
      warpSpedRetransmissions: spedDiagnostics?.retransmissions ?? 0,
      warpEarlyBufferedPackets:
        appQueue.bufferedPackets +
        mediaQueue.bufferedPackets +
        (dtlsQueue?.bufferedPackets ?? 0),
      warpEarlyBufferedBytes:
        appQueue.bufferedBytes +
        mediaQueue.bufferedBytes +
        (dtlsQueue?.bufferedBytes ?? 0),
      warpEarlyDroppedPackets:
        appQueue.droppedPackets +
        mediaQueue.droppedPackets +
        (dtlsQueue?.droppedPackets ?? 0),
      warpEarlyDroppedBytes:
        appQueue.droppedBytes +
        mediaQueue.droppedBytes +
        (dtlsQueue?.droppedBytes ?? 0),
      warpEarlyServerSendUsed: this.earlyServerSendUsed,
      iceGeneration: (this.iceTransport.connection as Connection).generation,
    };
    stats.push(transportStats);

    // Certificate stats
    if (this.localCertificate) {
      const fingerprints = this.localCertificate.getFingerprints();
      if (fingerprints.length > 0) {
        const certStats: RTCCertificateStats = {
          type: "certificate",
          id: generateStatsId("certificate", this.id, "local"),
          timestamp,
          fingerprint: fingerprints[0].value,
          fingerprintAlgorithm: fingerprints[0].algorithm,
          base64Certificate: Buffer.from(
            this.localCertificate.certPem,
          ).toString("base64"),
        };
        stats.push(certStats);
      }
    }

    const remoteCertificate = this.remoteCertificateForStats();
    if (
      this.remoteParameters &&
      this.remoteParameters.fingerprints.length > 0 &&
      remoteCertificate
    ) {
      const certStats: RTCCertificateStats = {
        type: "certificate",
        id: generateStatsId("certificate", this.id, "remote"),
        timestamp,
        fingerprint: this.remoteParameters.fingerprints[0].value,
        fingerprintAlgorithm: this.remoteParameters.fingerprints[0].algorithm,
        base64Certificate: Buffer.from(remoteCertificate).toString("base64"),
      };
      stats.push(certStats);
    }

    // Get ICE stats
    const iceStats = await this.iceTransport.getStats(timestamp, transportId);
    stats.push(...iceStats);

    return stats;
  }
}

export const DtlsStates = [
  "new",
  "connecting",
  "connected",
  "closed",
  "failed",
] as const;
export type DtlsState = (typeof DtlsStates)[number];

export type DtlsRole = "auto" | "server" | "client";

export class RTCCertificate {
  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    public certPem: string,
    public signatureHash: SignatureHash,
  ) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    this.publicKey = cert.publicKey.toPEM();
    this.privateKey = PrivateKey.fromPEM(Buffer.from(privateKeyPem)).toPEM();
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(
          Certificate.fromPEM(Buffer.from(this.certPem)).raw,
          "sha256",
        ),
      ),
    ];
  }
}

export type DtlsKeys = {
  certPem: string;
  keyPem: string;
  signatureHash: SignatureHash;
};

export class RTCDtlsFingerprint {
  constructor(
    public algorithm: string,
    public value: string,
  ) {}
}

export class RTCDtlsParameters {
  /** @internal RFC 8842 tls-id. */
  tlsId?: string;

  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | "server",
  ) {}
}

/**
 * RFC 8842: a remote answer's setup role is compared against the already
 * negotiated peer role, not against a previous offer's setup:actpass.
 * @internal
 */
export function expectedRemoteDtlsRole(
  localRole: DtlsRole,
): Exclude<DtlsRole, "auto"> | undefined {
  if (localRole === "server") return "client";
  if (localRole === "client") return "server";
  return undefined;
}

/**
 * RFC 8842: fingerprint / tls-id / concrete setup-role changes request a new association.
 * Setup role is compared against the previously negotiated peer role derived
 * from the local DTLS role, not against a previous offer's setup:actpass.
 * @internal
 */
export function dtlsParametersIndicateNewAssociation(
  current: RTCDtlsParameters | undefined,
  pending: RTCDtlsParameters | undefined,
  localRole?: DtlsRole,
): boolean {
  if (!current || !pending) {
    return false;
  }
  const currentKeys = fingerprintSetKeys(current.fingerprints);
  const pendingKeys = fingerprintSetKeys(pending.fingerprints);
  if (currentKeys.size !== pendingKeys.size) {
    return true;
  }
  for (const key of currentKeys) {
    if (!pendingKeys.has(key)) {
      return true;
    }
  }
  if (current.tlsId && pending.tlsId && current.tlsId !== pending.tlsId) {
    return true;
  }
  const previousRemoteRole =
    localRole === undefined
      ? current.role
      : (expectedRemoteDtlsRole(localRole) ?? "auto");
  if (
    pending.role !== "auto" &&
    previousRemoteRole !== "auto" &&
    previousRemoteRole !== pending.role
  ) {
    return true;
  }
  return false;
}

const deduplicateFingerprints = (fingerprints: RTCDtlsFingerprint[]) => {
  const seen = new Set<string>();
  return fingerprints.filter(({ algorithm, value }) => {
    const key = `${
      normalizeFingerprintAlgorithm(algorithm) ?? algorithm.trim().toLowerCase()
    }:${normalizeFingerprintValue(value)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const fingerprintSetKeys = (fingerprints: RTCDtlsFingerprint[]) => {
  return new Set(
    deduplicateFingerprints(fingerprints).map(
      ({ algorithm, value }) =>
        `${
          normalizeFingerprintAlgorithm(algorithm) ??
          algorithm.trim().toLowerCase()
        }:${normalizeFingerprintValue(value)}`,
    ),
  );
};

const preferredFingerprintAlgorithms = [
  "sha512",
  "sha384",
  "sha256",
  "sha224",
  "sha1",
] as const;

const selectPreferredFingerprintAlgorithm = (
  fingerprints: { normalizedAlgorithm: string }[],
) => {
  return (
    preferredFingerprintAlgorithms.find((algorithm) =>
      fingerprints.some(
        ({ normalizedAlgorithm }) => normalizedAlgorithm === algorithm,
      ),
    ) ?? fingerprints[0].normalizedAlgorithm
  );
};

class IceTransport implements Transport {
  closed: boolean = false;
  private readonly datagramSubscription: { unSubscribe(): void };
  /**
   * ICE selected-pair path is already authenticated — DTLS 1.2 must not treat
   * AEAD-protected alerts as "pre-auth" merely because UDP pin is unavailable.
   */
  readonly peerAuthenticated = true;
  constructor(private ice: IceConnection) {
    this.datagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => {
        if (
          isDtls(ctx.bytes) &&
          allowsAuthenticatedDtlsDelivery(ctx, (ice as Connection).generation)
        ) {
          if (this.onData) {
            // 世代トークンを engine RX queue まで運び、restart 後の stale 実行を防ぐ。
            this.onData(ctx.bytes, ctx.source, {
              rxGeneration: ctx.generation,
            });
          }
        }
      },
    );
  }
  onData: (buf: Buffer, addr?: Address, meta?: DatagramRxMeta) => void =
    () => {};

  /**
   * DTLS 1.3 cookie HRR / anti-amp keys the peer from the RX 5-tuple.
   * ICE already demuxed to the nominated pair, so expose that remote address
   * instead of an empty AddressInfo (which made cookie HRR undeliverable).
   */
  get address() {
    const [address, port] = this.remotePeer();
    return { address, port, family: address.includes(":") ? "IPv6" : "IPv4" };
  }

  get rinfo() {
    const [address, port] = this.remotePeer();
    return { address, port };
  }

  type: string = "ice";

  readonly send = (data: Buffer, _addr?: Address) => {
    return this.ice.send(data);
  };

  async close() {
    this.closed = true;
    this.datagramSubscription.unSubscribe();
    this.ice.close();
  }

  private remotePeer(): Address {
    const nominated = this.ice.nominated;
    if (nominated) {
      return nominated.remoteAddr;
    }
    return ["0.0.0.0", 0];
  }
}

const createIceTransport = (ice: IceConnection) => new IceTransport(ice);
