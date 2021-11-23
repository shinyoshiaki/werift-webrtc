/* eslint-disable prefer-const */
import { createHash } from "crypto";
import debug from "debug";
import { performance } from "perf_hooks";

import {
  bufferReader,
  bufferWriter,
  random16,
  random32,
  uint16Add,
  uint32Add,
} from "../../common/src";
import { CipherContext } from "../../dtls/src/context/cipher";
import { Address } from "../../ice/src";
import { RtpHeader, RtpPacket } from "../../rtp/src";
import { Direction, Directions } from "./media/rtpTransceiver";
import { RTCIceServer } from "./peerConnection";
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

/**https://datatracker.ietf.org/doc/html/rfc3550#section-4 */
export const ntpTime = () => {
  const now = performance.timeOrigin + performance.now() - Date.UTC(1900, 0, 1);

  const seconds = now / 1000;
  const [sec, msec] = seconds.toString().split(".").map(Number);

  const buf = bufferWriter([4, 4], [sec, msec]);

  return buf.readBigUInt64BE();
};

/**https://datatracker.ietf.org/doc/html/rfc3550#section-4 */
export const compactNtp = (ntp: bigint) => {
  const buf = bufferWriter([8], [ntp]);
  const [, sec, msec] = bufferReader(buf, [2, 2, 2, 2]);
  return bufferWriter([2, 2], [sec, msec]).readUInt32BE();
};

export function parseIceServers(iceServers: RTCIceServer[]) {
  const url2Address = (url?: string) => {
    if (!url) return;
    const [address, port] = url.split(":");
    return [address, parseInt(port)] as Address;
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
    this.timestamp = uint32Add(this.timestamp, 960);

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

/**
 *
 * @param signatureHash
 * @param namedCurveAlgorithm necessary when use ecdsa
 */
export const createSelfSignedCertificate =
  CipherContext.createSelfSignedCertificateWithKey;
