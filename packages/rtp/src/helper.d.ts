export declare function enumerate<T>(arr: T[]): [number, T][];
export declare function growBufferSize(
  buf: Buffer,
  size: number,
): Buffer<ArrayBuffer>;
export declare function Int(v: number): number;
export declare const timer: {
  setTimeout: (
    callback: (_: void) => void,
    delay?: number | undefined,
  ) => () => void;
  setInterval: (
    callback: (_: void) => void,
    delay?: number | undefined,
  ) => () => void;
};
export declare function isMedia(buf: Buffer): boolean;
