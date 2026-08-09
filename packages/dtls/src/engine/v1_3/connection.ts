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
import type { SessionTypes } from "../../cipher/suites/abstract";
import { AlertDesc, ContentType } from "../../record/const";
import {
  encryptRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import { Dtls13HandshakeFlights } from "./handshake-flights";
import type { Dtls13Options } from "./types";

export type { AddressValidationMode, Dtls13Options } from "./types";

export class Dtls13Connection extends Dtls13HandshakeFlights {
  constructor(options: Dtls13Options, sessionType: SessionTypes) {
    super(options, sessionType);
  }

  async connect(): Promise<void> {
    if (this.role !== "client") {
      throw new Error("connect() is client-only");
    }
    // Set explicit TX destination from transport.rinfo before any send so
    // UdpTransport last-rinfo cannot redirect ClientHello / retransmits.
    // Do NOT pin yet: bind address may be 0.0.0.0 while wire source is 127.0.0.1;
    // provisional/pin locks to the first real inbound peer (then markConnected).
    const dest = this.addrToTuple(this.peerFromTransport());
    if (dest) {
      this.peerAddr = dest;
    }
    await this.sendClientHello();
  }

  async send(buf: Buffer): Promise<void> {
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
    // RFC 8446: send close_notify before tearing down write side (unless already sent)
    if (this.connected && !this.localCloseNotifySent) {
      void this.sendCloseNotify().finally(() => this.teardownClose());
      return;
    }
    this.teardownClose();
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
    } catch (e) {
      // ignore send failures during close
    }
  }

  private teardownClose() {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingFlight();
    this.clearEarlyAppData();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    this.carrier.close();
    void this.options.transport.close().catch(() => {});
    this.onClose.execute();
  }

  /** True after close() or fail() has torn down the association. */
  isClosed(): boolean {
    return this.closed;
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
   * Dual-stack fallback: stop 1.3 carrier timers/handlers without closing UDP
   * transport or emitting onClose (soft version fail already set closed).
   */
  releaseForVersionFallback(): void {
    this.clearPendingFlight();
    this.cancelEpochPrune?.();
    this.cancelEpochPrune = undefined;
    this.carrier.cancelAllTimers();
    this.carrier.close();
    this.closed = true;
  }
}
