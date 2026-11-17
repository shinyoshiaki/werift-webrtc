/* eslint-disable prefer-const */
import { createHash } from "crypto";
import { createSocket } from "dgram";

import { performance } from "perf_hooks";
import type { RTCIceServer } from "./api/peerConfig";
import {
  type Address,
  bufferReader,
  bufferWriter,
  debug,
  randomPort,
} from "./imports/common";
import { CipherContext } from "./imports/dtls";
import { Directions, type MediaDirection } from "./media/rtpTransceiver";
import { MediaStreamTrack } from "./media/track";

const log = debug("werift:packages/webrtc/src/utils.ts");

export function fingerprint(file: Buffer, hashName: string) {
  const upper = (s: string) => s.toUpperCase();
  const colon = (s: any) => s.match(/(.{2})/g).join(":");

  const hash = createHash(hashName).update(file).digest("hex");

  return colon(upper(hash));
}

const fingerprintHashAlgorithms: Record<string, string> = {
  sha1: "sha1",
  "sha-1": "sha1",
  sha224: "sha224",
  "sha-224": "sha224",
  sha256: "sha256",
  "sha-256": "sha256",
  sha384: "sha384",
  "sha-384": "sha384",
  sha512: "sha512",
  "sha-512": "sha512",
};

export function normalizeFingerprintAlgorithm(algorithm: string) {
  return fingerprintHashAlgorithms[algorithm.trim().toLowerCase()];
}

