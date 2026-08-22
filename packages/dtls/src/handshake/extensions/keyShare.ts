import { NamedCurveAlgorithm } from "../../cipher/const";
import type { Extension } from "../../typings/domain";

/** Extension type key_share = 51 */
export const KEY_SHARE_TYPE = 51;

export interface KeyShareEntry {
  group: number;
  keyExchange: Buffer;
}

/**
 * Expected key_exchange lengths for groups we support (RFC 8446 §4.2.8).
 * Unknown groups are not length-checked here (rejected later by negotiation).
 */
function expectedKeyExchangeLength(group: number): number | undefined {
  switch (group) {
    case NamedCurveAlgorithm.x25519_29:
      return 32;
    case NamedCurveAlgorithm.secp256r1_23:
      return 65; // uncompressed point 0x04 || X || Y
    default:
      return undefined;
  }
}

function assertKeyExchangeEncoding(group: number, ke: Buffer): void {
  const expected = expectedKeyExchangeLength(group);
  if (expected !== undefined && ke.length !== expected) {
    throw new Error(
      `key_share: illegal_parameter key_exchange length ${ke.length} for group 0x${group.toString(16)} (expected ${expected})`,
    );
  }
  // P-256 uncompressed point must start with 0x04
  if (group === NamedCurveAlgorithm.secp256r1_23 && ke[0] !== 0x04) {
    throw new Error(
      "key_share: illegal_parameter P-256 key_exchange must be uncompressed (0x04…)",
    );
  }
}

/**
 * ClientHello: client_shares list.
 * ServerHello: single server_share.
 * HRR: selected_group only (uint16).
 */
export class KeyShare {
  static type = KEY_SHARE_TYPE;

  constructor(
    public clientShares?: KeyShareEntry[],
    public serverShare?: KeyShareEntry,
    public selectedGroup?: number,
  ) {}

  static forClient(shares: KeyShareEntry[]): KeyShare {
    return new KeyShare(shares);
  }

  static forServer(share: KeyShareEntry): KeyShare {
    return new KeyShare(undefined, share);
  }

  static forHelloRetryRequest(group: number): KeyShare {
    return new KeyShare(undefined, undefined, group);
  }

  static fromClientData(data: Buffer): KeyShare {
    if (data.length < 2) throw new Error("key_share client: truncated");
    const listLen = data.readUInt16BE(0);
    let offset = 2;
    const end = 2 + listLen;
    // Strict: no trailing bytes after declared client_shares vector
    if (data.length !== end) {
      throw new Error(
        `key_share client: length mismatch (declared ${listLen}, total ${data.length - 2})`,
      );
    }
    const shares: KeyShareEntry[] = [];
    while (offset < end) {
      if (end - offset < 4)
        throw new Error("key_share client: entry truncated");
      const group = data.readUInt16BE(offset);
      const keLen = data.readUInt16BE(offset + 2);
      offset += 4;
      if (end - offset < keLen)
        throw new Error("key_share client: ke truncated");
      const keyExchange = Buffer.from(data.subarray(offset, offset + keLen));
      offset += keLen;
      assertKeyExchangeEncoding(group, keyExchange);
      shares.push({ group, keyExchange });
    }
    return KeyShare.forClient(shares);
  }

  static fromServerData(data: Buffer): KeyShare {
    // Could be HRR (2 bytes) or ServerHello share
    if (data.length === 2) {
      return KeyShare.forHelloRetryRequest(data.readUInt16BE(0));
    }
    if (data.length < 4) throw new Error("key_share server: truncated");
    const group = data.readUInt16BE(0);
    const keLen = data.readUInt16BE(2);
    // Strict: no trailing bytes
    if (data.length !== 4 + keLen) {
      throw new Error(
        `key_share server: length mismatch (declared ke ${keLen}, total ${data.length - 4})`,
      );
    }
    const keyExchange = Buffer.from(data.subarray(4, 4 + keLen));
    assertKeyExchangeEncoding(group, keyExchange);
    return KeyShare.forServer({ group, keyExchange });
  }

  serializeClientData(): Buffer {
    const shares = this.clientShares ?? [];
    const parts = shares.map((s) => {
      const buf = Buffer.alloc(4 + s.keyExchange.length);
      buf.writeUInt16BE(s.group, 0);
      buf.writeUInt16BE(s.keyExchange.length, 2);
      s.keyExchange.copy(buf, 4);
      return buf;
    });
    const body = Buffer.concat(parts);
    const out = Buffer.alloc(2 + body.length);
    out.writeUInt16BE(body.length, 0);
    body.copy(out, 2);
    return out;
  }

  serializeServerData(): Buffer {
    if (this.selectedGroup !== undefined && !this.serverShare) {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(this.selectedGroup, 0);
      return buf;
    }
    if (!this.serverShare) throw new Error("key_share: no server share");
    const s = this.serverShare;
    const buf = Buffer.alloc(4 + s.keyExchange.length);
    buf.writeUInt16BE(s.group, 0);
    buf.writeUInt16BE(s.keyExchange.length, 2);
    s.keyExchange.copy(buf, 4);
    return buf;
  }

  get clientExtension(): Extension {
    return { type: KeyShare.type, data: this.serializeClientData() };
  }

  get serverExtension(): Extension {
    return { type: KeyShare.type, data: this.serializeServerData() };
  }
}
