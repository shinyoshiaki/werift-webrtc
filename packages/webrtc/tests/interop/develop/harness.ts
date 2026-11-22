/**
 * Shared Arrange for the develop interoperability suite.
 *
 * The suite loads this branch's sources and a second revision's sources
 * (normally `develop`, checked out in a temporary worktree) into the same
 * process and connects them through plain JSON signaling, so every scenario
 * exercises real wire bytes between the two implementations.
 *
 * `WERIFT_DEVELOP_ROOT` points at the other revision's repository root
 * (`npm run test:interop-develop` prepares it). Without it the suite skips.
 */
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import * as warpCommon from "../../../../common/src";
import * as warpDtls from "../../../../dtls/src";
import * as warpIceServer from "../../../../ice-server/src";
import * as warpWebrtc from "../../../src";

export type WebrtcImpl = typeof warpWebrtc;
export type PeerConnection = InstanceType<WebrtcImpl["RTCPeerConnection"]>;
export type Side = "warp" | "develop";
export type Pairing = readonly [offerer: Side, answerer: Side];

export const developRoot = process.env.WERIFT_DEVELOP_ROOT;
/** The suite skips unless another revision is provided. */
export const interopDisabled = !developRoot;

/** Every offerer/answerer combination; develop/develop is the baseline. */
export const pairings: readonly Pairing[] = [
  ["develop", "develop"],
  ["warp", "develop"],
  ["develop", "warp"],
  ["warp", "warp"],
];

export const pairingLabel = ([offerer, answerer]: Pairing) =>
  `${offerer}(offer) x ${answerer}(answer)`;

type Impls = Record<Side, WebrtcImpl>;

/** Load both implementations once per test file. */
export async function loadImpls(): Promise<Impls> {
  if (!developRoot) throw new Error("WERIFT_DEVELOP_ROOT is not set");
  const entry = path.resolve(developRoot, "packages/webrtc/src/index.ts");
  const develop = (await import(
    /* @vite-ignore */ pathToFileURL(entry).href
  )) as WebrtcImpl;
  return { warp: warpWebrtc, develop };
}

/** The TURN server package of either revision (`werift-ice-server`). */
export async function loadIceServer(side: Side): Promise<typeof warpIceServer> {
  if (side === "warp") return warpIceServer;
  if (!developRoot) throw new Error("WERIFT_DEVELOP_ROOT is not set");
  const entry = path.resolve(developRoot, "packages/ice-server/src/index.ts");
  return import(/* @vite-ignore */ pathToFileURL(entry).href);
}

/** `werift-dtls` and the UDP transport of `werift-common` of either revision. */
export async function loadDtls(side: Side): Promise<{
  dtls: typeof warpDtls;
  common: typeof warpCommon;
}> {
  if (side === "warp") return { dtls: warpDtls, common: warpCommon };
  if (!developRoot) throw new Error("WERIFT_DEVELOP_ROOT is not set");
  const load = (entry: string) =>
    import(
      /* @vite-ignore */ pathToFileURL(path.resolve(developRoot!, entry)).href
    );
  return {
    dtls: await load("packages/dtls/src/index.ts"),
    common: await load("packages/common/src/index.ts"),
  };
}

/** Loopback-only, hermetic ICE so results do not depend on host interfaces. */
export const hermeticConfig = {
  iceUseDefaultStunServer: false,
  iceUseIpv6: false,
  iceInterfaceAddresses: { udp4: "127.0.0.1" },
} as const;

export function createPeer(
  impls: Impls,
  side: Side,
  config: Record<string, unknown> = {},
): PeerConnection {
  const { RTCPeerConnection } = impls[side];
  return new RTCPeerConnection({ ...hermeticConfig, ...config } as never);
}

/** Forward trickled candidates as JSON (the two sides use different classes). */
export function trickle(from: PeerConnection, to: PeerConnection) {
  return from.onIceCandidate.subscribe((candidate) => {
    if (!candidate) return;
    to.addIceCandidate(candidate.toJSON()).catch(() => {});
  });
}