export function normalizeFingerprintValue(value: string) {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

export function isDtls(buf: Buffer) {
  const firstByte = buf[0];
  return firstByte > 19 && firstByte < 64;
}

export function reverseSimulcastDirection(dir: "recv" | "send") {
  if (dir === "recv") return "send";
  return "recv";
}

export const andDirection = (a: MediaDirection, b: MediaDirection) =>
  Directions[Directions.indexOf(a) & Directions.indexOf(b)];

export function reverseDirection(dir: MediaDirection): MediaDirection {
  if (dir === "sendonly") return "recvonly";
  if (dir === "recvonly") return "sendonly";
  return dir;
}

export const milliTime = Date.now;

const startupTimestampInMicroseconds =
  BigInt(Date.now()) * 1000n - process.hrtime.bigint() / 1000n;

export const microTime = () => {
  return startupTimestampInMicroseconds + process.hrtime.bigint() / 1000n;
};

export const timestampSeconds = () => Date.now() / 1000;

const NTP_FRACTION_SCALE = 2 ** 32;

/**
 * 64bit NTP timestamp (32bit seconds . 32bit fraction of a second)
 * https://datatracker.ietf.org/doc/html/rfc3550#section-4
 */
export const ntpTime = (
  epochMs: number = performance.timeOrigin + performance.now(),
) => {
  const ntpMs = epochMs - Date.UTC(1900, 0, 1);

  const sec = Math.floor(ntpMs / 1000);
  const fraction = Math.min(
    Math.floor(((ntpMs - sec * 1000) / 1000) * NTP_FRACTION_SCALE),
    NTP_FRACTION_SCALE - 1,
  );

  const buf = bufferWriter([4, 4], [sec, fraction]);

  return buf.readBigUInt64BE();
};

export const ntpTimeToEpochMs = (ntp: bigint) => {
  const [seconds, fraction] = bufferReader(bufferWriter([8], [ntp]), [4, 4]);
  return (
    seconds * 1000 +
    (fraction / NTP_FRACTION_SCALE) * 1000 +
    Date.UTC(1900, 0, 1)
  );
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

/** A TURN URL of `RTCIceServer.urls` with the credential of its `RTCIceServer`. */
export type ParsedTurnServer = {
  address: Address;
  username?: string;
  password?: string;
  /** From the URL (scheme / `?transport=`); undefined when it names none. */
  transport?: "udp" | "tcp" | "tls";
  /**
   * The URLs naming this server, canonical (see {@link canonicalIceServerUrl})
   * and in configuration order; several when duplicates were merged.
   */
  urls: string[];
};

/** A STUN URL of `RTCIceServer.urls` and the address it names. */
export type ParsedStunServerUrl = { address: Address; url: string };

/**
 * The STUN and TURN servers of `iceServers`: every valid `stun:` / `stuns:`
 * URL and every valid `turn:` / `turns:` URL of every `RTCIceServer`, in
 * configuration order. A TURN URL carries the `username` / `credential` of
 * the `RTCIceServer` that lists it. Duplicates (the same STUN address; the
 * same TURN address, transport and credential) are kept once.
 *
 * The singular fields are the first STUN URL and the first TURN URL, kept
 * for compatibility.
 *
 * The URLs themselves (canonical, see {@link canonicalIceServerUrl}) are
 * kept to name a failing server in `icecandidateerror`: `stunServerUrls`
 * maps each STUN URL to its address, and every TURN server carries the
 * `urls` naming it (merged for duplicates).
 */
export function parseIceServers(iceServers: RTCIceServer[]) {
  const options: {
    stunServers: Address[];
    /** Every valid STUN URL with its address, in order (duplicate URLs once). */
    stunServerUrls: ParsedStunServerUrl[];
    turnServers: ParsedTurnServer[];
    /** @deprecated The first of `stunServers`. */
    stunServer?: Address;
    /** @deprecated The address of the first of `turnServers`. */
    turnServer?: Address;
    /** @deprecated The username of the first of `turnServers`. */
    turnUsername?: string;
    /** @deprecated The password of the first of `turnServers`. */
    turnPassword?: string;
    /** @deprecated The transport of the first of `turnServers`. */
    turnTransport?: "udp" | "tcp" | "tls";
  } = { stunServers: [], stunServerUrls: [], turnServers: [] };

  const sameAddress = (a: Address, b: Address) =>
    a[0] === b[0] && a[1] === b[1];

  for (const iceServer of iceServers) {
    const urls = Array.isArray(iceServer.urls)
      ? iceServer.urls
      : [iceServer.urls];
    for (const url of urls) {
      const parsed = parseIceServerUrl(url);
      if (!parsed) {
        continue;
      }

      const canonicalUrl = canonicalIceServerUrl(url)!;
      if (parsed.kind === "stun") {
        if (
          !options.stunServerUrls.some((known) => known.url === canonicalUrl)
        ) {
          options.stunServerUrls.push({
            address: parsed.address,
            url: canonicalUrl,
          });
        }
        if (
          !options.stunServers.some((address) =>
            sameAddress(address, parsed.address),
          )
        ) {
          options.stunServers.push(parsed.address);
        }
        continue;
      }

      const turnServer: ParsedTurnServer = {
        address: parsed.address,
        username: iceServer.username,
        password: iceServer.credential,
        transport: parsed.transport,
        urls: [canonicalUrl],
      };
      const known = options.turnServers.find(
        (known) =>
          sameAddress(known.address, turnServer.address) &&
          known.transport === turnServer.transport &&
          known.username === turnServer.username &&
          known.password === turnServer.password,
      );
      if (!known) {
        options.turnServers.push(turnServer);
      } else if (!known.urls.includes(canonicalUrl)) {
        known.urls.push(canonicalUrl);
      }
    }
  }

  const [stunServer] = options.stunServers;
  const [turnServer] = options.turnServers;
  options.stunServer = stunServer;
  if (turnServer) {
    options.turnServer = turnServer.address;
    options.turnTransport = turnServer.transport;
    options.turnUsername = turnServer.username;
    options.turnPassword = turnServer.password;
  }

  log("iceOptions", options);
  return options;
}

/**
 * The transport one TURN URL allocates over: the URL's own (scheme /
 * `?transport=`), else the configured `turnTransport`, else TCP for the
 * legacy `forceTurnTCP`, else undefined (UDP).
 */
export function resolveTurnTransport({
  configuredTurnTransport,
  forceTurnTCP,
  parsedTurnTransport,
}: {
  parsedTurnTransport?: "udp" | "tcp" | "tls";
  configuredTurnTransport?: "udp" | "tcp" | "tls";
  forceTurnTCP: boolean;
}) {
  if (parsedTurnTransport) {
    return parsedTurnTransport;
  }

  if (configuredTurnTransport) {
    return configuredTurnTransport;
  }

  if (forceTurnTCP) {
    return "tcp";
  }

  return undefined;
}

/**
 * The URL `icecandidateerror` reports for an `RTCIceServer` URL, or
 * undefined for a URL werift does not use (see parseIceServers). The rule:
 *
 * - the configured URL without surrounding whitespace and with a lower-case
 *   scheme; host, port and query are kept as configured (no default port is
 *   added);
 * - only a `turns:` URL without a `transport` query gets `?transport=tcp`
 *   (`&transport=tcp` after another query): TLS over TCP is its default
 *   (RFC 7065 §3), so the URL still names the same server. This matches
 *   Chrome and upstream WPT.
 *
 * `turn:`, `stun:` and `stuns:` are not changed; a `turn:` server whose UDP
 * allocation falls back to TCP keeps its `turn:` URL.
 */
export function canonicalIceServerUrl(url: string): string | undefined {
  if (typeof url !== "string" || !parseIceServerUrl(url)) return;
  const trimmed = url.trim();
  const colon = trimmed.indexOf(":");
  const scheme = trimmed.slice(0, colon).toLowerCase();
  const rest = trimmed.slice(colon + 1);
  if (scheme !== "turns") return `${scheme}:${rest}`;
  const [, query] = rest.split("?", 2);
  if (query !== undefined && new URLSearchParams(query).has("transport")) {
    return `${scheme}:${rest}`;
  }
  const separator =
    query === undefined ? "?" : query === "" || rest.endsWith("&") ? "" : "&";
  return `${scheme}:${rest}${separator}transport=tcp`;
}

function parseIceServerUrl(url: string) {
  const matched = /^(stun|stuns|turn|turns):(.+)$/i.exec(url.trim());
  if (!matched) {
    return;
  }

  const [, rawScheme, rawRest] = matched;
  const scheme = rawScheme.toLowerCase() as "stun" | "stuns" | "turn" | "turns";
  const [authority] = rawRest.split("?", 1);
  const [, query = ""] = rawRest.split("?");
  const address = parseAddress(authority, defaultPort(scheme));
  if (!address) {
    return;
  }

  if (scheme === "stun" || scheme === "stuns") {
    return { kind: "stun" as const, address };
  }

  const queryParams = new URLSearchParams(query);
  const transportParam = queryParams.get("transport");
  const transport = resolveParsedTurnTransport({
    scheme,
    transportParam,
  });
  if (transport === "invalid") {
    return;
  }

  return {
    kind: "turn" as const,
    address,
    transport,
  };
}

function resolveParsedTurnTransport({
  scheme,
  transportParam,
}: {
  scheme: "turn" | "turns";
  transportParam: string | null;
}): "udp" | "tcp" | "tls" | "invalid" | undefined {
  if (transportParam == null) {
    return scheme === "turns" ? "tls" : undefined;
  }

  if (transportParam === "udp") {
    return scheme === "turns" ? "invalid" : "udp";
  }

  if (transportParam === "tcp") {
    return scheme === "turns" ? "tls" : "tcp";
  }

  return "invalid";
}

function defaultPort(scheme: string) {
  if (scheme === "stuns" || scheme === "turns") {
    return 5349;
  }
  return 3478;
}

function parseAddress(
  value: string,
  fallbackPort: number,
): Address | undefined {
  const authority = value.startsWith("//") ? value.slice(2) : value;
  if (!authority) {
    return;
  }

  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket === -1) {
      return;
    }
    const host = authority.slice(1, closingBracket);
    const port = parsePort(authority.slice(closingBracket + 1), fallbackPort);
    return [host, port];
  }

  const firstColon = authority.indexOf(":");
  const lastColon = authority.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    return [
      authority.slice(0, firstColon),
      parsePort(authority.slice(firstColon + 1), fallbackPort),
    ];
  }

  return [authority, fallbackPort];
}

