import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import type { AddressInfo } from "net";
import { setTimeout } from "timers/promises";
import type { DebugConfig } from "../api/peerConfig";
import { EventTarget as DomEventTarget } from "../helper";
import { Event, type Transport } from "../imports/common";
import {
  AlertDesc,
  AlertLevel,
  CipherContext,
  DtlsAlertError,
  DtlsClient,
  DtlsServer,
  type DtlsSocket,
  HashAlgorithm,
  NamedCurveAlgorithm,
  normalizePem,
  SignatureAlgorithm,
  type SignatureHash,
} from "../imports/dtls";
import type { IceConnection } from "../imports/ice";
import {
  debug,
  isMedia,
  isRtcp,
  keyLength,
  type RtcpPacket,
  RtcpPacketConverter,
  type RtpHeader,
  RtpPacket,
  SrtcpSession,
  SrtpAuthenticationError,
  type SrtpProfile,
  SrtpSession,
  saltLength,
} from "../imports/rtp";
import {
  generateStatsId,
  getStatsTimestamp,
  type RTCCertificateStats,
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCStats,
  type RTCTransportStats,
} from "../media/stats";
import {
  fingerprint,
  isDtls,
  milliTime,
  normalizeFingerprintAlgorithm,
  normalizeFingerprintValue,
} from "../utils";
import type { RTCIceTransport } from "./ice";

/**
 * Upper bound (ms) for waiting until close_notify / a fatal alert has been
 * handed to ICE in {@link RTCDtlsTransport.stop}; it adds directly to the
 * time `RTCPeerConnection.close()` takes.
 */
export const DTLS_ALERT_SEND_TIMEOUT_MS = 100;

/**
 * Minimal `RTCError` (W3C webrtc-pc §10.1) for the DTLS failures that
 * {@link RTCDtlsTransport} reports with its `error` event.
 *
 * - `"fingerprint-failure"`: the remote certificate matched none of the
 *   fingerprints of the remote description. `receivedAlert` / `sentAlert` are
 *   null, as the spec defines them only for `"dtls-failure"`, although werift
 *   still sends a fatal `bad_certificate` (42) to the peer, which in turn
 *   reports `"dtls-failure"` with `receivedAlert: 42`.
 * - `"dtls-failure"`: any other DTLS failure, e.g. a fatal alert received
 *   (`receivedAlert`) or sent (`sentAlert`).
 */
export class RTCError extends Error {
  readonly errorDetail: "dtls-failure" | "fingerprint-failure";
  /**
   * `"dtls-failure"` only: the fatal alert description received from the
   * peer, otherwise null.
   */
  readonly receivedAlert: number | null;
  /**
   * `"dtls-failure"` only: the fatal alert description sent to the peer,
   * otherwise null.
   */
  readonly sentAlert: number | null;

  constructor(
    init: {
      errorDetail: "dtls-failure" | "fingerprint-failure";
      receivedAlert?: number | null;
      sentAlert?: number | null;
    },
    message?: string,
  ) {
    super(message);
    this.name = "OperationError";
    this.errorDetail = init.errorDetail;
    this.receivedAlert = init.receivedAlert ?? null;
    this.sentAlert = init.sentAlert ?? null;
  }
}

/** The `error` event of {@link RTCDtlsTransport} (`RTCErrorEvent`). */
export interface RTCDtlsTransportErrorEvent {
  type: "error";
  error: RTCError;
}

const log = debug("werift:packages/webrtc/src/transport/dtls.ts");

/**
 * Internal: the remote certificate matched none of the remote fingerprints
 * (reported as `errorDetail: "fingerprint-failure"`). Other verification
 * errors (no certificate, no usable fingerprint) stay `"dtls-failure"`.
 */
class FingerprintMismatchError extends Error {
  constructor() {
    super("remote certificate fingerprint mismatch");
    this.name = "FingerprintMismatchError";
  }
}

/** The RTCError for a failed check of the remote certificate. */
const certificateVerificationError = (reason: unknown) =>
  reason instanceof FingerprintMismatchError
    ? new RTCError({ errorDetail: "fingerprint-failure" }, reason.message)
    : new RTCError(
        { errorDetail: "dtls-failure", sentAlert: AlertDesc.BadCertificate },
        String(reason),
      );

/** Result of encrypting and enqueueing one RTP packet on ICE. */
export type DtlsSendRtpResult = {
  /** On-wire SRTP size in bytes. */
  size: number;
  /** Local clock immediately before ICE/UDP enqueue (RFC 8888 send time). */
  sendingAtMs: number;
};

