/**
 * Shared parts of the negotiation differential tools (public API only): the
 * seeded PRNG, the two-peer session and the communication check.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Api = any;
export type Pc = any;

/** Load the public API of the werift checkout at `root`. */
export async function loadApi(root: string): Promise<Api> {
  return import(pathToFileURL(join(root, "packages/webrtc/src/index.ts")).href);
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(Object.assign(new Error("timeout"), { name: "Timeout" })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type Peer = {
  name: "a" | "b";
  pc: Pc;
  /** Outgoing track per transceiver this peer sends on. */
  outgoing: Map<any, any>;
  /** Created descriptions (offer / answer) this peer may apply later. */
  pool: { type: string; sdp: string }[];
  /** Candidates gathered and not trickled to the other peer yet. */
  candidates: (any | null)[];
  channel?: any;
  /** connectionState reported "failed" since the last record. */
  failed?: boolean;
};

/**
 * Two connected peers (video + DataChannel). `extra` adds configuration to
 * both (bundlePolicy, iceServers, iceTransportPolicy, rtcpMuxPolicy).
 */
export async function session(api: Api, extra: Record<string, unknown> = {}) {
  const config = {
    codecs: {
      audio: [api.useOPUS()],
      video: [api.useVP8(), api.useH264()],
    },
    ...extra,
  };
  const a: Peer = {
    name: "a",
    pc: new api.RTCPeerConnection(config),
    outgoing: new Map(),
    pool: [],
    candidates: [],
    failed: false,
  };
  const b: Peer = {
    name: "b",
    pc: new api.RTCPeerConnection(config),
    outgoing: new Map(),
    pool: [],
    candidates: [],
    failed: false,
  };
  for (const peer of [a, b]) {
    peer.pc.onIceCandidate.subscribe((candidate: any) => {
      peer.candidates.push(candidate ? candidate.toJSON() : null);
    });
    peer.pc.connectionStateChange.subscribe((state: string) => {
      if (state === "failed") peer.failed = true;
    });
  }
  b.pc.onDataChannel.subscribe((channel: any) => {
    b.channel = channel;
  });
  // b answers sendrecv on every m-line a remote offer adds.
  b.pc.onRemoteTransceiverAdded.subscribe((transceiver: any) => {
    const track = new api.MediaStreamTrack({ kind: transceiver.kind });
    b.outgoing.set(transceiver, track);
    transceiver.direction = "sendrecv";
    void transceiver.sender.replaceTrack(track);
  });
  a.pc.onRemoteTransceiverAdded.subscribe((transceiver: any) => {
    const track = new api.MediaStreamTrack({ kind: transceiver.kind });
    a.outgoing.set(transceiver, track);
    transceiver.direction = "sendrecv";
    void transceiver.sender.replaceTrack(track);
  });
  const video = new api.MediaStreamTrack({ kind: "video" });
  a.outgoing.set(a.pc.addTransceiver(video, { direction: "sendrecv" }), video);
  a.channel = a.pc.createDataChannel("diff");
  await a.pc.setLocalDescription(await a.pc.createOffer());
  await b.pc.setRemoteDescription(a.pc.localDescription);
  await b.pc.setLocalDescription(await b.pc.createAnswer());
  await a.pc.setRemoteDescription(b.pc.localDescription);
  a.candidates.length = 0;
  b.candidates.length = 0;
  return { a, b, api };
}

export type Ctx = Awaited<ReturnType<typeof session>>;

/** Whether a labelled RTP packet sent on `out` reaches `incoming` (retried). */
export async function rtpArrives(
  api: Api,
  out: any,
  incoming: any,
  label: string,
) {
  let received = false;
  const { unSubscribe } = incoming.onReceiveRtp.subscribe((packet: any) => {
    if (packet.payload.toString() === label) received = true;
  });
  try {
    for (let i = 0; i < 15 && !received; i++) {
      out.writeRtp(
        new api.RtpPacket(new api.RtpHeader(), Buffer.from(label)).serialize(),
      );
      await sleep(200);
    }
    return received;
  } finally {
    unSubscribe();
  }
}

export async function dataArrives(from: any, to: any, label: string) {
  if (!from || !to) return false;
  let received = false;
  const { unSubscribe } = to.onMessage.subscribe((data: any) => {
    if (data.toString() === label) received = true;
  });
  try {
    for (let i = 0; i < 15 && !received; i++) {
      try {
        if (from.readyState === "open") from.send(Buffer.from(label));
      } catch {}
      await sleep(200);
    }
    return received;
  } finally {
    unSubscribe();
  }
}

/** RTP per negotiated sending track (by MID) and DataChannel, both ways. */
export async function communication(ctx: Ctx, label: string) {
  const tracks: Record<string, boolean> = {};
  for (const [from, to] of [
    [ctx.a, ctx.b],
    [ctx.b, ctx.a],
  ] as const) {
    for (const [transceiver, track] of from.outgoing) {
      if (
        !transceiver.mid ||
        transceiver.stopped ||
        !["sendonly", "sendrecv"].includes(transceiver.currentDirection ?? "")
      ) {
        continue;
      }
      const remote = to.pc
        .getTransceivers()
        .find((t: any) => t.mid === transceiver.mid);
      if (
        !remote ||
        !["recvonly", "sendrecv"].includes(remote.currentDirection ?? "")
      ) {
        continue;
      }
      tracks[`${from.name}:${transceiver.mid}`] = await rtpArrives(
        ctx.api,
        track,
        remote.receiver.track,
        `${label}-${from.name}-${transceiver.mid}`,
      );
    }
  }
  return {
    tracks,
    dataAtoB: await dataArrives(ctx.a.channel, ctx.b.channel, `${label}-ab`),
    dataBtoA: await dataArrives(ctx.b.channel, ctx.a.channel, `${label}-ba`),
  };
}

/** The observable transceiver state of a peer (count, MID, directions, stop). */
export function transceiverSnapshot(peer: Peer) {
  return peer.pc.getTransceivers().map((t: any) => ({
    kind: t.kind,
    mid: t.mid ?? null,
    direction: t.direction,
    currentDirection: t.currentDirection ?? null,
    stopping: !!t.stopping,
    stopped: !!t.stopped,
  }));
}
