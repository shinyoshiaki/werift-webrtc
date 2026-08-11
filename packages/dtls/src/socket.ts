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

  protected udpOnMessage = (data: Buffer) => {
    this.handleUdpDatagram(data);
  };

  /**
   * Process one UDP datagram on the DTLS 1.2 record path.
   * Subclasses (dual client) may intercept before calling this.
   */
  protected handleUdpDatagram(data: Buffer): void {
    const packets = parsePacket(data);

    for (const packet of packets) {
      try {
        const messages = parsePlainText(this.dtls, this.cipher)(packet);
        for (const message of messages) {
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
                  this.onError.execute(error);
                });
              }
              break;
            case ContentType.applicationData:
              {
                this.onData.execute(message.data as Buffer);
              }
              break;
            case ContentType.alert:
              {
                const alert = message.data as Alert | undefined;
                if (alert && alert.description === AlertDesc.ProtocolVersion) {
                  // 1.2-only peer × 1.3-only server: protocol_version(70)
                  const pe = new ProtocolVersionError(
                    "peer rejected protocol version (alert protocol_version)",
                  );
                  this.dtls.fatalError = pe;
                  this.onError.execute(pe);
                } else if (alert && alert.level >= 2) {
                  const fe = new Error(
                    `alert fatal error: ${
                      AlertDesc[alert.description] ?? alert.description
                    }`,
                  );
                  this.dtls.fatalError = fe;
                  this.onError.execute(fe);
                } else {
                  this.onClose.execute();
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

  /**send application data */
  send = async (buf: Buffer, addr?: Address) => {
    if (this.engine13) {
      await this.engine13.send(buf);
      return;
    }
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    await this.transport.send(this.cipher.encryptPacket(pkt).serialize(), addr);
  };

  close() {
    if (this.engine13) {
      this.engine13.close();
      return;
    }
    this.transport.socket.close();
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
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
    if (this.engine13) {
      return this.engine13.remoteCertificate;
    }
    return this.cipher.remoteCertificate;
  }

  /** Request KeyUpdate on DTLS 1.3 connections. */
  async keyUpdate(requestUpdate = false): Promise<void> {
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
    this.connected = false;
    // Unbridge first so subsequent engine onClose/onError cannot re-enter or
    // double-fire public callbacks when fail() continues to onClose.
    this.unbridgeEngine13();
    const eng = this.engine13;
    this.engine13 = undefined;
    if (eng) {
      // Soft ProtocolVersionError leaves carrier open; hard fail may already
      // have closed it. Always force resource dispose without re-firing events.
      eng.hardDisposeResources();
      // Ensure transport is dead so late inject / retransmit cannot continue.
      void this.transport.socket.close().catch(() => {});
    }
    // Engine hard-fail would have fired onClose after onError, but unbridge
    // removed that subscription — association owns the single public onClose.
    return true;
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
        // Keep public DtlsSocket.connected in sync with engine teardown
        // (peer close_notify or local close).
        this.connected = false;
        // Fire public onClose first so handlers can still inspect engine13.
        this.onClose.execute();
        // Then drop the public 1.3 handle (isDtls13 → false) and bridge.
        if (this.engine13) {
          this.unbridgeEngine13();
          this.engine13 = undefined;
        }
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
