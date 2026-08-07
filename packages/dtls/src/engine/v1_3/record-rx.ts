import type { DtlsHandshakeDatagram } from "../../carrier/types";
import {
  type AckRecordNumber,
  recordsFullyAcked,
  remainingAfterAck,
  DtlsAck,
} from "../../handshake/message/tls13/ack";
import { Alert } from "../../handshake/message/alert";
import { peerKeyFromAddr } from "../../handshake/extensions/cookie";
import { HandshakeType } from "../../handshake/const";
import { AlertDesc, ContentType } from "../../record/const";
import { FragmentedHandshake } from "../../record/message/fragment";
import {
  DtlsDecodeError,
  DtlsReplayError,
  type EpochProtection,
  parseNextRecord,
  encryptRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import { ProtocolVersionError } from "../../version";
import { Dtls13FlightTx } from "./flight-tx";
import { FRAGMENT_TTL_MS, MAX_ACK_RECORD_NUMBERS, MAX_FRAGMENT_BUFFER_BYTES, MAX_FRAGMENT_BUFFER_MESSAGES, MAX_FRAGMENTS_PER_MESSAGE, MAX_HS_MESSAGE_BYTES, log } from "./types";

/**
 * Record receive path: UDP datagrams → records → handshake reassembly → dispatch.
 * Inbound arrows in index.ts Figure 3; AEAD failures silent-drop, auth failures fatal.
 */
export abstract class Dtls13RecordRx extends Dtls13FlightTx {
  /** Flight routing — implemented in HandshakeFlights (Figure 3). */
  protected abstract dispatchHandshake(
    hs: import("../../record/message/fragment").FragmentedHandshake,
    epoch: number,
  ): Promise<void>;

  protected handleDatagram = (
    data: Buffer,
    addr?: [string, number] | { address?: string; port?: number } | string,
  ): void => {
    if (this.closed) return;
    // Serialize RX so concurrent UDP datagrams cannot race key install / inbox
    const buf = Buffer.from(data);
    // Prefer explicit peer; else last UDP rinfo so dual reinject keeps cookie binding
    const peer = peerKeyFromAddr(addr ?? this.peerFromTransport());
    this.rxChain = this.rxChain
      .then(() => this.handleDatagramAsync(buf, peer))
      .catch((e) => {
        // ProtocolVersionError / authenticated handshake failures already call fail()
        // or rethrow after failAuthenticatedHandshake. Unauthenticated errors are
        // discarded inside handleDatagramAsync and should not reach here often.
        if (
          e instanceof ProtocolVersionError ||
          (e instanceof Error && e.name === "ProtocolVersionError") ||
          (e instanceof Error && (e as any).dtlsAuthenticated === true)
        ) {
          try {
            this.fail(e instanceof Error ? e : new Error(String(e)));
          } catch {
            this.onError.execute(e instanceof Error ? e : new Error(String(e)));
          }
          return;
        }
        log("handleDatagram chain: silent discard", e);
      });
  };

  protected async handleDatagramAsync(
    data: Buffer,
    peerKey?: string,
  ): Promise<void> {
    if (this.closed) return;
    if (peerKey && peerKey !== "unknown") {
      this.peerKey = peerKey;
    }
    this.bytesReceived += data.length;
    this.evictExpiredFragments();
    let offset = 0;
    while (offset < data.length) {
      if (this.closed) return;
      let rec;
      try {
        rec = parseNextRecord(data.subarray(offset), (low) =>
          this.resolveEpochCandidates(low),
        );
      } catch (e) {
        // Replay of already-processed handshake record: re-ACK so peer advances
        if (
          e instanceof DtlsReplayError ||
          (e as Error)?.name === "DtlsReplayError"
        ) {
          const re = e as DtlsReplayError;
          log("drop replay/too-old record", re.message);
          if (re.consumed > 0) {
            offset += re.consumed;
            if (re.contentType === ContentType.handshake) {
              this.noteHandshakeRecordForAck(re.epoch, re.sequenceNumber);
              void this.sendAck().catch((err) =>
                log("re-ACK after replay failed", err),
              );
            }
            continue;
          }
          return;
        }
        // Decode / AEAD / missing-key errors from unauthenticated UDP: silent drop
        // (RFC 9147: invalid records are discarded without alert when not authenticated)
        log("drop invalid record", e instanceof Error ? e.message : String(e));
        return;
      }
      if (!rec) break;
      offset += rec.consumed;
      try {
        if (rec.kind === "plaintext") {
          // Epoch-0 handshake records may be ACKed after processing
          if (rec.contentType === ContentType.handshake) {
            this.noteHandshakeRecordForAck(rec.epoch, rec.sequenceNumber);
          }
          await this.onPlaintextRecordAsync(rec);
        } else {
          // RFC 9147 §7.1: ACK only handshake content type records
          if (rec.contentType === ContentType.handshake) {
            this.noteHandshakeRecordForAck(rec.epoch, rec.sequenceNumber);
          }
          await this.onCiphertextRecordAsync(rec);
        }
      } catch (e) {
        // Protocol version soft-fail must surface for dual-stack fallback
        if (
          e instanceof ProtocolVersionError ||
          (e instanceof Error && e.name === "ProtocolVersionError")
        ) {
          throw e;
        }
        // AEAD already succeeded for ciphertext → authenticated content.
        // Crypto/transcript failures must fatal-alert and fail() immediately
        // (not wait for peer retransmit timeout).
        if (rec.kind === "ciphertext") {
          await this.failAuthenticatedHandshake(
            e instanceof Error ? e : new Error(String(e)),
          );
          return;
        }
        // Plaintext epoch-0 is unauthenticated bootstrap: silent discard
        log(
          "drop unauthenticated plaintext process error",
          e instanceof Error ? e.message : String(e),
        );
        return;
      }
    }
  }

  /**
   * After AEAD-validated (or otherwise authenticated) handshake processing fails:
   * send a fatal alert and tear down. Marks error so outer handlers do not
   * treat it as forged-UDP discard.
   */
  protected resolveEpochCandidates(low: number): EpochProtection[] {
    const withRead: EpochProtection[] = [];
    const withWriteOnly: EpochProtection[] = [];
    for (const ep of this.epochs.values()) {
      if ((ep.epoch & 0x03) !== low) continue;
      if (ep.readKeys) withRead.push(ep);
      else if (ep.writeKeys) withWriteOnly.push(ep);
    }
    // Prefer read-key epochs; include write-only as last resort (e.g. ACK demux)
    return [...withRead, ...withWriteOnly].sort((a, b) => b.epoch - a.epoch);
  }

  protected async onPlaintextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    fragment: Buffer;
  }) {
    // Only epoch 0 plaintext is valid for DTLS 1.3 handshake bootstrap
    if (rec.epoch !== 0) {
      log("drop plaintext with non-zero epoch", rec.epoch);
      return;
    }
    if (rec.contentType === ContentType.alert) {
      this.handleAlert(rec.fragment);
      return;
    }
    if (rec.contentType === ContentType.handshake) {
      await this.processHandshakeBytes(rec.fragment, 0);
    }
  }

  protected async onCiphertextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    content: Buffer;
  }) {
    switch (rec.contentType) {
      case ContentType.handshake:
        await this.processHandshakeBytes(rec.content, rec.epoch);
        break;
      case ContentType.applicationData:
        if (!this.connected) {
          // May arrive before peer Finished is processed (UDP reorder)
          this.earlyAppData.push(rec.content);
          break;
        }
        this.onData.execute(rec.content);
        break;
      case ContentType.ack:
        this.handleAck(rec.content);
        break;
      case ContentType.alert:
        this.handleAlert(rec.content);
        break;
      default:
        log("unknown content type", rec.contentType);
    }
  }

  protected handleAlert(fragment: Buffer) {
    try {
      const alert = Alert.deSerialize(fragment);
      log("alert", alert.level, alert.description);
      if (alert.description === AlertDesc.ProtocolVersion) {
        this.fail(
          new ProtocolVersionError(
            "peer rejected protocol version (alert protocol_version)",
          ),
        );
        return;
      }
      if (alert.level > 1) {
        this.fail(
          new Error(
            `fatal alert ${alert.description} (${AlertDesc[alert.description] ?? "unknown"})`,
          ),
        );
      }
    } catch {
      this.onClose.execute();
    }
  }

  protected handleAck(content: Buffer) {
    try {
      const ack = DtlsAck.deSerialize(content);
      log("received ACK", ack.recordNumbers.length);
      if (this.pendingFlightRecords.length === 0 && !this.pendingServerHello) {
        return;
      }
      const before = this.pendingFlightRecords.length;
      // Empty ACK clears whole flight; partial removes matched records only
      this.pendingFlightRecords = remainingAfterAck(
        this.pendingFlightRecords,
        ack.recordNumbers,
      );
      // Selective retransmit: drop datagrams whose records are fully ACK'd
      if (this.pendingFlight.length === this.pendingFlightRecordGroups.length) {
        const keptFlight: DtlsHandshakeDatagram[] = [];
        const keptGroups: AckRecordNumber[][] = [];
        for (let i = 0; i < this.pendingFlight.length; i++) {
          const group = this.pendingFlightRecordGroups[i] ?? [];
          if (!recordsFullyAcked(group, ack.recordNumbers)) {
            // Keep only still-unacked records in the group for further ACKs
            keptGroups.push(remainingAfterAck(group, ack.recordNumbers));
            keptFlight.push(this.pendingFlight[i]);
          }
        }
        this.pendingFlight = keptFlight;
        this.pendingFlightRecordGroups = keptGroups;
      }
      if (
        this.pendingFlightRecords.length === before &&
        ack.recordNumbers.length > 0
      ) {
        log("ACK ignored: no pending flight records matched");
        return;
      }
      if (this.pendingFlightRecords.length > 0) {
        log(
          "partial ACK: still pending",
          this.pendingFlightRecords.length,
          "of",
          before,
        );
        return;
      }
      // Fully ACK'd
      this.clearPendingFlight();
      // RFC 9147 §8: only after KeyUpdate is ACK'd may we send with new keys
      this.applyPendingKeyUpdateWrite();
    } catch (e) {
      log("bad ACK", e);
    }
  }

  protected async processHandshakeBytes(
    raw: Buffer,
    epoch: number,
  ): Promise<void> {
    let offset = 0;
    while (offset < raw.length) {
      const remaining = raw.length - offset;
      if (remaining === 0) break;
      if (remaining < 12) {
        throw new DtlsDecodeError(
          `handshake header truncated: need 12 bytes, have ${remaining}`,
        );
      }
      // fragment_length is at offset+9 (3 bytes) within 12-byte header
      const fragmentLength = raw.readUIntBE(offset + 9, 3);
      const total = 12 + fragmentLength;
      if (remaining < total) {
        throw new DtlsDecodeError(
          `handshake fragment truncated: need ${total}, have ${remaining}`,
        );
      }
      const hs = FragmentedHandshake.deSerialize(
        raw.subarray(offset, offset + total),
      );
      if (hs.fragment_length !== hs.fragment.length) {
        throw new DtlsDecodeError(
          `handshake fragment_length mismatch: header ${hs.fragment_length}, body ${hs.fragment.length}`,
        );
      }
      offset += total;
      // Epoch / role allowlist for handshake message types (DoS / state abuse)
      if (!this.isAllowedHandshake(hs.msg_type, epoch)) {
        log("drop disallowed handshake", hs.msg_type, "epoch", epoch);
        continue;
      }
      const complete = this.reassemble(hs);
      if (complete) {
        // Queue by message_seq for reorder safety (RFC 9147 §5.2)
        await this.enqueueHandshake(complete, epoch);
      }
    }
  }

  /**
   * Restrict which handshake types may be processed on a given epoch / role.
   * Forged or out-of-state messages are dropped without killing the connection.
   */
  protected isAllowedHandshake(msgType: number, epoch: number): boolean {
    // Epoch 0 plaintext: only ClientHello / ServerHello (HRR) / HelloVerifyRequest
    if (epoch === 0) {
      if (this.role === "server") {
        return msgType === HandshakeType.client_hello_1;
      }
      return (
        msgType === HandshakeType.server_hello_2 ||
        msgType === HandshakeType.hello_verify_request_3
      );
    }
    // Handshake epoch 2: HS messages only (no KeyUpdate)
    if (epoch === 2) {
      return (
        msgType === HandshakeType.encrypted_extensions_8 ||
        msgType === HandshakeType.certificate_request_13 ||
        msgType === HandshakeType.certificate_11 ||
        msgType === HandshakeType.certificate_verify_15 ||
        msgType === HandshakeType.finished_20
      );
    }
    // Application epochs: KeyUpdate (+ rare post-HS Certificate)
    if (epoch >= 3) {
      return (
        msgType === HandshakeType.key_update_24 ||
        msgType === HandshakeType.certificate_11 ||
        msgType === HandshakeType.certificate_verify_15
      );
    }
    return false;
  }

  protected async enqueueHandshake(
    hs: FragmentedHandshake,
    epoch: number,
  ): Promise<void> {
    const seq = hs.message_seq;
    if (seq < this.nextReceiveSeq) {
      // Duplicate handshake message (flight retransmit) — re-ACK so sender advances
      void this.sendAck().catch((e) =>
        log("re-ACK on dup handshake failed", e),
      );
      return;
    }
    if (seq > this.nextReceiveSeq) {
      this.handshakeInbox.set(seq, hs);
      // Bound inbox size
      if (this.handshakeInbox.size > 32) {
        throw new Error(
          "handshake inbox overflow (too many out-of-order messages)",
        );
      }
      return;
    }
    // seq === nextReceiveSeq
    await this.dispatchHandshake(hs, epoch);
    this.nextReceiveSeq += 1;
    // Drain consecutive queued messages
    while (this.handshakeInbox.has(this.nextReceiveSeq)) {
      const next = this.handshakeInbox.get(this.nextReceiveSeq)!;
      this.handshakeInbox.delete(this.nextReceiveSeq);
      await this.dispatchHandshake(next, epoch);
      this.nextReceiveSeq += 1;
    }
  }

  protected evictExpiredFragments(): void {
    const now = Date.now();
    for (const [key, entry] of this.fragmentBuffer) {
      if (now - entry.createdAt > FRAGMENT_TTL_MS) {
        this.fragmentBufferBytes -= entry.coveredBytes;
        this.fragmentBuffer.delete(key);
      }
    }
    if (this.fragmentBufferBytes < 0) this.fragmentBufferBytes = 0;
  }

  protected reassemble(hs: FragmentedHandshake): FragmentedHandshake | null {
    // Strict range checks on every fragment
    if (hs.length < 0 || hs.length > MAX_HS_MESSAGE_BYTES) {
      throw new Error(
        `handshake message length ${hs.length} exceeds limit ${MAX_HS_MESSAGE_BYTES}`,
      );
    }
    if (hs.fragment_length !== hs.fragment.length) {
      throw new Error("fragment_length does not match buffer size");
    }
    if (
      hs.fragment_offset < 0 ||
      hs.fragment_length < 0 ||
      hs.fragment_offset + hs.fragment_length > hs.length
    ) {
      throw new Error(
        `invalid fragment range offset=${hs.fragment_offset} length=${hs.fragment_length} total=${hs.length}`,
      );
    }

    if (hs.fragment_length === hs.length && hs.fragment_offset === 0) {
      return hs;
    }

    this.evictExpiredFragments();

    const key = `${hs.msg_type}:${hs.message_seq}:${hs.length}`;
    let entry = this.fragmentBuffer.get(key);
    if (!entry) {
      if (this.fragmentBuffer.size >= MAX_FRAGMENT_BUFFER_MESSAGES) {
        throw new Error("fragment buffer: too many incomplete messages");
      }
      if (this.fragmentBufferBytes + hs.length > MAX_FRAGMENT_BUFFER_BYTES) {
        throw new Error("fragment buffer: total bytes exceeded");
      }
      entry = {
        parts: [],
        total: hs.length,
        createdAt: Date.now(),
        coveredBytes: 0,
      };
      this.fragmentBuffer.set(key, entry);
      this.fragmentBufferBytes += hs.length;
    }

    if (entry.parts.length >= MAX_FRAGMENTS_PER_MESSAGE) {
      throw new Error("fragment buffer: too many fragments for one message");
    }

    // Reject conflicting overlaps; allow exact retransmission of same bytes
    for (const prev of entry.parts) {
      const a0 = prev.fragment_offset;
      const a1 = prev.fragment_offset + prev.fragment_length;
      const b0 = hs.fragment_offset;
      const b1 = hs.fragment_offset + hs.fragment_length;
      const overlapStart = Math.max(a0, b0);
      const overlapEnd = Math.min(a1, b1);
      if (overlapStart < overlapEnd) {
        for (let i = overlapStart; i < overlapEnd; i++) {
          const prevByte = prev.fragment[i - a0];
          const newByte = hs.fragment[i - b0];
          if (prevByte !== newByte) {
            throw new Error("overlapping fragment with conflicting data");
          }
        }
      }
    }

    entry.parts.push(hs);

    // Coverage check
    const covered = new Uint8Array(hs.length);
    for (const p of entry.parts) {
      for (let i = 0; i < p.fragment_length; i++) {
        covered[p.fragment_offset + i] = 1;
      }
    }
    let complete = true;
    for (let i = 0; i < hs.length; i++) {
      if (!covered[i]) {
        complete = false;
        break;
      }
    }
    if (!complete) return null;

    this.fragmentBuffer.delete(key);
    this.fragmentBufferBytes -= entry.coveredBytes || entry.total;
    if (this.fragmentBufferBytes < 0) this.fragmentBufferBytes = 0;
    return FragmentedHandshake.assemble(entry.parts);
  }


}
