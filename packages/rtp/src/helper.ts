export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export function growBufferSize(buf: Buffer, size: number) {
  const glow = Buffer.alloc(size);
  buf.copy(glow);
  return glow;
}

export function Int(v: number) {
  return parseInt(v.toString(), 10);
}
