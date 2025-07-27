import { isIPv4, isIPv6 } from 'net';

export const isV4Format = isIPv4;
export const isV6Format = isIPv6;

export function toBuffer(ip: string) {
  let offset = 0;

  let result: Buffer | undefined;

  if (isIPv4(ip)) {
    result = Buffer.alloc(4);
    ip.split('.').map((byte) => {
      result![offset++] = parseInt(byte, 10) & 0xff;
    });
  } else if (isIPv6(ip)) {
    const sections = ip.split(':', 8);

    let i = 0;
    for (i = 0; i < sections.length; i++) {
      const isv4 = isIPv4(sections[i]);
      let v4Buffer: Buffer | undefined;

      if (isv4) {
        v4Buffer = toBuffer(sections[i]);
        sections[i] = v4Buffer.slice(0, 2).toString('hex');
      }

      if (v4Buffer && ++i < 8) {
        sections.splice(i, 0, v4Buffer.slice(2, 4).toString('hex'));
      }
    }

    if (sections[0] === '') {
      while (sections.length < 8) sections.unshift('0');
    } else if (sections[sections.length - 1] === '') {
      while (sections.length < 8) sections.push('0');
    } else if (sections.length < 8) {
      for (i = 0; i < sections.length && sections[i] !== ''; i++);
      const argv: [number, number, ...any[]] = [i, 1];
      for (i = 9 - sections.length; i > 0; i--) {
        argv.push('0');
      }
      sections.splice(...argv);
    }

    result = Buffer.alloc(offset + 16);
    for (i = 0; i < sections.length; i++) {
      const word = parseInt(sections[i], 16);
      result[offset++] = (word >> 8) & 0xff;
      result[offset++] = word & 0xff;
    }
  }

  if (!result) {
    throw Error(`Invalid ip address: ${ip}`);
  }

  return result;
};

export function toString(buff: Buffer) {
  const length = buff.length;

  let result: string = '';
  if (length === 4) {
    // IPv4
    for (let i = 0; i < length; i++) {
      if (i) result += '.';
      result += buff[i];
    }
  } else if (length === 16) {
    // IPv6
    for (let i = 0; i < length; i += 2) {
      if (i) result += ':';
      result += buff.readUInt16BE(i).toString(16);
    }
    result = result.replace(/(^|:)0(?::0)*:0(:|$)/, '$1::$2');
    result = result.replace(/:{3,4}/, '::');
  }

  return result;
};

const isIntegerString = /^\d+$/;

export function isLoopback(addr: string) {
  // If addr is an IPv4 address in long integer form (no dots and no colons), convert it
  if (isIntegerString.test(addr)) {
    const numAddr = Number(addr)
    if (numAddr >= 0 && numAddr <= 0xFFFFFFFF) {
      addr = fromLong(Number(addr));
    } else {
      return false; // Invalid IPv4 address
    }
  }

  return (
    addr.startsWith('127.') ||
    addr === '::' ||
    addr === '::1' ||
    addr.startsWith('0x7f.') ||
    addr.startsWith('0177.') ||
    addr === 'fe80::1'
  );
};

export function fromLong(ipl: number) {
  return (`${ipl >>> 24}.${ipl >> 16 & 255}.${ipl >> 8 & 255}.${ipl & 255}`);
};

export default {
  toBuffer,
  toString,
  isLoopback,
  fromLong,
  isV4Format,
  isV6Format,
}