/** One offer/answer round over plain JSON descriptions. */
export async function negotiate(
  offerer: PeerConnection,
  answerer: PeerConnection,
) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription({
    type: "offer",
    sdp: offerer.localDescription!.sdp,
  });
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription({
    type: "answer",
    sdp: answerer.localDescription!.sdp,
  });
}

/** Wait until the offer/answer leaves both sides with gathering complete. */
export async function negotiateWithoutTrickle(
  offerer: PeerConnection,
  answerer: PeerConnection,
) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await waitGatheringComplete(offerer);
  await answerer.setRemoteDescription({
    type: "offer",
    sdp: offerer.localDescription!.sdp,
  });
  await answerer.setLocalDescription(await answerer.createAnswer());
  await waitGatheringComplete(answerer);
  await offerer.setRemoteDescription({
    type: "answer",
    sdp: answerer.localDescription!.sdp,
  });
}

async function waitGatheringComplete(pc: PeerConnection) {
  if (pc.iceGatheringState === "complete") return;
  await withTimeout(
    pc.iceGatheringStateChange.watch((state) => state === "complete"),
    10_000,
    "ice gathering complete",
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = global.setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Record every connectionState a peer reports from now on. */
export function recordConnectionStates(pc: PeerConnection) {
  const states: string[] = [];
  pc.connectionStateChange.subscribe((state) => states.push(state));
  return states;
}

export async function waitConnectionState(
  pc: PeerConnection,
  state: string,
  ms = 10_000,
) {
  if (pc.connectionState === state) return;
  await withTimeout(
    pc.connectionStateChange.watch((s) => s === state),
    ms,
    `connectionState ${state}`,
  );
}

export async function waitUntil(
  predicate: () => boolean,
  ms: number,
  label: string,
) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await setTimeout(10);
  }
}

type Channel = ReturnType<PeerConnection["createDataChannel"]>;

/** Offerer creates the channel; resolves when both ends are open. */
export async function openDataChannel(
  offerer: PeerConnection,
  answerer: PeerConnection,
  label = "interop",
) {
  const remote = new Promise<Channel>((resolve) => {
    answerer.onDataChannel.subscribe((channel) => {
      if (channel.label !== label) return;
      if (channel.readyState === "open") resolve(channel);
      else
        channel.stateChanged
          .watch((s) => s === "open")
          .then(() => resolve(channel));
    });
  });
  const local = offerer.createDataChannel(label);
  const localOpen =
    local.readyState === "open"
      ? Promise.resolve()
      : local.stateChanged.watch((s) => s === "open");
  const [remoteChannel] = await withTimeout(
    Promise.all([remote, localOpen]),
    15_000,
    `datachannel ${label} open`,
  );
  return { local, remote: remoteChannel };
}

/** Send `messages` from `from` and resolve with what `to` receives in order. */
export async function transfer(
  from: Channel,
  to: Channel,
  messages: (string | Buffer)[],
) {
  const received: (string | Buffer)[] = [];
  const done = new Promise<void>((resolve) => {
    to.onMessage.subscribe((data) => {
      received.push(data);
      if (received.length === messages.length) resolve();
    });
  });
  for (const message of messages) from.send(message);
  await withTimeout(done, 20_000, "datachannel transfer");
  return received;
}

