import { decode, types } from "@shinyoshiaki/binary-data";

import { setTimeout } from "timers/promises";
import { Event, EventDisposer, debug } from "./imports/common";
import type { Address, Transport } from "./imports/common";

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
import { EllipticCurves } from "./handshake/extensions/ellipticCurves";
import { ExtendedMasterSecret } from "./handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "./handshake/extensions/renegotiationIndication";
import { Signature } from "./handshake/extensions/signature";
import { UseSRTP } from "./handshake/extensions/useSrtp";
import type { Alert } from "./handshake/message/alert";
import type { SrtpProfile } from "./imports/rtp";
import { createPlaintext } from "./record/builder";
import { AlertDesc, ContentType } from "./record/const";
import { FragmentedHandshake } from "./record/message/fragment";
import { parsePacket, parsePlainText } from "./record/receive";
import type { Extension } from "./typings/domain";
import {
  DtlsVersion,
  ProtocolVersionError,
  normalizeProtocolVersions,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/socket.ts : log");
const err = debug("werift-dtls : packages/dtls/src/socket.ts : err");

export class DtlsSocket {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onError = new Event<[Error]>();
  readonly onClose = new Event();
  readonly transport: TransportContext;
  cipher: CipherContext;
  dtls: DtlsContext;
  srtp: SrtpContext = new SrtpContext();

  connected = false;
  extensions: Extension[] = [];
  onHandleHandshakes!: (assembled: FragmentedHandshake[]) => Promise<void>;

  private bufferFragmentedHandshakes: FragmentedHandshake[] = [];

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

  constructor(
    public options: Options,
    public sessionType: SessionTypes,
  ) {
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

  protected udpOnMessage = (
    data: Buffer,
    _addr?: import("./imports/common").Address,
  ) => {
    this.handleUdpDatagram(data);
  };

  /**
   * Process one UDP datagram on the DTLS 1.2 record path.
   * Subclasses (dual client) may intercept before calling this.
   */
  protected handleUdpDatagram(data: Buffer): void {
    // Terminal association: drop all RX (no onData / handshake resume after fatal).
    if (this.associationTornDown) return;

    const packets = parsePacket(data);

    for (const packet of packets) {
      try {
        // Re-check: async fatal during multi-record datagram must stop mid-loop.
        if (this.associationTornDown) return;
        const messages = parsePlainText(this.dtls, this.cipher)(packet);
        for (const message of messages) {
          if (this.associationTornDown) return;
          switch (message.type) {
            case ContentType.handshake:
              {
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
                  // Handshake failure is association-fatal: tear down (not onError-only).
                  // Idempotent if a concurrent fatal already closed the association.
                  const e =
                    error instanceof Error ? error : new Error(String(error));
                  this.reportLegacy12Fatal(e);
                });
              }
              break;
            case ContentType.applicationData:
              {
                // Never deliver app data after association terminal teardown.
                if (this.associationTornDown) return;
                this.onData.execute(message.data as Buffer);
              }
              break;
            case ContentType.alert:
              {
                const alert = message.data as Alert | undefined;
                if (!alert) break;
                // Association lifecycle (aligned with 1.3 / TLS 1.2):
                //   fatal / protocol_version → fail association (onError + tear down)
                //   close_notify             → graceful association close
                //   other warning            → log / continue (not connection close)
                if (
                  alert.level >= 2 ||
                  alert.description === AlertDesc.ProtocolVersion
                ) {
                  const fe =
                    alert.description === AlertDesc.ProtocolVersion
                      ? new ProtocolVersionError(
                          "peer rejected protocol version (alert protocol_version)",
                        )
                      : new Error(
                          `alert fatal error: ${
                            AlertDesc[alert.description] ?? alert.description
                          }`,
                        );
                  // Tear down association *before* onError so handlers observe
                  // connected=false / dualPhase=closed / Public API disabled.
                  this.reportLegacy12Fatal(fe);
                } else if (alert.description === AlertDesc.CloseNotify) {
                  this.onLegacy12PeerCloseNotify();
                } else {
                  log(
                    this.dtls.sessionId,
                    "DTLS 1.2 warning alert (continue)",
                    AlertDesc[alert.description] ?? alert.description,
                  );
                }
              }
              break;
          }
        }
      } catch (error) {
        err(this.dtls.sessionId, "catch udpOnMessage error", error);
      }
    }
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
    const host =
      addr[0] === "0.0.0.0"
        ? "127.0.0.1"
        : addr[0] === "::" || addr[0] === "[::]"
          ? "::1"
          : addr[0];
    this.transport.pinnedPeer = [host, addr[1]];
  }

  /** Pin from last transport rinfo when present (never overwrites existing pin). */
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
    this.assertReadyForApplicationApi("send");
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
    this.abortAssociationWaits();
    this.clearSendPeerPin();
    void this.transport.socket.close().catch(() => {});
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
    this.onError.execute(error);
    this.onClose.execute();
  }

  /**
   * Local close for pure DTLS 1.2 (server and non-overridden paths).
   * Terminal transition + optional single public onClose (client dual uses
   * closeAssociationHard instead).
   */
  protected closeLegacy12Association(firePublicOnClose = true): void {
    if (this.associationTornDown) return;
    this.abortLegacy12Flight();
    this.connected = false;
    this.associationTornDown = true;
    this.abortAssociationWaits();
    this.clearSendPeerPin();
    if (firePublicOnClose) {
      this.onClose.execute();
    }
    void this.transport.socket.close().catch(() => {});
  }

  /**
   * Peer close_notify on DTLS 1.2 path: best-effort reply, then graceful
   * association close (connected=false, timers cancel, onClose, transport).
   * Dual client overrides for phase/carrier/transport ownership.
   */
  protected onLegacy12PeerCloseNotify(): void {
    if (this.associationTornDown) return;
    // Mark torn-down first so re-entrant send/exporter fail while reply is in flight.
    this.abortLegacy12Flight();
    this.connected = false;
    this.associationTornDown = true;
    this.abortAssociationWaits();
    // Keep TX pin until close_notify is sent so reply still reaches the peer.
    void this.sendLegacy12CloseNotify().finally(() => {
      this.clearSendPeerPin();
      this.onClose.execute();
      void this.transport.socket.close().catch(() => {});
    });
  }

  /** Best-effort close_notify on the current 1.2 write epoch. */
  protected async sendLegacy12CloseNotify(): Promise<void> {
    try {
      const alert = Buffer.from([1, AlertDesc.CloseNotify]); // warning
      const pkt = createPlaintext(this.dtls)(
        [{ type: ContentType.alert, fragment: alert }],
        ++this.dtls.recordSequenceNumber,
      )[0];
      // Post-handshake alerts are encrypted when epoch > 0 (keys established).
      const wire =
        this.dtls.epoch > 0
          ? this.cipher.encryptPacket(pkt).serialize()
          : pkt.serialize();
      await this.transport.send(wire);
    } catch (e) {
      log(this.dtls.sessionId, "sendLegacy12CloseNotify failed", e);
    }
  }

  close() {
    if (this.engine13) {
      this.engine13.close();
      return;
    }
    // DTLS 1.2 server (and any non-overridden close): terminal + onClose once.
    this.closeLegacy12Association(true);
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
    void this.transport.socket.close().catch(() => {});
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
    void this.transport.socket.close().catch(() => {});
  }

  /**
   * Wire DTLS 1.3 engine events onto this socket.
   * @param filterError return true to swallow the error (e.g. dual-stack version
   *   mismatch handled by transparent fallback without public onError).
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
        // re-entrantly do not double-fire onClose.
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
   */
  protected async sendPlaintextAlert(description: number): Promise<void> {
    const alert = Buffer.from([2, description]); // fatal
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.alert, fragment: alert }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    await this.transport.send(pkt.serialize());
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
   * Both roles use the same {@link selectVersion} semantics:
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
   * DTLS 1.3 named groups preference order (key_share).
   * Default: X25519 then P-256. Use `[NamedCurveAlgorithm.secp256r1_23]` for P-256 only.
   */
  namedGroups?: readonly NamedCurveAlgorithms[];
  /** DTLS 1.3 carrier MTU hint for handshake fragmentation (bytes). */
  mtu?: number;
}

/**
 * @internal
 * Internal options for unit tests and Epic 2 SPED carrier injection.
 * **Not part of the stable Public API** — never pass to the public constructors.
 * Use {@link createDtlsClientInternal} / {@link createDtlsServerInternal} instead.
 * `handshakeCarrier` is intentionally excluded from {@link Options}.
 */
export type DtlsInternalOptions = Options & {
  handshakeCarrier?: import("./carrier/types").DtlsHandshakeCarrier;
};

export { DtlsVersion };
