import { setImmediate, setTimeout } from "timers/promises";
import {
  classifyAlert,
  createAlertRecord,
  type DtlsAlert,
  DtlsAlertError,
} from "./alert";
import {
  NamedCurveAlgorithmList,
  type SignatureHash,
  signatures,
} from "./cipher/const";
import { exportKeyingMaterial } from "./cipher/prf";
import { SessionType, type SessionTypes } from "./cipher/suites/abstract";
import { CipherContext } from "./context/cipher";
import { DtlsContext } from "./context/dtls";
import { SrtpContext } from "./context/srtp";
import { TransportContext } from "./context/transport";
import { EllipticCurves } from "./handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "./handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "./handshake/extensions/renegotiationIndication";
import { Signature } from "./handshake/extensions/signature";
import { UseSRTP } from "./handshake/extensions/useSrtp";
import type { Address, Transport } from "./imports/common";
import { binaryData, debug, Event } from "./imports/common";
import type { SrtpProfile } from "./imports/rtp";
import { createPlaintext } from "./record/builder";
import { AlertDesc, AlertLevel, ContentType } from "./record/const";
import { FragmentedHandshake } from "./record/message/fragment";
import { parsePacket, parsePlainText } from "./record/receive";
import type { Extension } from "./typings/domain";

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
  onHandleHandshakes!: (assembled: FragmentedHandshake[]) => Promise<void>;

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

  constructor(options: Options, sessionType: SessionTypes) {
    this.options = options;
    this.sessionType = sessionType;
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

  renegotiation() {
    log("renegotiation", this.sessionType);
    this.connected = false;
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
  }

  /**
   * Resolves once the alert being sent (e.g. the close_notify answering the
   * peer's) has been handed to the transport or timed out. Resolves
   * immediately when none is in flight. Never rejects.
   */
  alertFlushed(): Promise<void> {
    return this.alertSending ?? Promise.resolve();
  }

  /** Whether the connection ended (alert, or close()). */
  get terminated() {
    return this.ended;
  }

  /**
   * Whether the handshake must not go on: the connection ended, or this side
   * sent close_notify (RFC 5246 §7.2.1: nothing is sent after it, so a
   * handshake that would answer or complete stops; records received after it
   * are still processed, to receive the peer's close_notify).
   */
  protected get handshakeStopped() {
    return this.ended || this.alertSent;
  }

  private udpOnMessage = (data: Buffer) => {
    if (this.ended) return;
    const packets = parsePacket(data);

    for (const packet of packets) {
      // An alert earlier in this datagram may have ended the connection.
      if (this.ended) return;
      try {
        const messages = parsePlainText(this.dtls, this.cipher)(packet);
        for (const message of messages) {
          // An alert earlier in this record (e.g. close_notify followed by a
          // fatal alert) may have ended the connection: the rest is ignored.
          if (this.ended) return;
          switch (message.type) {
            case ContentType.handshake:
              {
                // Once the handshake completed, a handshake record of an
                // epoch older than the peer's authenticated one (a plaintext
                // epoch-0 Certificate, ClientHello, ...) is unauthenticated:
                // anyone on the path can inject it, so it must not change
                // the session (overwrite the peer certificate and fail its
                // check, or reset the session through renegotiation()). It
                // is dropped. A legitimate retransmission of the peer's last
                // flight still carries its Finished at the current epoch.
                if (
                  this.connected &&
                  packet.recordLayerHeader.epoch < this.dtls.remoteEpoch
                ) {
                  log(
                    this.dtls.sessionId,
                    "drop a stale-epoch handshake record after the handshake",
                    packet.recordLayerHeader.epoch,
                  );
                  continue;
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

                this.onHandleHandshakes(assembled).catch((error) => {
                  err(this.dtls.sessionId, "onHandleHandshakes error", error);
                  this.notify(this.onError, error);
                });
              }
              break;
            case ContentType.applicationData:
              {
                this.notify(this.onData, message.data as Buffer);
              }
              break;
            case ContentType.alert:
              this.handleAlert(message.data as DtlsAlert);
              break;
          }
        }
      } catch (error) {
        // An invalid record (e.g. failed to decrypt) is discarded
        // (RFC 6347 §4.1.2.1).
        err(this.dtls.sessionId, "catch udpOnMessage error", error);
      }
    }
  };

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
      // RFC 5246 §7.2.1: respond with close_notify; nothing is sent after it.
      void this.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
      // The connection is over: the socket closes its transport once the
      // reply has been sent or timed out, like after a fatal alert (the
      // application does not need to call close()).
      void this.alertFlushed().then(() => this.closeTransport());
      this.notify(this.onAlert, alert);
      this.notify(this.onClose);
    } else {
      err(this.dtls.sessionId, "received fatal alert", alert);
      // A fatal alert is not answered (RFC 5246 §7.2.2).
      this.alertSent = true;
      this.closeTransport();
      this.notify(this.onAlert, alert);
      this.notify(this.onError, new DtlsAlertError(alert, "remote"));
    }
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

  private setupExtensions() {
    log(this.dtls.sessionId, "support srtpProfiles", this.options.srtpProfiles);
    if (this.options.srtpProfiles && this.options.srtpProfiles.length > 0) {
      const useSrtp = UseSRTP.create(
        this.options.srtpProfiles,
        Buffer.from([0x00]),
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

  protected waitForReady = (condition: () => boolean) =>
    new Promise<void>(async (r, f) => {
      for (let i = 0; i < 10; i++) {
        if (condition()) {
          r();
          break;
        } else {
          await setTimeout(100 * i);
        }
      }
      f("waitForReady timeout");
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
   * send application data. Nothing is sent once close_notify or a fatal
   * alert has been sent or received.
   */
  send = async (buf: Buffer, addr?: Address) => {
    if (this.alertSent || this.ended) {
      log(this.dtls.sessionId, "drop application data after alert");
      return;
    }
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    await this.transport.send(this.cipher.encryptPacket(pkt).serialize(), addr);
  };

  /**
   * Close the socket: received records are no longer processed and a
   * handshake flight stops retransmitting.
   *
   * - `close()`: sends no alert of its own and closes the transport right
   *   away, except that an alert already being sent (`sendAlert()`, the
   *   close_notify answering the peer's) is let through first: the transport
   *   closes once it has been sent or timed out.
   * - `close({ notify: true })`: sends close_notify first and closes the
   *   transport once it has been sent, or after `timeoutMs`
   *   (default {@link DtlsSocket.AlertSendTimeoutMs}).
   *
   * The returned promise resolves once the transport is closed (also when
   * the close was already started, e.g. after a fatal alert: it waits for
   * that close) and never rejects; a failing transport close() (a rejection
   * or a synchronous throw) is only logged.
   */
  async close(options: { notify?: boolean; timeoutMs?: number } = {}) {
    if (options.notify) {
      const sending = this.sendAlert(
        AlertLevel.warning,
        AlertDesc.CloseNotify,
        {
          ...(options.timeoutMs !== undefined && {
            timeoutMs: options.timeoutMs,
          }),
        },
      );
      this.ended = true;
      this.transport.stopFlights();
      await sending;
    }
    this.ended = true;
    this.transport.stopFlights();
    // Closing the transport now would drop an alert handed to it but not
    // yet written (a UDP datagram goes out on a later tick).
    await this.alertFlushed();
    // Waits for a close already in progress (e.g. after a fatal alert).
    await this.closeTransport();
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
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
    return this.cipher.remoteCertificate;
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