export function sampleMessages() {
  const big = Buffer.alloc(60_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  return [
    "hello",
    Buffer.from([0, 1, 2, 3, 255]),
    "x".repeat(1200),
    big,
    ...Array.from({ length: 50 }, (_, i) => `seq-${i}`),
  ];
}

/** Negotiated DTLS version reported by getStats (`"DTLS 1.2"` etc.). */
export async function transportTlsVersion(pc: PeerConnection) {
  const report = await pc.getStats();
  for (const stat of report.values() as Iterable<Record<string, unknown>>) {
    if (stat.type === "transport") return stat.tlsVersion as string | undefined;
  }
  return undefined;
}

/**
 * Keep writing RTP on `track` until `received` reports delivery.
 * Each side writes with its own implementation's RTP classes.
 */
export async function pumpRtp(
  impl: WebrtcImpl,
  track: InstanceType<WebrtcImpl["MediaStreamTrack"]>,
  payload: Buffer,
  received: () => boolean,
  label: string,
) {
  const deadline = Date.now() + 10_000;
  let sequenceNumber = 1;
  while (!received()) {
    if (Date.now() > deadline) throw new Error(`timeout: rtp ${label}`);
    const header = new impl.RtpHeader({
      sequenceNumber: sequenceNumber++,
      timestamp: sequenceNumber * 960,
    });
    track.writeRtp(new impl.RtpPacket(header, payload));
    await setTimeout(20);
  }
}

export type DtlsFlight =
  | "client-hello-1"
  | "hello-verify-request"
  | "client-hello-2"
  | "flight4"
  | "flight5"
  | "flight6";

/**
 * Classify one outgoing DTLS 1.2 datagram by flight.
 * `server` is learned from this side's own first handshake message.
 */
function classifyDtlsDatagram(
  buf: Buffer,
  role: { server?: boolean },
): DtlsFlight | undefined {
  const first = buf[0];
  if (first === undefined || first < 20 || first > 63) return undefined;
  let offset = 0;
  let flight: DtlsFlight | undefined;
  while (offset + 13 <= buf.length) {
    const contentType = buf[offset];
    const epoch = buf.readUInt16BE(offset + 3);
    const length = buf.readUInt16BE(offset + 11);
    const body = offset + 13;
    if (contentType === 22 && epoch === 0 && body < buf.length) {
      const hsType = buf[body];
      if (hsType === 1) {
        role.server ??= false;
        // ClientHello: version(2) random(32) session_id cookie
        const sessionIdLength = buf[body + 12 + 34] ?? 0;
        const cookieLength = buf[body + 12 + 35 + sessionIdLength] ?? 0;
        flight = cookieLength > 0 ? "client-hello-2" : "client-hello-1";
      } else if (hsType === 3) {
        role.server ??= true;
        flight = "hello-verify-request";
      } else if (hsType === 2) {
        role.server = true;
        flight = "flight4";
      } else if (role.server) {
        flight ??= "flight4";
      } else {
        flight ??= "flight5";
      }
    } else if (contentType === 20 || (contentType === 22 && epoch > 0)) {
      flight ??= role.server ? "flight6" : "flight5";
    }
    offset = body + length;
  }
  return flight;
}

/**
 * Drop the first transmission of one DTLS flight sent by `pc`.
 * A transmission is every matching datagram within 100 ms of the first one;
 * the retransmission timer (≥ 1 s in both revisions) resends it later.
 * Call after setLocalDescription and before the handshake starts.
 */
export function dropFirstDtlsFlight(pc: PeerConnection, flight: DtlsFlight) {
  const connection = pc.iceTransports[0]?.connection as
    | { send: (data: Buffer) => Promise<void> }
    | undefined;
  if (!connection) throw new Error("no ice transport to patch");
  const original = connection.send.bind(connection);
  const role: { server?: boolean } = {};
  const result = { dropped: 0, sent: [] as DtlsFlight[] };
  let windowStart: number | undefined;
  connection.send = async (data: Buffer) => {
    const kind = classifyDtlsDatagram(data, role);
    if (kind) result.sent.push(kind);
    if (kind === flight) {
      windowStart ??= Date.now();
      if (Date.now() - windowStart < 100) {
        result.dropped++;
        return;
      }
    }
    return original(data);
  };
  return result;
}

export async function closeAll(...pcs: PeerConnection[]) {
  await Promise.allSettled(pcs.map((pc) => pc.close()));
}
