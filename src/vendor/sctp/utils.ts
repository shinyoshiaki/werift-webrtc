import { jspack } from "jspack";
import { randomBytes } from "crypto";

export function random16() {
  return jspack.Unpack("!H", randomBytes(2))[0];
}

export function random32() {
  return jspack.Unpack("!L", randomBytes(4))[0];
}

export function uint16Add(a: number, b: number) {
  return (a + b) & 0xffff;
}

export function uint16Gt(a: number, b: number) {
  const halfMod = 0x8000;
  return (a < b && b - a > halfMod) || (a > b && a - b < halfMod);
}

export function uint16Gte(a: number, b: number) {
  return a === b || uint16Gt(a, b);
}

export function uint32Gt(a: number, b: number) {
  const halfMod = 0x80000000;
  return (a < b && b - a > halfMod) || (a > b && a - b < halfMod);
}

export function uint32Gte(a: number, b: number) {
  return a === b || uint32Gt(a, b);
}

export function uint32_add(a: bigint, b: bigint) {
  return (a + b) & 0xffffffffn;
}
