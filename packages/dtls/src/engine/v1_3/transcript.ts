import { hashSha256 } from "../../cipher/tls13/hkdf";
import { HandshakeType } from "../../handshake/const";

/**
 * Transcript of complete handshake messages only (no record headers,
 * fragment metadata, retransmissions, or ACK).
 *
 * Wire format for hashing: msg_type(1) || length(3) || body
 * (RFC 8446 §4.4.1 — DTLS omits message_seq/fragment fields from transcript)
 */
export class HandshakeTranscript {
  private messages: Buffer[] = [];

  /** Append a complete handshake message body with its type. */
  add(msgType: number, body: Buffer): void {
    const header = Buffer.alloc(4);
    header.writeUInt8(msgType, 0);
    header.writeUIntBE(body.length, 1, 3);
    this.messages.push(Buffer.concat([header, body]));
  }

  /** HRR special case: replace ClientHello with message_hash of it. */
  replaceWithMessageHash(clientHelloBody: Buffer): void {
    const chFull = Buffer.alloc(4 + clientHelloBody.length);
    chFull.writeUInt8(HandshakeType.client_hello_1, 0);
    chFull.writeUIntBE(clientHelloBody.length, 1, 3);
    clientHelloBody.copy(chFull, 4);
    const hash = hashSha256(chFull);
    // message_hash(254) || 00 00 20 || Hash
    const mh = Buffer.alloc(4 + 32);
    mh.writeUInt8(HandshakeType.message_hash_254, 0);
    mh.writeUIntBE(32, 1, 3);
    hash.copy(mh, 4);
    this.messages = [mh];
  }

  get bytes(): Buffer {
    return Buffer.concat(this.messages);
  }

  get hash(): Buffer {
    return hashSha256(this.bytes);
  }

  clone(): HandshakeTranscript {
    const t = new HandshakeTranscript();
    t.messages = this.messages.map((m) => Buffer.from(m));
    return t;
  }
}
