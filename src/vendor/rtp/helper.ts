export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export function assignClassProperties(ctx: any, props: any) {
  Object.keys(props).forEach((key: string) => {
    ctx[key] = props[key];
  });
}

export function bufferWriter(bytes: number[], values: (number | bigint)[]) {
  const length = bytes.reduce((acc, cur) => acc + cur, 0);
  const buf = Buffer.alloc(length);
  let offset = 0;

  values.forEach((v, i) => {
    const size = bytes[i];
    if (size === 8) buf.writeBigUInt64BE(v as bigint, offset);
    else buf.writeUIntBE(v as number, offset, size);

    offset += size;
  });
  return buf;
}

export function bufferReader(buf: Buffer, bytes: number[]) {
  let offset = 0;
  return bytes.map((v) => {
    let read: number | bigint;
    if (v === 8) {
      read = buf.readBigUInt64BE(offset);
    } else {
      read = buf.readUIntBE(offset, v);
    }

    offset += v;

    return read as any;
  });
}
