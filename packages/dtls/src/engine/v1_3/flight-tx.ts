import { createHandshakeDatagram } from "../../carrier/direct";
import type { AckRecordNumber } from "../../handshake/message/tls13/ack";
import { DtlsAck } from "../../handshake/message/tls13/ack";
import { AlertDesc, ContentType } from "../../record/const";
import type { FragmentedHandshake } from "../../record/message/fragment";
import {
  encryptRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import { ProtocolVersionError } from "../../version";
import { Dtls13ConnectionBase } from "./connection-base";
import {
  ANTI_AMPLIFICATION_FACTOR,
  MAX_ACK_RECORD_NUMBERS,
  log,
} from "./types";

/**
 * Flight transmit path: serialize handshake fragments → records → datagrams,
 * retransmit, anti-amplification budget, and ACK emission.
 * Aligns with outbound arrows in index.ts Figure 3.
 */
export abstract class Dtls13FlightTx extends Dtls13ConnectionBase {
  protected async sendHandshakeFlight(
    fragments: FragmentedHandshake[],
    epoch: number,
    retransmittable: boolean,
  ): Promise<void> {
    this.flightId += 1;
    const flightId = this.flightId;
    const mtu = this.carrier.getMtu();
    // handshake overhead: 13 header + 12 hs header + AEAD tag for encrypted
    const maxFrag = epoch === 0 ? mtu - 13 - 12 : mtu - 5 - 12 - 16; // unified header ~5 + tag

    const packets: Buffer[] = [];
    const packetRecords: AckRecordNumber[] = [];
    for (const f of fragments) {
      const chunks = f.fragment.length > maxFrag ? f.chunk(maxFrag) : [f];
      for (const chunk of chunks) {
        const hsBytes = chunk.serialize();
        if (epoch === 0) {
          const seq = this.recordSeqEpoch0++;
          packetRecords.push({ epoch: 0, sequenceNumber: seq });
          packets.push(
            serializePlaintextRecord(ContentType.handshake, 0, seq, hsBytes),
          );
        } else {
          const ep = this.epochs.get(epoch);
          if (!ep?.writeKeys) {
            throw new Error(`no write keys for epoch ${epoch}`);
          }
          const seq = ep.writeSequence;
          packetRecords.push({ epoch, sequenceNumber: seq });
          packets.push(encryptRecord(hsBytes, ContentType.handshake, ep));
        }
      }
    }

    // Coalesce into datagrams under MTU, tracking which records land in each
    const datagrams: Buffer[] = [];
    const datagramRecordGroups: AckRecordNumber[][] = [];
    let current: Buffer = Buffer.alloc(0);
    let currentRecs: AckRecordNumber[] = [];
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      const rn = packetRecords[i];
      if (current.length + p.length > mtu && current.length > 0) {
        datagrams.push(current);
        datagramRecordGroups.push(currentRecs);
        current = Buffer.from(p);
        currentRecs = [rn];
      } else {
        current = current.length ? Buffer.concat([current, p]) : Buffer.from(p);
        currentRecs.push(rn);
      }
    }
    if (current.length) {
      datagrams.push(current);
      datagramRecordGroups.push(currentRecs);
    }

    // Anti-amplification: before address validation, send ≤ 3× received (strict).
    // No exception for "first datagram" — CH receipt must provide budget for HRR.
    // Retransmits also consume budget via consumeSendBudget().
    if (
      this.role === "server" &&
      !this.addressValidated &&
      this.addressValidation === "dtls-cookie"
    ) {
      const budget =
        ANTI_AMPLIFICATION_FACTOR * this.bytesReceived - this.bytesSent;
      let allowed = Math.max(0, budget);
      const limited: Buffer[] = [];
      const limitedGroups: AckRecordNumber[][] = [];
      for (let i = 0; i < datagrams.length; i++) {
        const d = datagrams[i];
        if (d.length > allowed) break;
        limited.push(d);
        limitedGroups.push(datagramRecordGroups[i]);
        allowed -= d.length;
      }
      if (limited.length === 0 && datagrams.length > 0) {
        throw new Error(
          `anti-amplification: budget exhausted (received=${this.bytesReceived} sent=${this.bytesSent} need=${datagrams[0].length})`,
        );
      }
      datagrams.length = 0;
      datagrams.push(...limited);
      datagramRecordGroups.length = 0;
      datagramRecordGroups.push(...limitedGroups);
    }

    // Separate copies for callback vs retransmit cache (Buffer contents are mutable)
    const notifyPackets = datagrams.map((bytes, i) =>
      createHandshakeDatagram(bytes, flightId, i, retransmittable),
    );
    const cachePackets = datagrams.map((bytes, i) =>
      createHandshakeDatagram(bytes, flightId, i, retransmittable),
    );
    this.carrier.events.onFlightCreated?.(flightId, notifyPackets);

    if (retransmittable) {
      this.pendingFlight = cachePackets;
      this.pendingFlightRecordGroups = datagramRecordGroups.map((g) =>
        g.map((r) => ({ ...r })),
      );
      this.pendingFlightRecords = packetRecords.filter((r) =>
        datagramRecordGroups.some((g) =>
          g.some(
            (x) => x.epoch === r.epoch && x.sequenceNumber === r.sequenceNumber,
          ),
        ),
      );
      this.retransmitCount = 0;
      this.scheduleRetransmit();
    }

    for (const pkt of cachePackets) {
      if (!this.consumeSendBudget(pkt.bytes.length)) {
        throw new Error(
          `anti-amplification: budget exhausted on send (received=${this.bytesReceived} sent=${this.bytesSent} need=${pkt.bytes.length})`,
        );
      }
      await this.carrier.send(pkt);
    }
  }

  /**
   * Account outbound bytes and enforce 3× anti-amplification before address
   * validation (including retransmissions of HRR / incomplete flights).
   */
  protected consumeSendBudget(len: number): boolean {
    if (
      this.role === "server" &&
      !this.addressValidated &&
      this.addressValidation === "dtls-cookie"
    ) {
      const budget =
        ANTI_AMPLIFICATION_FACTOR * this.bytesReceived - this.bytesSent;
      if (len > budget) return false;
    }
    this.bytesSent += len;
    return true;
  }

  protected scheduleRetransmit() {
    this.cancelRetransmit?.();
    // Allow post-handshake retransmit (final flight / KeyUpdate) when connected
    if (
      this.closed ||
      (this.pendingFlight.length === 0 && !this.pendingServerHello)
    ) {
      return;
    }
    const rto = Math.min(1000 * (1 + this.retransmitCount / 2), 5000);
    this.cancelRetransmit = this.carrier.schedule(rto, () => {
      void this.doRetransmit();
    });
  }

  protected async doRetransmit(): Promise<void> {
    if (
      this.closed ||
      (this.pendingFlight.length === 0 && !this.pendingServerHello)
    ) {
      return;
    }
    this.retransmitCount++;
    if (this.retransmitCount > this.maxRetransmit) {
      this.fail(new Error("DTLS 1.3 handshake retransmission exhausted"));
      return;
    }
    log("retransmit flight", this.flightId, this.retransmitCount);
    // ServerHello is retransmitted with the encrypted flight until fully ACK'd
    const toSend = this.pendingServerHello
      ? [this.pendingServerHello, ...this.pendingFlight]
      : this.pendingFlight;
    for (const p of toSend) {
      if (!this.consumeSendBudget(p.bytes.length)) {
        log(
          "retransmit blocked by anti-amplification",
          this.bytesReceived,
          this.bytesSent,
        );
        break;
      }
      try {
        await this.carrier.send(p);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
    this.scheduleRetransmit();
  }

  protected async sendAck(): Promise<void> {
    // Use the current sending epoch (highest write keys we are allowed to use).
    // Never prefer a stale epoch 3 after KeyUpdate advanced writeEpoch.
    const ep =
      this.epochs.get(this.writeEpoch) ||
      this.epochs.get(2) ||
      this.epochs.get(3);
    if (!ep?.writeKeys) return;

    if (this.receivedRecordNumbers.length === 0) {
      // Empty ACK is allowed but useless; skip to reduce bandwidth
      return;
    }
    // Sort by epoch then sequence (RFC 9147 record_numbers order is free, but
    // stable sorted lists aid interop / debugging and meet size bounds cleanly).
    const numbers = [...this.receivedRecordNumbers]
      .sort((a, b) =>
        a.epoch !== b.epoch
          ? a.epoch - b.epoch
          : a.sequenceNumber - b.sequenceNumber,
      )
      .slice(0, MAX_ACK_RECORD_NUMBERS);
    this.receivedRecordNumbers = [];
    const ack = new DtlsAck(numbers);
    const record = encryptRecord(ack.serialize(), ContentType.ack, ep);
    // Always send via transport (application path); not part of retransmit flight
    this.bytesSent += record.length;
    await this.options.transport.send(record);
  }

  protected async sendFatalAlert(description: number): Promise<void> {
    const alert = Buffer.from([2, description]); // fatal
    try {
      if (this.writeEpoch >= 2) {
        const ep = this.epochs.get(this.writeEpoch);
        if (ep?.writeKeys) {
          const record = encryptRecord(alert, ContentType.alert, ep);
          this.bytesSent += record.length;
          await this.options.transport.send(record);
          return;
        }
      }
      const seq = this.recordSeqEpoch0++;
      const record = serializePlaintextRecord(ContentType.alert, 0, seq, alert);
      await this.options.transport.send(record);
    } catch (e) {
      log("sendFatalAlert failed", e);
    }
  }

  /** Queue a handshake record number for the next ACK (dedupe + cap). */
  protected alertDescForHandshakeError(err: Error): number {
    const m = err.message;
    if (/verify_data|Finished|DecryptError|MAC/i.test(m)) {
      return AlertDesc.DecryptError;
    }
    if (
      /CertificateVerify|signature|certificate_request_context|BadCertificate|certificate/i.test(
        m,
      )
    ) {
      return AlertDesc.DecryptError;
    }
    if (/illegal|not negotiated|unsupported|unexpected/i.test(m)) {
      return AlertDesc.IllegalParameter;
    }
    return AlertDesc.HandshakeFailure;
  }

  /** Best-effort fatal alert on current write epoch (or epoch-0 plaintext). */
  protected async failAuthenticatedHandshake(err: Error): Promise<void> {
    (err as Error & { dtlsAuthenticated?: boolean }).dtlsAuthenticated = true;
    const desc = this.alertDescForHandshakeError(err);
    await this.sendFatalAlert(desc);
    this.fail(err);
  }

  protected async sendProtocolVersionAlert(): Promise<void> {
    // alert level fatal(2), description protocol_version(70)
    const alert = Buffer.from([2, AlertDesc.ProtocolVersion]);
    const seq = this.recordSeqEpoch0++;
    const record = serializePlaintextRecord(ContentType.alert, 0, seq, alert);
    await this.options.transport.send(record);
    this.fail(
      new ProtocolVersionError(
        "no overlapping DTLS 1.3 protocol version with peer",
      ),
    );
  }

  protected noteHandshakeRecordForAck(epoch: number, sequenceNumber: number) {
    const exists = this.receivedRecordNumbers.some(
      (r) => r.epoch === epoch && r.sequenceNumber === sequenceNumber,
    );
    if (!exists) {
      this.receivedRecordNumbers.push({ epoch, sequenceNumber });
    }
    // Bound memory: keep the most recent N
    if (this.receivedRecordNumbers.length > MAX_ACK_RECORD_NUMBERS) {
      this.receivedRecordNumbers = this.receivedRecordNumbers.slice(
        -MAX_ACK_RECORD_NUMBERS,
      );
    }
  }

  /**
   * All epochs matching 2-bit wire epoch that have usable keys.
   * decryptRecord trials AEAD newest-first so epoch 3 vs 7 collisions work.
   */
}
