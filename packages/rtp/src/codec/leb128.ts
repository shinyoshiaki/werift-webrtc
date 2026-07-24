/** Unsigned LEB128 encoder (package-private; not re-exported from public barrel). */
export function leb128encode(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error("LEB128 encode requires a non-negative safe integer");
  }

  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);

  return Buffer.from(bytes);
}
