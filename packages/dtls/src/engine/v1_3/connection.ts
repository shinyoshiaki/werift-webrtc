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
import { ContentType } from "../../record/const";
import { encryptRecord } from "../../record/v1_3/record";
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
    await this.sendClientHello();
  }

  async send(buf: Buffer): Promise<void> {
    if (!this.connected && this.writeEpoch < 3) {
      throw new Error("DTLS 1.3 not ready to send application data");
    }
    const ep = this.epochs.get(this.writeEpoch);
    if (!ep?.writeKeys) throw new Error("no application write keys");
    const record = encryptRecord(buf, ContentType.applicationData, ep);
    await this.options.transport.send(record);
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
    this.closed = true;
    this.clearPendingFlight();
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
