/**
 * DTLS 1.3 ACK content type 26 (RFC 9147 §7).
 * Not a handshake message — record content type ACK.
 * RecordNumber = epoch (uint64 high) + sequence (but wire is list of RecordNumber).
 *
 * struct {
 *   uint64 epoch;
 *   uint64 sequence_number;
 * } RecordNumber;  // Actually RFC uses:
 * struct {
 *   uint64 record_numbers<0..2^16-1>;
 * } ACK;
 *
 * Each RecordNumber is 16 bytes? RFC 9147:
 * struct {
 *     uint64 epoch;
 *     uint64 sequence_number;
 * } RecordNumber;
 *
 * struct {
 *     RecordNumber record_numbers<0..2^16-1>;
 * } ACK;
 */

export interface AckRecordNumber {
  epoch: number;
  sequenceNumber: number;
}

function recordKey(rn: AckRecordNumber): string {
  return `${rn.epoch}:${rn.sequenceNumber}`;
}

/**
 * Remove fully ACK'd records from a pending flight record list (RFC 9147 §7).
 *
 * Empty ACK (no record_numbers) acknowledges **nothing** — it is used to
 * prompt retransmission of unacknowledged records, not to clear the flight.
 * Callers should retransmit on empty ACK rather than treating it as full ACK.
 */
export function remainingAfterAck(
  pending: AckRecordNumber[],
  acked: AckRecordNumber[],
): AckRecordNumber[] {
  if (acked.length === 0) return pending.slice();
  const done = new Set(acked.map(recordKey));
  return pending.filter((p) => !done.has(recordKey(p)));
}

/**
 * True if every record in `records` is listed in `acked`.
 * Empty ACK acknowledges nothing (returns false for non-empty records).
 */
export function recordsFullyAcked(
  records: AckRecordNumber[],
  acked: AckRecordNumber[],
): boolean {
  if (records.length === 0) return true;
  if (acked.length === 0) return false;
  const done = new Set(acked.map(recordKey));
  return records.every((r) => done.has(recordKey(r)));
}

export class DtlsAck {
  constructor(public recordNumbers: AckRecordNumber[]) {}

  static deSerialize(buf: Buffer): DtlsAck {
    if (buf.length < 2) throw new Error("ACK: truncated length");
    const listLen = buf.readUInt16BE(0);
    if (buf.length < 2 + listLen) throw new Error("ACK: truncated body");
    if (listLen % 16 !== 0) throw new Error("ACK: invalid list length");
    const recordNumbers: AckRecordNumber[] = [];
    for (let off = 2; off < 2 + listLen; off += 16) {
      // uint64 epoch, uint64 sequence — use low 32/48 bits we care about
      const epoch = Number(buf.readBigUInt64BE(off));
      const sequenceNumber = Number(buf.readBigUInt64BE(off + 8));
      recordNumbers.push({ epoch, sequenceNumber });
    }
    return new DtlsAck(recordNumbers);
  }

  serialize(): Buffer {
    const listLen = this.recordNumbers.length * 16;
    const buf = Buffer.alloc(2 + listLen);
    buf.writeUInt16BE(listLen, 0);
    this.recordNumbers.forEach((rn, i) => {
      const off = 2 + i * 16;
      buf.writeBigUInt64BE(BigInt(rn.epoch), off);
      buf.writeBigUInt64BE(BigInt(rn.sequenceNumber), off + 8);
    });
    return buf;
  }
}
