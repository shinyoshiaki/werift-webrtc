/**
 * DTLS 1.3 endpoint (client or server) over direct datagrams.
 *
 * Class hierarchy (read bottom-up against index.ts Figure 3):
 *   Dtls13Connection          — public API (connect / send / KeyUpdate / close)
 *     └─ HandshakeFlights     — Flight 1–5 + post-HS KeyUpdate handlers
 *         └─ RecordRx         — inbound records, reassembly, ACK/alert
 *             └─ FlightTx     — outbound flights, retransmit, anti-amp
 *                 └─ Base     — session state, epochs, fail lifecycle
 *
 * Mutable crypto state stays in this stack; isolated from the DTLS 1.2 engine.
 */
import type { NamedCurveAlgorithms } from "../../cipher/const";
import type { SessionTypes } from "../../cipher/suites/abstract";
import { HandshakeType } from "../../handshake/const";
import { peerKeyFromAddr } from "../../handshake/extensions/cookie";
import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { AlertDesc, ContentType } from "../../record/const";
import {
  encryptRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import { Dtls13HandshakeFlights } from "./handshake-flights";
import { HandshakeTranscript } from "./transcript";
import type { Dtls13Options } from "./types";

export type { AddressValidationMode, Dtls13Options } from "./types";

/** Map unspecified bind addresses to loopback for client peer pin / TX. */
function normalizeClientDest(addr: [string, number]): [string, number] {
  const host = addr[0];
  if (host === "0.0.0.0") return ["127.0.0.1", addr[1]];
  if (host === "::" || host === "[::]") return ["::1", addr[1]];
  return addr;
}

/** Material for dual-cookie-path resume into a fresh 1.3 engine. */
export type DualResumeClientHello = {
  clientHelloBody: Buffer;
  keyPair: {
    publicKey: Buffer;
    privateKey: Buffer;
    curve: NamedCurveAlgorithms;
  };
  group: NamedCurveAlgorithms;
};

export class Dtls13Connection extends Dtls13HandshakeFlights {
  constructor(options: Dtls13Options, sessionType: SessionTypes) {
    super(options, sessionType);
  }

  async connect(): Promise<void> {
    if (this.role !== "client") {
      throw new Error("connect() is client-only");
    }
    // Pin the configured remote 5-tuple at connect (RFC 9147: no silent
    // migration). A forged HRR/ServerHello from another source must not
    // redirect ClientHello2 or subsequent TX.
    // Normalize wildcard bind addresses (0.0.0.0 / ::) to loopback so demux
    // matches the actual UDP source of local peers (tests set rinfo from
    // UdpTransport.address which is often 0.0.0.0:port).
    const raw = this.addrToTuple(this.peerFromTransport());
    if (raw) {
      const dest = normalizeClientDest(raw);
      this.peerAddr = dest;
      this.pinPeer(`${dest[0]}:${dest[1]}`, dest);
    }
    this.hsPhase = "wait_server_hello";
    await this.sendClientHello();
  }

  async send(buf: Buffer): Promise<void> {
    // closing/closed: Public API must fail immediately (close vs send race).
    if (this.closed || this.closing) {
      throw new Error("DTLS association is closed; cannot send");
    }
    if (!this.connected && this.writeEpoch < 3) {
      throw new Error("DTLS 1.3 not ready to send application data");
    }
    // TLS 1.3 / RFC 9147: after update_requested, send response KeyUpdate before
    // further application data. Hold app data while the response is deferred.
    if (this.deferredKeyUpdateResponse || this.keyUpdateResponseAfterAck) {
      throw new Error(
        "KeyUpdate response pending; application data blocked until response KeyUpdate is sent",
      );
    }
    const ep = this.epochs.get(this.writeEpoch);
    if (!ep?.writeKeys) throw new Error("no application write keys");
    const record = encryptRecord(buf, ContentType.applicationData, ep);
    await this.options.transport.send(record, this.getSendAddr());
  }

  exportKeyingMaterial(label: string, length: number): Buffer {
    if (!this.exporterMasterSecret) {
      throw new Error("exporter not available");
    }
    return this.keySchedule.exportKeyingMaterial(
      this.exporterMasterSecret,
      label,
      Buffer.alloc(0),
      length,
    );
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
    const keyingMaterial = this.exportKeyingMaterial(
      "EXTRACTOR-dtls_srtp",
      keyLength * 2 + saltLength * 2,
    );
    const clientKey = keyingMaterial.subarray(0, keyLength);
    const serverKey = keyingMaterial.subarray(keyLength, keyLength * 2);
    const clientSalt = keyingMaterial.subarray(
      keyLength * 2,
      keyLength * 2 + saltLength,
    );
    const serverSalt = keyingMaterial.subarray(keyLength * 2 + saltLength);
    if (this.role === "client") {
      return {
        localKey: clientKey,
        localSalt: clientSalt,
        remoteKey: serverKey,
        remoteSalt: serverSalt,
      };
    }
    return {
      localKey: serverKey,
      localSalt: serverSalt,
      remoteKey: clientKey,
      remoteSalt: clientSalt,
    };
  }

  close() {
    if (this.closed) return;
    // Sync terminal + cancel RTO/prune/carrier timers before any notify.
    this.beginGracefulClose();
    // RFC 8446: best-effort close_notify. Do not hold carrier/teardown on a
    // stalled transport.send Promise — race notify against a short budget.
    this.finishGracefulCloseWithOptionalNotify();
  }

  /** Best-effort close_notify on current write epoch. */
  protected async sendCloseNotify(): Promise<void> {
    if (this.localCloseNotifySent) return;
    try {
      const alert = Buffer.from([1, AlertDesc.CloseNotify]); // warning level
      const ep = this.epochs.get(this.writeEpoch);
      if (ep?.writeKeys) {
        const record = encryptRecord(alert, ContentType.alert, ep);
        this.localCloseNotifySent = true;
        await this.options.transport.send(record, this.getSendAddr());
      } else if (!this.hasProtectedWriteKeys()) {
        const seq = this.recordSeqEpoch0++;
        const record = serializePlaintextRecord(
          ContentType.alert,
          0,
          seq,
          alert,
        );
        this.localCloseNotifySent = true;
        await this.options.transport.send(record, this.getSendAddr());
      }
    } catch {
      // ignore send failures during close
    }
  }

  /**
   * Kick off optional close_notify then free association resources even if
   * transport.send never settles (P2: hung Promise must not leak carrier).
   */
  private finishGracefulCloseWithOptionalNotify(): void {
    const canSendCloseNotify =
      !this.localCloseNotifySent &&
      !!this.epochs.get(this.writeEpoch)?.writeKeys;
    if (!canSendCloseNotify) {
      this.teardownAssociation();
      return;
    }
    const notify = this.sendCloseNotify().catch(() => {});
    // Prefer completing notify quickly; always teardown by budget so a hung
    // transport.send cannot leak carrier/timers (beginGracefulClose already
    // cancelled RTO/prune; teardown closes carrier).
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.teardownAssociation();
    };
    const timer = setTimeout(finish, 250);
    void notify.finally(() => {
      clearTimeout(timer);
      finish();
    });
  }

  /**
   * Peer sent close_notify: record boundary, stop retransmits, reply close_notify,
   * then full teardown so public state matches local close() (onClose + !connected).
   * Terminal (onClosing) is synchronous so Public API rejects before notify completes.
   */
  protected onPeerCloseNotify(epoch: number, sequenceNumber: number): void {
    this.peerCloseBoundary = { epoch, sequenceNumber };
    if (this.closed) return;
    // Snapshot whether we still need a reply *before* beginGracefulClose.
    const shouldReply =
      !this.localCloseNotifySent &&
      !!this.epochs.get(this.writeEpoch)?.writeKeys;
    this.beginGracefulClose();
    if (shouldReply) {
      this.finishGracefulCloseWithOptionalNotify();
      return;
    }
    this.teardownAssociation();
  }

  /**
   * Expected association peer key (pinned or provisional), for dual demux
   * before version commit. Undefined if no peer is associated yet.
   */
  getExpectedPeerKey(): string | undefined {
    return this.expectedPeerKey();
  }

  /** Pinned peer address tuple for association TX ownership (copy). */
  getPeerAddr(): [string, number] | undefined {
    return this.peerAddr
      ? ([this.peerAddr[0], this.peerAddr[1]] as [string, number])
      : undefined;
  }

  /**
   * True when `addr` matches the engine peer pin (or no pin is set yet).
   * Used by DtlsClient association dispatcher so spoofed SH cannot commit
   * version before the engine would drop the packet.
   */
  matchesAssociationPeer(
    addr?: [string, number] | { address?: string; port?: number } | string,
  ): boolean {
    return this.allowsAssociationPeer(peerKeyFromAddr(addr));
  }

  /** Test helper: pending retransmittable flight length. */
  getPendingFlightSize(): number {
    return this.pendingFlight.length;
  }

  /** Test helper: pending flight record numbers still awaiting full ACK. */
  getPendingFlightRecordCount(): number {
    return this.pendingFlightRecords.length;
  }

  /**
   * Dual-stack soft version transition: stop 1.3 timers / RX ownership without
   * permanently closing the carrier. Injected carriers (Epic 2) must remain
   * reusable when the association resumes a fresh 1.3 engine on the same
   * instance. Hard close() is only for association teardown.
   *
   * Prefer {@link parkForDualProbe} / unpark when HVR starts a dual probe so
   * original CH-A retransmit continues (RFC 9147 loss recovery).
   */
  releaseForVersionFallback(): void {
    this.clearPendingFlight();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    // Detach inject so this dead engine no longer receives SPED reinjects.
    // Do NOT carrier.close() — soft transition must not kill shared carriers.
    this.carrier.setInjectHandler(() => {});
    this.dualProbeParked = false;
    this.closed = true;
  }

  /**
   * Leave dual-probe park after association commits to DTLS 1.3 (genuine
   * SH/HRR for the original CH-A).
   *
   * Does **not** rebind transport.onData / carrier.inject — the dual
   * association keeps RX ownership and forwards to this engine via
   * {@link injectDatagram}. Stealing RX here would bypass association
   * closed/committed guards and late-packet policy.
   */
  unparkFromDualProbe(): void {
    this.dualProbeParked = false;
    this.closed = false;
  }

  /**
   * Dual probing: point carrier.inject at the association demux so SPED /
   * custom carriers do not bypass DtlsClient (which would complete 1.3 on the
   * parked engine while public engine13 stays undefined).
   */
  bindInjectToAssociation(
    handler: (
      bytes: Buffer,
      peer?: [string, number] | { address?: string; port?: number } | string,
    ) => void,
  ): void {
    this.carrier.setInjectHandler(handler);
  }

  /** Handshake carrier (default or injected). Used by association dual demux. */
  getHandshakeCarrier() {
    return this.carrier;
  }

  /** True while dual-probing after HVR (CH-A retransmit still active). */
  isDualProbeParked(): boolean {
    return this.dualProbeParked;
  }

  /**
   * Snapshot the ClientHello already sent by this engine so dual association
   * can re-send the **same** CH (same random) with a DTLS 1.2 HVR cookie.
   * Creating a fresh CH would desync server flight2 remoteRandom / keying.
   */
  exportDualResumeClientHello(): DualResumeClientHello | undefined {
    if (this.role !== "client" || !this.firstClientHelloBody) return undefined;
    return {
      clientHelloBody: Buffer.from(this.firstClientHelloBody),
      keyPair: {
        publicKey: Buffer.from(this.localKeyPair.publicKey),
        privateKey: Buffer.from(this.localKeyPair.privateKey),
        curve: this.localKeyPair.curve,
      },
      group: this.selectedGroup,
    };
  }

  /**
   * Dual cookie path → DTLS 1.3 resume: adopt a ClientHello already on the wire
   * (with matching ECDHE key pair) so a subsequent ServerHello/HRR can continue
   * without re-sending CH1. Does not transmit.
   */
  primeFromSentClientHello(material: DualResumeClientHello): void {
    if (this.role !== "client") {
      throw new Error("primeFromSentClientHello is client-only");
    }
    if (this.connected) {
      throw new Error("primeFromSentClientHello: already connected");
    }
    // Engine may have been constructed fresh (closed=false); ensure RX is live.
    this.closed = false;

    const ch = ClientHello.deSerialize(material.clientHelloBody);
    this.clientRandom = DtlsRandom.from(ch.random as any);
    this.sessionId = Buffer.from(ch.sessionId ?? Buffer.alloc(0));
    this.localKeyPair = {
      publicKey: Buffer.from(material.keyPair.publicKey),
      privateKey: Buffer.from(material.keyPair.privateKey),
      curve: material.keyPair.curve ?? material.group,
    };
    this.selectedGroup = material.group;
    this.initialKeyShareGroups = [material.group];
    this.firstClientHelloBody = Buffer.from(material.clientHelloBody);
    this.transcript = new HandshakeTranscript();
    this.transcript.add(
      HandshakeType.client_hello_1,
      this.firstClientHelloBody,
    );
    this.messageSeq = 0;
    this.hsPhase = "wait_server_hello";
    this.clientOfferedExtensionTypes = new Set(
      ch.extensions.map((e) => e.type),
    );
    this.clientExpectsServerFlight = true;
    this.awaitingHrr = false;
    this.hrrCount = 0;

    const raw = this.addrToTuple(this.peerFromTransport());
    if (raw) {
      const dest = normalizeClientDest(raw);
      this.peerAddr = dest;
      this.pinPeer(`${dest[0]}:${dest[1]}`, dest);
    }
  }
}
