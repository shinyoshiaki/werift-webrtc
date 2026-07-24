import { isIPv4, isIPv6 } from "node:net";

/**
 * Convert an IPv4 / IPv6 text address to the STUN wire binary form.
 * IPv4 → 4 bytes, IPv6 → 16 bytes (supports :: compression and IPv4-mapped).
 */
export function ipAddressToBuffer(address: string): Buffer {
  if (isIPv4(address)) {
    const buf = Buffer.allocUnsafe(4);
    const parts = address.split(".");
    for (let i = 0; i < 4; i++) {
      buf[i] = Number(parts[i]) & 0xff;
    }
    return buf;
  }

  if (!isIPv6(address)) {
    throw new Error(`Invalid ip address: ${address}`);
  }

  const sections = address.split(":", 8);
  for (let i = 0; i < sections.length; i++) {
    let v4Buffer: Buffer | undefined;
    if (isIPv4(sections[i])) {
      v4Buffer = ipAddressToBuffer(sections[i]);
      sections[i] = v4Buffer.subarray(0, 2).toString("hex");
    }
    if (v4Buffer && ++i < 8) {
      sections.splice(i, 0, v4Buffer.subarray(2, 4).toString("hex"));
    }
  }

  if (sections[0] === "") {
    while (sections.length < 8) sections.unshift("0");
  } else if (sections[sections.length - 1] === "") {
    while (sections.length < 8) sections.push("0");
  } else if (sections.length < 8) {
    let emptyIndex = 0;
    for (
      ;
      emptyIndex < sections.length && sections[emptyIndex] !== "";
      emptyIndex++
    );
    const zeros: string[] = [];
    for (let n = 9 - sections.length; n > 0; n--) {
      zeros.push("0");
    }
    sections.splice(emptyIndex, 1, ...zeros);
  }

  const result = Buffer.allocUnsafe(16);
  let offset = 0;
  for (const section of sections) {
    const word = Number.parseInt(section, 16) || 0;
    result[offset++] = (word >> 8) & 0xff;
    result[offset++] = word & 0xff;
  }
  return result;
}

/**
 * Convert STUN address bytes (4 or 16) back to a text IP address.
 * IPv6 uses the same zero-run compression style as the previous `ip` helper.
 */
export function bufferToIpAddress(buf: Buffer): string {
  if (buf.length === 4) {
    return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
  }

  if (buf.length !== 16) {
    throw new Error(`Invalid ip address buffer length: ${buf.length}`);
  }

  const hextets: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    hextets.push(buf.readUInt16BE(i).toString(16));
  }
  let result = hextets.join(":");
  result = result.replace(/(^|:)0(:0)*:0(:|$)/, "$1::$3");
  result = result.replace(/:{3,4}/, "::");
  return result;
}

export function isIpV4Address(address: string): boolean {
  return isIPv4(address);
}

export function isIpV6Address(address: string): boolean {
  return isIPv6(address);
}
