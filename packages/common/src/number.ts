export function uint8Add(a: number, b: number) {
  return (a + b) & 0xff;
}

export function uint16Add(a: number, b: number) {
  return (a + b) & 0xffff;
}

export function uint32Add(a: bigint, b: bigint) {
  return (a + b) & 0xffffffffn;
}

export function uint24(v: number) {
  return v & 0xffffff;
}

/**Return a > b */
export function uint16Gt(a: number, b: number) {
  const halfMod = 0x8000;
  return (a < b && b - a > halfMod) || (a > b && a - b < halfMod);
}

/**Return a >= b */
export function uint16Gte(a: number, b: number) {
  return a === b || uint16Gt(a, b);
}

/**Return a > b */
export function uint32Gt(a: number, b: number) {
  const halfMod = 0x80000000;
  return (a < b && b - a > halfMod) || (a > b && a - b < halfMod);
}

/**Return a >= b */
export function uint32Gte(a: number, b: number) {
  return a === b || uint32Gt(a, b);
}

export const int = (n: number) => parseInt(n as any, 10);
