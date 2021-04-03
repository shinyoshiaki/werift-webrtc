/* eslint-disable prefer-const */
import { createHash, randomBytes } from "crypto";
import { jspack } from "jspack";
import { performance } from "perf_hooks";
import { Direction } from "./media/rtpTransceiver";
const now = require("nano-time");

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

export function isMedia(buf: Buffer) {
  const firstByte = buf[0];
  return firstByte > 127 && firstByte < 192;
}

export function isRtcp(buf: Buffer) {
  return buf.length >= 2 && buf[1] >= 192 && buf[1] <= 208;
}

export function reverseSimulcastDirection(dir: "recv" | "send") {
  if (dir === "recv") return "send";
  return "recv";
}

export function reverseDirection(dir: Direction): Direction {
  if (dir === "sendonly") return "recvonly";
  if (dir === "recvonly") return "sendonly";
  return dir;
}

export const microTime = () => now.micro() as number;

export const milliTime = () => new Date().getTime();

export const ntpTime = () => {
  const now = performance.timeOrigin + performance.now() - Date.UTC(1900, 0, 1);

  const div = now / 1000;

  let [sec, msec] = div.toString().slice(0, 14).split(".");

  if (!msec) msec = "0";

  const high = BigInt(sec);
  const v = BigInt(msec + [...Array(6 - msec.length)].fill(0).join(""));

  const low = (v * (1n << 32n)) / 1000000n;

  return (high << 32n) | low;
};

export function random16() {
  return jspack.Unpack("!H", randomBytes(2))[0];
}

export function random32() {
  return BigInt(jspack.Unpack("!L", randomBytes(4))[0]);
}

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
