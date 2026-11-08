export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export function growBufferSize(buf: Buffer, size: number) {
  const glow = Buffer.alloc(size);
  buf.copy(glow);
  return glow;
}

export function Int(v: number) {
  return Number.parseInt(v.toString(), 10);
}

export const timer = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => {
    const id = setTimeout(...args);
    return () => clearTimeout(id);
  },
  setInterval: (callback: () => void, delay?: number) => {
    const id = setInterval(callback, delay);
    return () => clearInterval(id);
  },
};
export function isMedia(buf: Buffer) {
  const firstByte = buf[0];
  return firstByte > 127 && firstByte < 192;
}
