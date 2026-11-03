/**
 * Minimal ASN.1 DER encoder.
 * Covers the types needed to build X.509 certificates and PKCS#8 / SPKI key prefixes.
 * Browser-safe: depends only on `Buffer`.
 * Internal: not re-exported from the package index (used by werift-dtls).
 */

export const Asn1Tag = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  objectIdentifier: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

/** Encodes a TLV with a definite-length header. */
export function encodeDer(tag: number, content: Buffer): Buffer {
  if (content.length < 0x80) {
    return Buffer.concat([Buffer.from([tag, content.length]), content]);
  }

  const length: number[] = [];
  for (
    let value = content.length;
    value > 0;
    value = Math.floor(value / 0x100)
  ) {
    length.unshift(value & 0xff);
  }

  return Buffer.concat([
    Buffer.from([tag, 0x80 | length.length, ...length]),
    content,
  ]);
}

export function encodeDerSequence(...items: Buffer[]): Buffer {
  return encodeDer(Asn1Tag.sequence, Buffer.concat(items));
}

/** DER requires SET OF elements to be sorted by their encoding. */
export function encodeDerSet(...items: Buffer[]): Buffer {
  return encodeDer(Asn1Tag.set, Buffer.concat([...items].sort(Buffer.compare)));
}

/** Encodes `[tagNumber]` EXPLICIT (constructed) context-specific tag. */
export function encodeDerExplicit(tagNumber: number, content: Buffer): Buffer {
  if (tagNumber < 0 || tagNumber > 30) {
    throw new RangeError(`unsupported context-specific tag: ${tagNumber}`);
  }
  return encodeDer(0xa0 | tagNumber, content);
}

export function encodeDerNull(): Buffer {
  return Buffer.from([Asn1Tag.null, 0x00]);
}

/** Encodes an unsigned big-endian integer (non-negative). */
export function encodeDerInteger(value: number | Buffer): Buffer {
  let bytes: Buffer;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`unsupported integer: ${value}`);
    }
    const arr: number[] = [];
    for (let v = value; v > 0; v = Math.floor(v / 0x100)) {
      arr.unshift(v & 0xff);
    }
    bytes = Buffer.from(arr);
  } else {
    bytes = value;
  }

  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) {
    offset++;
  }
  bytes = bytes.subarray(offset);
  if (bytes.length === 0) {
    bytes = Buffer.from([0x00]);
  }
  if (bytes[0] & 0x80) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return encodeDer(Asn1Tag.integer, bytes);
}

export function encodeDerOid(oid: string): Buffer {
  if (!/^[0-2](\.\d+)+$/.test(oid)) {
    throw new TypeError(`invalid object identifier: ${oid}`);
  }
  const arcs = oid.split(".").map(Number);
  if (arcs[0] < 2 && arcs[1] >= 40) {
    throw new TypeError(`invalid object identifier: ${oid}`);
  }

  const bytes: number[] = [];
  for (const arc of [arcs[0] * 40 + arcs[1], ...arcs.slice(2)]) {
    if (!Number.isSafeInteger(arc)) {
      throw new TypeError(`invalid object identifier: ${oid}`);
    }
    const encoded = [arc & 0x7f];
    for (
      let value = Math.floor(arc / 0x80);
      value > 0;
      value = Math.floor(value / 0x80)
    ) {
      encoded.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...encoded);
  }

  return encodeDer(Asn1Tag.objectIdentifier, Buffer.from(bytes));
}

/** Encodes a BIT STRING with no unused bits. */
export function encodeDerBitString(content: Buffer): Buffer {
  return encodeDer(
    Asn1Tag.bitString,
    Buffer.concat([Buffer.from([0x00]), content]),
  );
}

export function encodeDerOctetString(content: Buffer): Buffer {
  return encodeDer(Asn1Tag.octetString, content);
}

export function encodeDerUtf8String(value: string): Buffer {
  return encodeDer(Asn1Tag.utf8String, Buffer.from(value, "utf8"));
}

export function encodeDerPrintableString(value: string): Buffer {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(value)) {
    throw new TypeError(`invalid PrintableString: ${value}`);
  }
  return encodeDer(Asn1Tag.printableString, Buffer.from(value, "ascii"));
}

/**
 * Encodes a time as RFC 5280 requires:
 * UTCTime through 2049, GeneralizedTime from 2050. Fractional seconds are dropped.
 */
export function encodeDerTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";

  if (year >= 1950 && year < 2050) {
    return encodeDer(
      Asn1Tag.utcTime,
      Buffer.from(pad(year % 100) + rest, "ascii"),
    );
  }
  if (year < 0 || year > 9999) {
    throw new RangeError(`unsupported year: ${year}`);
  }
  return encodeDer(
    Asn1Tag.generalizedTime,
    Buffer.from(year.toString().padStart(4, "0") + rest, "ascii"),
  );
}

/** Wraps DER bytes in a PEM block with 64-character lines. */
export function encodePem(label: string, der: Buffer): string {
  const base64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
