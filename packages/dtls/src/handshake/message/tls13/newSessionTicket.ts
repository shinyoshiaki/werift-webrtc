import { AlertDesc } from "../../../record/const";
import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { DtlsProtocolError } from "../../../version";
import { HandshakeType } from "../../const";

/**
 * TLS 1.3 NewSessionTicket (RFC 8446 §4.6.1). HandshakeType = 4.
 * DTLS 1.3 post-handshake: receive, ACK, discard (no resumption / PSK).
 *
 * struct {
 *     uint32 ticket_lifetime;
 *     uint32 ticket_age_add;
 *     opaque ticket_nonce<0..255>;
 *     opaque ticket<1..2^16-1>;
 *     Extension extensions<0..2^16-2>;
 * } NewSessionTicket;
 */
export class NewSessionTicket implements Handshake {
  msgType = HandshakeType.new_session_ticket_4 as any;
  messageSeq?: number;

  constructor(
    /** RFC 8446 ticket_lifetime (seconds; 0 = immediately stale). */
    public ticketLifetime: number,
    /** RFC 8446 ticket_age_add (obfuscation). */
    public ticketAgeAdd: number,
    /** RFC 8446 ticket_nonce. */
    public ticketNonce: Buffer,
    /** RFC 8446 ticket (opaque; length ≥ 1). */
    public ticket: Buffer,
    /** RFC 8446 extensions vector bytes (without the 2-byte length prefix). */
    public extensions: Buffer = Buffer.alloc(0),
  ) {}

  static createEmpty() {
    return new NewSessionTicket(0, 0, Buffer.alloc(0), Buffer.from([0]));
  }

  static deSerialize(buf: Buffer): NewSessionTicket {
    const fail = (why: string): never => {
      throw new DtlsProtocolError(
        `decode_error: NewSessionTicket ${why}`,
        AlertDesc.DecodeError,
      );
    };
    // lifetime(4) + age_add(4) + nonce_len(1) + ticket_len(2) + ext_len(2)
    // ticket itself may be empty (rejected below) so the floor is 13
    if (buf.length < 13) fail("truncated");
    let offset = 0;
    const ticketLifetime = buf.readUInt32BE(offset);
    offset += 4;
    const ticketAgeAdd = buf.readUInt32BE(offset);
    offset += 4;
    const nonceLen = buf.readUInt8(offset);
    offset += 1;
    if (offset + nonceLen > buf.length) fail("truncated ticket_nonce");
    const ticketNonce = Buffer.from(buf.subarray(offset, offset + nonceLen));
    offset += nonceLen;
    if (offset + 2 > buf.length) fail("truncated ticket length");
    const ticketLen = buf.readUInt16BE(offset);
    offset += 2;
    if (ticketLen < 1) fail("empty ticket");
    if (offset + ticketLen > buf.length) fail("truncated ticket");
    const ticket = Buffer.from(buf.subarray(offset, offset + ticketLen));
    offset += ticketLen;
    if (offset + 2 > buf.length) fail("truncated extensions length");
    const extLen = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + extLen !== buf.length) {
      fail("extensions length mismatch or trailing bytes");
    }
    const extensions = Buffer.from(buf.subarray(offset, offset + extLen));
    // Unknown extensions are skipped; the declared list must be well-formed.
    let eoff = 0;
    while (eoff < extensions.length) {
      if (eoff + 4 > extensions.length) fail("truncated extension");
      const dataLen = extensions.readUInt16BE(eoff + 2);
      eoff += 4 + dataLen;
      if (eoff > extensions.length) fail("truncated extension data");
    }
    if (eoff !== extensions.length) fail("malformed extensions");
    return new NewSessionTicket(
      ticketLifetime,
      ticketAgeAdd,
      ticketNonce,
      ticket,
      extensions,
    );
  }

  serialize(): Buffer {
    const nonceLen = this.ticketNonce.length;
    const ticketLen = this.ticket.length;
    const extLen = this.extensions.length;
    const buf = Buffer.alloc(4 + 4 + 1 + nonceLen + 2 + ticketLen + 2 + extLen);
    let offset = 0;
    buf.writeUInt32BE(this.ticketLifetime >>> 0, offset);
    offset += 4;
    buf.writeUInt32BE(this.ticketAgeAdd >>> 0, offset);
    offset += 4;
    buf.writeUInt8(nonceLen, offset);
    offset += 1;
    this.ticketNonce.copy(buf, offset);
    offset += nonceLen;
    buf.writeUInt16BE(ticketLen, offset);
    offset += 2;
    this.ticket.copy(buf, offset);
    offset += ticketLen;
    buf.writeUInt16BE(extLen, offset);
    offset += 2;
    this.extensions.copy(buf, offset);
    return buf;
  }

  toFragment() {
    const body = this.serialize();
    return new FragmentedHandshake(
      this.msgType,
      body.length,
      this.messageSeq!,
      0,
      body.length,
      body,
    );
  }
}
