/* eslint-disable prefer-const */
import { createHash, randomBytes } from "crypto";
import { jspack } from "jspack";
import { performance } from "perf_hooks";
import { Address } from "../../ice/src";
import { Direction, Directions } from "./media/rtpTransceiver";
import { IceServer } from "./peerConnection";
import debug from "debug";
import { RtpHeader, RtpPacket } from "../../rtp/src";
const now = require("nano-time");

const log = debug("werift/webrtc/utils");

export function fingerprint(file: Buffer, hashName: string) {
  const upper = (s: string) => s.toUpperCase();
  const colon = (s: any) => s.match(/(.{2})/g).join(":");

  const hash = createHash(hashName).update(file).digest("hex");

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

export const andDirection = (a: Direction, b: Direction) =>
  Directions[Directions.indexOf(a) & Directions.indexOf(b)];

export const orDirection = (a: Direction, b: Direction) =>
  Directions[Directions.indexOf(a) & Directions.indexOf(b)];

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

export function parseIceServers(iceServers: IceServer[]) {
  const url2Address = (url?: string) => {
    if (!url) return;
    const [address, port] = url.split(":");
    return [address, Number(port)] as Address;
  };

  const stunServer = url2Address(
    iceServers.find(({ urls }) => urls.includes("stun:"))?.urls.slice(5)
  );
  const turnServer = url2Address(
    iceServers.find(({ urls }) => urls.includes("turn:"))?.urls.slice(5)
  );
  const { credential, username } =
    iceServers.find(({ urls }) => urls.includes("turn:")) || {};

  const options = {
    stunServer,
    turnServer,
    turnUsername: username,
    turnPassword: credential,
  };
  log("iceOptions", options);
  return options;
}

export class RtpBuilder {
  sequenceNumber = random16();
  timestamp = random32();

  create(payload: Buffer) {
    this.sequenceNumber = uint16Add(this.sequenceNumber, 1);
    this.timestamp = uint32Add(this.timestamp, BigInt(960));

    const header = new RtpHeader({
      sequenceNumber: this.sequenceNumber,
      timestamp: Number(this.timestamp),
      payloadType: 96,
      extension: true,
      marker: false,
      padding: false,
    });
    const rtp = new RtpPacket(header, payload);
    return rtp;
  }
}
