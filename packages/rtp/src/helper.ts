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

export const timer = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => {
    const id = setTimeout(...args);
    return () => clearTimeout(id);
  },
  setInterval: (...args: Parameters<typeof setInterval>) => {
    const id = setInterval(
      () => {
        args[0]();
      },
      //@ts-ignore
      ...args.slice(1)
    );
    return () => clearInterval(id);
  },
};
export function isMedia(buf: Buffer) {
  const firstByte = buf[0];
  return firstByte > 127 && firstByte < 192;
}
