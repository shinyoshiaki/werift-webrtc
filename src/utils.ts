import { createHash } from "crypto";

const upper = (s: string) => s.toUpperCase();
const colon = (s: any) => s.match(/(.{2})/g).join(":");

export function fingerprint(file: Buffer, hashname: string) {
  const hash = createHash(hashname).update(file).digest("hex");

  return colon(upper(hash));
}

export function isDtls(buf: Buffer) {
  const firstByte = buf[0];
  return firstByte > 19 && firstByte < 64;
}

export function isMedia(data: Buffer) {
  return data[0] > 127 && data[0] < 192;
}

export function isRtcp(buf: Buffer) {
  return buf.length >= 2 && buf[1] >= 192 && buf[1] <= 208;
}

export function reverseSimulcastDirection(dir: "recv" | "send") {
  if (dir === "recv") return "send";
  return "recv";
}
