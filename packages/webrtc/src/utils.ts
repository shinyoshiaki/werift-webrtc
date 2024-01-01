/* eslint-disable prefer-const */
import { createHash } from "crypto";
import { RemoteInfo, createSocket } from "dgram";
import debug from "debug";
import mergeWith from "lodash/mergeWith";
import { performance } from "perf_hooks";

import { bufferReader, bufferWriter, randomPort } from "../../common/src";
import { CipherContext } from "../../dtls/src/context/cipher";
import { Address } from "../../ice/src";
import { Direction, Directions } from "./media/rtpTransceiver";
import { MediaStreamTrack } from "./media/track";
import { RTCIceServer } from "./peerConnection";
const now = require("nano-time");

const log = debug("werift:packages/webrtc/src/utils.ts");

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

export function reverseSimulcastDirection(dir: "recv" | "send") {
  if (dir === "recv") return "send";
  return "recv";
}

export const andDirection = (a: Direction, b: Direction) =>
  Directions[Directions.indexOf(a) & Directions.indexOf(b)];

export function reverseDirection(dir: Direction): Direction {
  if (dir === "sendonly") return "recvonly";
  if (dir === "recvonly") return "sendonly";
  return dir;
}

export const microTime = () => now.micro() as number;

export const milliTime = () => new Date().getTime();

export const timestampSeconds = () => Date.now() / 1000;

/**https://datatracker.ietf.org/doc/html/rfc3550#section-4 */
export const ntpTime = () => {
  const now = performance.timeOrigin + performance.now() - Date.UTC(1900, 0, 1);

  const seconds = now / 1000;
  const [sec, msec] = seconds.toString().split(".").map(Number);

  const buf = bufferWriter([4, 4], [sec, msec]);

  return buf.readBigUInt64BE();
};

/**
 * https://datatracker.ietf.org/doc/html/rfc3550#section-4
 * @param ntp
 * @returns 32bit
 */
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
    iceServers.find(({ urls }) => urls.includes("stun:"))?.urls.slice(5),
  );
  const turnServer = url2Address(
    iceServers.find(({ urls }) => urls.includes("turn:"))?.urls.slice(5),
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

/**
 *
 * @param signatureHash
 * @param namedCurveAlgorithm necessary when use ecdsa
 */
export const createSelfSignedCertificate =
  CipherContext.createSelfSignedCertificateWithKey;

export class MediaStreamTrackFactory {
  static async rtpSource({
    port,
    kind,
  }: {
    port?: number;
    kind: "audio" | "video";
  }) {
    port ??= await randomPort();
    const track = new MediaStreamTrack({ kind });

    const udp = createSocket("udp4");
    udp.bind(port);
    const onMessage = (msg: Buffer, rinfo: RemoteInfo) => {
      track.writeRtp(msg);
    };
    udp.addListener("message", onMessage);

    const dispose = () => {
      udp.removeListener("message", onMessage);
      udp.close();
    };

    return [track, port, dispose] as const;
  }
}

export const deepMerge = <T>(dst: T, src: T) =>
  mergeWith(dst, src, (obj, src) => {
    if (!(src == undefined)) {
      return src;
    }
    return obj;
  });