function formatDtlsVersion(version?: { major: number; minor: number }) {
  if (!version) {
    return;
  }

  if (version.major === 0xfe && version.minor === 0xfd) {
    return "DTLS 1.2";
  }
  if (version.major === 0xfe && version.minor === 0xff) {
    return "DTLS 1.0";
  }
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
  readonly config: { debug?: DebugConfig };
  readonly iceTransport: RTCIceTransport;
  public localCertificate?: RTCCertificate | undefined;
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
  /**
   * Fires once when the transport becomes `failed`:
   * - the remote certificate matched none of the remote fingerprints:
   *   `errorDetail: "fingerprint-failure"` (`receivedAlert` / `sentAlert`
   *   null; a fatal `bad_certificate` is still sent to the peer);
   * - a fatal alert received from the peer, or sent by this side (e.g.
   *   `bad_certificate` for a certificate it could not verify for another
   *   reason), and other DTLS errors: `errorDetail: "dtls-failure"` with
   *   `receivedAlert` / `sentAlert`.
   *
   * A close_notify (`closed`) does not fire it. Also delivered as
   * `addEventListener("error", ...)`.
   */
  onerror?: ((event: RTCDtlsTransportErrorEvent) => void) | undefined;

  /** Process-wide default certificate cache, see {@link RTCDtlsTransport.SetupCertificate}. */
  static localCertificate?: RTCCertificate;
  static localCertificatePromise?: Promise<RTCCertificate>;
  private remoteParameters?: RTCDtlsParameters;

  constructor(
    config: { debug?: DebugConfig },
    iceTransport: RTCIceTransport,
    localCertificate?: RTCCertificate,
    srtpProfiles: SrtpProfile[] = [],
  ) {
    this.config = config;
    this.iceTransport = iceTransport;
    this.localCertificate = localCertificate;
    this.srtpProfiles = srtpProfiles;
    this.localCertificate ??= RTCDtlsTransport.localCertificate;
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
    const { certPem, keyPem, signatureHash } =
      await CipherContext.createSelfSignedCertificateWithKey(
        {
          signature: SignatureAlgorithm.ecdsa_3,
          hash: HashAlgorithm.sha256_4,
        },
        NamedCurveAlgorithm.secp256r1_23,
      );
    return new RTCCertificate(keyPem, certPem, signatureHash);
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
    const fingerprints = deduplicateFingerprints(remoteParameters.fingerprints);
    const role =
      remoteParameters.role === "auto" && this.remoteParameters?.role
        ? this.remoteParameters.role
        : remoteParameters.role;
    this.remoteParameters = new RTCDtlsParameters(fingerprints, role);
  }

  /** Internal: whether a description gave this transport the peer's DTLS parameters. */
  get hasRemoteParameters() {
    return (this.remoteParameters?.fingerprints.length ?? 0) > 0;
  }

  async start() {
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

    // The certificate is checked during the handshake, so that a mismatch is
    // reported to the peer with a fatal bad_certificate alert before either
    // side considers the connection established.
    const verifyRemoteCertificate = (certificate: Buffer) => {
      this.verifyRemoteCertificateFingerprint(certificate);
      return true;
    };

    await new Promise<void>(async (r, f) => {
      this.settleStart = r;
      if (this.role === "server") {
        this.dtls = new DtlsServer({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
          certificateRequest: true,
          verifyRemoteCertificate,
        });
      } else {
        this.dtls = new DtlsClient({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
          verifyRemoteCertificate,
        });
      }
      this.dtls.onData.subscribe((buf) => {
        if (
          this.config.debug?.inboundPacketLoss &&
          this.config.debug?.inboundPacketLoss / 100 < Math.random()
        ) {
          return;
        }
        this.dataReceiver(buf);
      });
      // close_notify from the peer, also during the handshake: closed (with
      // statechange, the peer caused it; W3C RTCDtlsTransportState "closed").
      // close_notify is not a fatal alert, so neither failed nor an error
      // event. closed / failed are final.
      this.dtls.onClose.subscribe(() => {
        if (this.isFinalState) return;
        log("dtls closed by the peer");
        try {
          this.setState("closed");
        } finally {
          // Settle start() even if a statechange listener threw: it returns
          // with closed (transport activation then ends a connection attempt
          // that never connected as failed).
          r();
        }
      });
      this.dtls.onConnect.once(r);
      // A handshake error, or a fatal alert received or sent while
      // connecting or after the connection was established.
      this.dtls.onError.subscribe((error) => {
        log("dtls failed", error);
        try {
          this.fail(error);
        } finally {
          // Settle start() even if a statechange listener threw. A local
          // certificate rejection rejects with the verifier's error (e.g.
          // "remote certificate fingerprint mismatch").
          f(
            error instanceof DtlsAlertError &&
              error.source === "local" &&
              error.reason instanceof Error
              ? error.reason
              : error,
          );
        }
      });

      if (this.dtls instanceof DtlsClient) {
        await setTimeout(100);
        if (this.isFinalState) {
          // stop() / a failure during the wait: settle start().
          r();
          return;
        }
        this.dtls.connect().catch((error) => {
          this.fail(error);
          log("dtls connect failed", error);
          f(error);
        });
      }
    });

    // A fatal alert raced with the end of the handshake.
    // (Narrowed by the checks above, the state may have changed meanwhile.)
    const state = this.state as DtlsState;
    if (state === "failed") throw new Error("dtls transport failed");
    // stop() raced with the end of the handshake: closed stays.
    if (state === "closed") return;

    try {
      // Fallback: a certificate the in-handshake check did not see.
      this.verifyRemoteCertificateFingerprint(this.dtls?.remoteCertificate);
    } catch (error) {
      const dtls = this.dtls;
      this.fail(certificateVerificationError(error));
      // Tell the peer (whose handshake already completed); a fatal alert
      // closes the DTLS transport once it has been sent.
      void dtls?.sendAlert(AlertLevel.fatal, AlertDesc.BadCertificate, {
        timeoutMs: DTLS_ALERT_SEND_TIMEOUT_MS,
      });
      throw error;
    }

    if (this.srtpProfiles.length > 0) {
      this.startSrtp();
    }
    this.setState("connected");

    log("dtls connected");
  }

  /** Settles a pending start() (set while the handshake is awaited). */
  private settleStart?: () => void;

  /** closed / failed: no later DTLS event changes the state any more. */
  private get isFinalState() {
    return this.state === "closed" || this.state === "failed";
  }

  /**
   * Move to failed (once; closed / failed are final) and fire the `error`
   * event with the DTLS alert that caused it.
   */
  private fail(error: unknown) {
    if (this.isFinalState) return;
    this.setState("failed");

    const rtcError =
      error instanceof RTCError
        ? error
        : error instanceof DtlsAlertError &&
            error.source === "local" &&
            error.reason instanceof FingerprintMismatchError
          ? // This side rejected the peer certificate during the handshake
            // (bad_certificate was sent).
            certificateVerificationError(error.reason)
          : error instanceof DtlsAlertError
            ? new RTCError(
                {
                  errorDetail: "dtls-failure",
                  ...(error.source === "remote"
                    ? { receivedAlert: error.description }
                    : { sentAlert: error.description }),
                },
                error.message,
              )
            : new RTCError({ errorDetail: "dtls-failure" }, String(error));
    const event: RTCDtlsTransportErrorEvent = {
      type: "error",
      error: rtcError,
    };
    try {
      this.onerror?.(event);
    } catch (e) {
      log("onerror handler failed", e);
    }
    // EventEmitter throws an "error" event nobody listens to.
    if (this.events.listenerCount("error") > 0) {
      this.events.emit("error", event);
    }
  }

  private verifyRemoteCertificateFingerprint(remoteCertificate?: Buffer) {
    if (
      !this.remoteParameters ||
      this.remoteParameters.fingerprints.length === 0
    ) {
      throw new Error("remote fingerprint not exist");
    }

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
      throw new FingerprintMismatchError();
    }
  }

  updateSrtpSession() {
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
  }

  startSrtp() {
    if (this.srtpStarted) return;
    this.srtpStarted = true;

    this.updateSrtpSession();

    this.iceTransport.connection.onData.subscribe((data) => {
      if (
        this.config.debug?.inboundPacketLoss &&
        this.config.debug?.inboundPacketLoss / 100 < Math.random()
      ) {
        return;
      }

      if (!isMedia(data)) return;
      // Nothing is processed after close_notify / a fatal alert.
      if (this.isFinalState) return;

      // Track received data statistics
      this.bytesReceived += data.length;
      this.packetsReceived++;

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
        try {
          this.onRtp.execute(rtp);
        } catch (error) {
          log("RTP error", error);
        }
      }
    });
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
      const enc = this.srtp.encrypt(payload, header);

      if (
        this.config.debug?.outboundPacketLoss &&
        this.config.debug?.outboundPacketLoss / 100 < Math.random()
      ) {
        return { size: enc.length, sendingAtMs: milliTime() };
      }

      // Track statistics
      this.bytesSent += enc.length;
      this.packetsSent++;

      const sendingAtMs = milliTime();
      await this.iceTransport.connection.send(enc).catch(() => {});
      return { size: enc.length, sendingAtMs };
    } catch (error) {
      log("failed to send", error);
      return { size: 0, sendingAtMs: milliTime() };
    }
  }

  async sendRtcp(packets: RtcpPacket[]) {
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    const enc = this.srtcp.encrypt(payload);

    if (
      this.config.debug?.outboundPacketLoss &&
      this.config.debug?.outboundPacketLoss / 100 < Math.random()
    ) {
      return enc.length;
    }

    // Track statistics
    this.bytesSent += enc.length;
    this.packetsSent++;

    await this.iceTransport.connection.send(enc).catch(() => {});
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

  /**
   * 1. closed, synchronously and without statechange (W3C webrtc-pc
   *    `close()`).
   * 2. close_notify to the peer (RFC 5246 §7.2.1), encrypted once the
   *    handshake reached epoch 1, plaintext while it is still at epoch 0. It
   *    is awaited for at most {@link DTLS_ALERT_SEND_TIMEOUT_MS}, so a dead
   *    ICE path cannot hold the close. Nothing is sent after a fatal alert,
   *    a received close_notify, or when ICE is already closed / failed.
   * 3. ICE stops (the alert must reach ICE before it closes).
   * 4. The DTLS socket closes, so a handshake still in flight stops
   *    retransmitting.
   */
  private async runStop() {
    try {
      const dtls = this.dtls;
      this.setState("closed", false);
      // A start() still waiting for the handshake ends here (closed stays).
      this.settleStart?.();
      if (
        dtls &&
        !dtls.terminated &&
        !["closed", "failed"].includes(this.iceTransport.state)
      ) {
        log("send close_notify", this.iceTransport.state);
        await dtls.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify, {
          timeoutMs: DTLS_ALERT_SEND_TIMEOUT_MS,
        });
      } else if (dtls?.terminated) {
        // The peer's close_notify is being answered: let that reply reach ICE
        // before ICE stops.
        await dtls.alertFlushed();
      } else {
        log("skip close_notify", {
          dtls: !!dtls,
          terminated: dtls?.terminated,
          ice: this.iceTransport.state,
        });
      }
      await this.iceTransport.stop();
      await dtls?.close();
    } finally {
      this.onStopped.execute();
      this.onStopped.complete();
    }
  }

  async getStats(timestamp = getStatsTimestamp()): Promise<RTCStats[]> {
    const stats: RTCStats[] = [];

    const transportId = generateStatsId("transport", this.id);

    // Transport stats
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
      remoteCertificateId: this.dtls?.remoteCertificate
        ? generateStatsId("certificate", this.id, "remote")
        : undefined,
      dtlsRole: this.role === "auto" ? undefined : this.role,
      tlsVersion: formatDtlsVersion(this.dtls?.dtls.version),
      dtlsCipher: this.dtls?.cipher.cipher?.name,
      srtpCipher: formatSrtpCipher(this.dtls?.srtp.srtpProfile),
      iceRestarts: this.iceTransport.iceRestarts,
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

    if (
      this.remoteParameters &&
      this.remoteParameters.fingerprints.length > 0 &&
      this.dtls?.remoteCertificate
    ) {
      const certStats: RTCCertificateStats = {
        type: "certificate",
        id: generateStatsId("certificate", this.id, "remote"),
        timestamp,
        fingerprint: this.remoteParameters.fingerprints[0].value,
        fingerprintAlgorithm: this.remoteParameters.fingerprints[0].algorithm,
        base64Certificate: Buffer.from(this.dtls.remoteCertificate).toString(
          "base64",
        ),
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
  public certPem: string;
  public signatureHash: SignatureHash;

  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    certPem: string,
    signatureHash: SignatureHash,
  ) {
    this.certPem = certPem;
    this.signatureHash = signatureHash;
    this.certPem = normalizePem(certPem);
    const cert = new X509Certificate(this.certPem);
    this.publicKey = cert.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    this.privateKey = createPrivateKey(normalizePem(privateKeyPem))
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(new X509Certificate(this.certPem).raw, "sha256"),
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
  public algorithm: string;
  public value: string;

  constructor(algorithm: string, value: string) {
    this.algorithm = algorithm;
    this.value = value;
  }
}

export class RTCDtlsParameters {
  public fingerprints: RTCDtlsFingerprint[];
  public role: "auto" | "client" | "server";

  constructor(
    fingerprints: RTCDtlsFingerprint[] = [],
    role: "auto" | "client" | "server",
  ) {
    this.fingerprints = fingerprints;
    this.role = role;
  }
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
  private ice: IceConnection;

  closed: boolean = false;
  constructor(ice: IceConnection) {
    this.ice = ice;
    ice.onData.subscribe((buf) => {
      if (isDtls(buf)) {
        if (this.onData) {
          this.onData(buf);
        }
      }
    });
  }
  onData: (buf: Buffer) => void = () => {};

  get address() {
    return {} as AddressInfo;
  }

  type: string = "ice";

  readonly send = (data: Buffer) => {
    return this.ice.send(data);
  };

  async close() {
    if (this.closed) return;
    this.closed = true;
    // RTCIceTransport.stop() may have closed the agent already.
    if (this.ice.state !== "closed") this.ice.close();
  }
}

const createIceTransport = (ice: IceConnection) => new IceTransport(ice);