function parsePort(value: string, fallbackPort: number) {
  const portString = value.startsWith(":") ? value.slice(1) : value;
  const port = Number.parseInt(portString, 10);
  return Number.isFinite(port) ? port : fallbackPort;
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
    cb,
  }: {
    port?: number;
    kind: "audio" | "video";
    cb?: (buf: Buffer) => Buffer;
  }) {
    port ??= await randomPort();
    const track = new MediaStreamTrack({ kind });

    const udp = createSocket("udp4");
    udp.bind(port);
    const onMessage = (msg: Buffer) => {
      if (cb) {
        msg = cb(msg);
      }
      track.writeRtp(msg);
    };
    udp.addListener("message", onMessage);

    const dispose = () => {
      udp.removeListener("message", onMessage);
      try {
        udp.close();
      } catch (error) {}
    };

    return [track, port, dispose] as const;
  }
}

/**
 * Merge two objects. If a property value in the source object is undefined or
 * when casted is equal to undefined (== undefined), then it will not overwrite
 * the value of the property in the destination object.
 */
export const deepMerge = <T>(dst: T, src: T) => {
  if (!dst || typeof dst !== "object") {
    if (src !== null && typeof src === "object") {
      return src;
    } else {
      return dst;
    }
  }

  if (!src || typeof src !== "object") {
    if (src == undefined) {
      return dst;
    }
    return src;
  }

  for (const key in src) {
    if (Object.hasOwn(src, key)) {
      const sourceValue = src[key];

      if (sourceValue != undefined) {
        dst[key] = sourceValue;
      }
    }
  }
  return dst;
};
