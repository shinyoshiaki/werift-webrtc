import { jspack } from "jspack";
import { randomBytes, createHash } from "crypto";

export function generateUUID(): string {
  return new Array(4)
    .fill(0)
    .map(() => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16))
    .join("-");
}

export function random32() {
  return jspack.Unpack("!L", randomBytes(4))[0];
}

export function uint16Add(a: number, b: number) {
  return (a + b) & 0xfff;
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

export function enumerate<T>(arr: T[]) {
  return arr.map((v, i) => ({ i, v }));
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

const upper = (s: string) => s.toUpperCase();
const colon = (s: any) => s.match(/(.{2})/g).join(":");

export function fingerprint(file: Buffer, hashname: string) {
  const hash = createHash(hashname).update(file).digest("hex");

  return colon(upper(hash));
}

export function assignClassProperties(ctx: any, props: any) {
  Object.keys(props).forEach((key: string) => {
    ctx[key] = props[key];
  });
}
