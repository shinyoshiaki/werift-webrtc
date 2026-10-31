import { readFileSync } from "fs";

import type { Connection } from "../../ice/src";
import { getHostAddresses } from "../../ice/src/utils";
import {
  createLocalStunServer,
  createLocalTurnServer,
  turnAllocations,
} from "../../ice/tests/utils";
import {
  type PeerConfig,
  type RTCDataChannel,
  type RTCIceServer,
  type RTCIceTransport,
  RTCPeerConnection,
} from "../src";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/**
 * Create a PeerConnection with one data channel so that its first
 * RTCIceTransport exists, and return both.
 */
export function createPeerConnectionWithIceTransport(
  config: Partial<PeerConfig> = {},
) {
  const pc = new RTCPeerConnection({ iceServers: [], ...config });
  pc.createDataChannel("ice-transport");
  const ice = (pc as any).secureManager.iceTransports[0] as RTCIceTransport;
  return { pc, ice };
}

/**
 * Shared Arrange: a local STUN server and a local TURN server that accepts
 * two credentials (`a` and `b`), for TURN credential rotation. `iceServers`
 * builds a configuration with the STUN server and the TURN server with one of
 * the credentials (or none for STUN only), so no test contacts a public
 * STUN server.
 */
export async function createTurnRotationServers() {
  const host = getHostAddresses(true, false)[0]!;
  const credentials = {
    a: { username: "user-a", credential: "pass-a" },
    b: { username: "user-b", credential: "pass-b" },
  };
  const turn = await createLocalTurnServer(host, {
    credentials: {
      [credentials.a.username]: credentials.a.credential,
      [credentials.b.username]: credentials.b.credential,
    },
  });
  const stun = await createLocalStunServer(host);
  const [turnHost, turnPort] = turn.address!;
  const stunIceServer: RTCIceServer = {
    urls: `stun:${host}:${stun.address![1]}`,
  };
  const iceServers = (credential?: keyof typeof credentials): RTCIceServer[] =>
    credential
      ? [
          stunIceServer,
          { urls: `turn:${turnHost}:${turnPort}`, ...credentials[credential] },
        ]
      : [stunIceServer];
  return {
    turn,
    credentials,
    iceServers,
    /** TURN usernames authenticated after `since` requests. */
    authenticatedSince: (since: number) =>
      turn.authenticatedUsernames.slice(since),
    close: async () => {
      await turn.close();
      await stun.close();
    },
  };
}

/**
 * Shared Arrange: connect `offerer` and `answerer` over a data channel with
 * one offer/answer exchange (candidates are in the descriptions, since
 * setLocalDescription gathers), and wait until both are connected.
 */
export async function connectPeerConnections(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  offerer.createDataChannel("connect");
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await waitUntil(
    () =>
      offerer.connectionState === "connected" &&
      answerer.connectionState === "connected",
    "peers did not connect",
  );
}

/** Complete one offer/answer exchange started by `offerer`. */
export async function negotiate(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
}

/** The first live RTCIceTransport of `pc` and its ICE agent. */
export function firstIceTransport(pc: RTCPeerConnection) {
  const ice = (pc as any).secureManager.iceTransports[0] as RTCIceTransport;
  return { ice, connection: ice.connection as unknown as Connection };
}

/** TURN allocations the ICE agent of `pc` currently holds. */
export function peerTurnAllocations(pc: RTCPeerConnection) {
  return turnAllocations(firstIceTransport(pc).connection);
}

/** Wait until the current ICE generation of `pc` finished gathering. */
export async function waitForLocalCandidatesEnd(pc: RTCPeerConnection) {
  const { connection } = firstIceTransport(pc);
  await waitUntil(
    () => connection.localCandidatesEnd,
    "local candidates did not complete",
  );
}

export async function waitUntil(
  condition: () => boolean,
  message: string,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function createDataChannelPair(
  options:
    | Partial<{
        maxPacketLifeTime?: number | undefined;
        protocol: string;
        maxRetransmits?: number | undefined;
        ordered: boolean;
        negotiated: boolean;
        id?: number | undefined;
      }>
    | undefined,
  pc1 = new RTCPeerConnection(),
  pc2 = new RTCPeerConnection(),
) {
  let pair: RTCDataChannel[] = [],
    bothOpen: Promise<void[]>;
  try {
    if (options?.negotiated) {
      pair = [pc1, pc2].map((pc) => pc.createDataChannel("", options));
      bothOpen = Promise.all(
        pair.map(
          (dc) =>
            new Promise<void>((r, e) => {
              dc.onopen = r;
              dc.onerror = ({ error }) => e(error);
            }),
        ),
      );
    } else {
      pair = [pc1.createDataChannel("", options)];
      bothOpen = Promise.all([
        new Promise<void>((r, e) => {
          pair[0].onopen = () => {
            r();
          };
          pair[0].onerror = ({ error }) => e(error);
        }),
        new Promise<void>(
          (r, e) =>
            (pc2.ondatachannel = ({ channel }) => {
              pair[1] = channel;
              channel.onopen = () => {
                r();
              };
              channel.onerror = ({ error }) => e(error);
            }),
        ),
      ]);
    }
    exchangeIceCandidates(pc1, pc2);
    await exchangeOfferAnswer(pc1, pc2);
    await bothOpen;
    return pair;
  } finally {
    for (const dc of pair) {
      dc.onopen = dc.onerror = null;
    }
  }
}

function exchangeIceCandidates(pc1: RTCPeerConnection, pc2: RTCPeerConnection) {
  // private function
  function doExchange(localPc: RTCPeerConnection, remotePc: RTCPeerConnection) {
    localPc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      if (remotePc.signalingState !== "closed") {
        remotePc.addIceCandidate(candidate).catch((error) => {
          if ((error as Error).message !== "The remote description was null") {
            throw error;
          }
        });
      }
    });
  }

  doExchange(pc1, pc2);
  doExchange(pc2, pc1);
}

async function exchangeOfferAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  await exchangeOffer(caller, callee);
  await exchangeAnswer(caller, callee);
}

async function exchangeOffer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  await caller.setLocalDescription(await caller.createOffer());
  await callee.setRemoteDescription(caller.localDescription!);
}
// Performs an answer exchange caller -> callee.
async function exchangeAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  // Note that caller's remote description must be set first; if not,
  // there's a chance that candidates from callee arrive at caller before
  // it has a remote description to apply them to.
  const answer = await callee.createAnswer();
  await caller.setRemoteDescription(answer);
  await callee.setLocalDescription(answer);
}

export function awaitMessage(channel: RTCDataChannel) {
  return new Promise<string | Buffer>((resolve, reject) => {
    Promise.all([
      new Promise<any>((r) =>
        channel.addEventListener("message", (e) => {
          r(e.data);
        }),
      ),
      channel.onMessage.asPromise(),
    ]).then(([msg]) => resolve(msg));

    channel.error.once(reject);
  });
}

export async function generateAudioReceiveOnlyOffer(pc: RTCPeerConnection) {
  pc.addTransceiver("audio", { direction: "recvonly" });
  return pc.createOffer();
}

function waitUntilEvent(obj, name) {
  return new Promise((r) => obj.addEventListener(name, r, { once: true }));
}

export function addEventListenerPromise(
  obj,
  type,
  listener?: (...args: any[]) => any,
) {
  if (!listener) {
    return waitUntilEvent(obj, type);
  }
  return new Promise((r) =>
    obj.addEventListener(
      type,
      (e) => {
        r(listener(e));
      },
      { once: true },
    ),
  );
}

export function assert_equals(a, b, msg: string) {
  expect(a).toEqual(b);
}

export function assert_true(a, msg: string) {
  expect(a).toBeTruthy();
}

/**
 * Measures how long the event loop is blocked: a heartbeat interval records
 * the maximum delay between its expected and actual firing.
 */
export function startEventLoopLagMonitor(intervalMs = 10) {
  let maxLagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return maxLagMs;
    },
  };
}

/** Deterministic binary messages; message i carries its index in the first 4 bytes. */
export function createIndexedMessages(count: number, size: number) {
  return [...Array(count)].map((_, i) => {
    const buf = Buffer.alloc(Math.max(4, size), i % 251);
    buf.writeUInt32BE(i, 0);
    return buf;
  });
}

/** Resolves with the first `count` messages the channel receives. */
export function collectChannelMessages(channel: RTCDataChannel, count: number) {
  return new Promise<(string | Buffer)[]>((resolve) => {
    const received: (string | Buffer)[] = [];
    const { unSubscribe } = channel.onMessage.subscribe((data) => {
      received.push(data);
      if (received.length === count) {
        unSubscribe();
        resolve(received);
      }
    });
  });
}

/** `udp/host`, `tcp/host`, `udp/srflx`, `udp/relay`, ... of a candidate line. */
export function candidateLabel(candidate: string) {
  const fields = candidate.replace(/^a=/, "").split(" ");
  const type = fields[fields.indexOf("typ") + 1];
  return `${fields[2].toLowerCase()}/${type}`;
}

/** Sorted, de-duplicated labels of the candidate lines of an SDP. */
export function sdpCandidateLabels(sdp: string) {
  return uniqueSorted(
    sdp
      .split(/\r?\n/)
      .filter((line) => line.startsWith("a=candidate:"))
      .map(candidateLabel),
  );
}

function uniqueSorted(labels: string[]) {
  return [...new Set(labels)].sort();
}

/** Sorted labels of the local candidates of `pc`'s current ICE generation. */
export function generationCandidateLabels(pc: RTCPeerConnection) {
  return uniqueSorted(
    firstIceTransport(pc).connection.localCandidates.map(
      (candidate) => `${candidate.transport.toLowerCase()}/${candidate.type}`,
    ),
  );
}

/** `raddr:rport` of an SDP candidate line ("none" without them). */
export function relatedAddressOf(candidate: string) {
  const raddr = candidate.match(/ raddr (\S+)/)?.[1];
  const rport = candidate.match(/ rport (\S+)/)?.[1];
  return raddr === undefined ? "none" : `${raddr}:${rport}`;
}

/** `raddr:rport` of the relay candidates in an SDP. */
export function sdpRelayRelatedAddresses(sdp: string) {
  return uniqueSorted(
    sdp
      .split(/\r?\n/)
      .filter((line) => line.startsWith("a=candidate:"))
      .filter((line) => line.includes(" typ relay"))
      .map(relatedAddressOf),
  );
}

/**
 * Shared Arrange: an offerer built with `initial` connected to a STUN-only
 * answerer, after the offerer finished gathering. The caller closes both.
 */
export async function createGatheredPeers(
  servers: Awaited<ReturnType<typeof createTurnRotationServers>>,
  initial: PeerConfig | Partial<PeerConfig>,
) {
  const offerer = new RTCPeerConnection(initial);
  const answerer = new RTCPeerConnection({ iceServers: servers.iceServers() });
  try {
    await connectPeerConnections(offerer, answerer);
    await waitForLocalCandidatesEnd(offerer);
  } catch (error) {
    await Promise.all([offerer.close(), answerer.close()]);
    throw error;
  }
  return { offerer, answerer };
}

/**
 * Shared Arrange + Act for the setConfiguration → ICE restart matrix: connect
 * an offerer built with `initial` to a STUN-only answerer, wait until the
 * offerer finished gathering, apply `change` with setConfiguration and
 * negotiate once without restartIce(). Returns what the restart produced:
 * whether it was requested and happened, the candidate kinds of the offer and
 * of what was trickled after it, the agent's options, the TURN usernames
 * authenticated after the change, and whether every TURN allocation of the
 * first generation was closed.
 */
export async function observeConfigurationRestart(
  servers: Awaited<ReturnType<typeof createTurnRotationServers>>,
  initial: PeerConfig | Partial<PeerConfig>,
  change: Partial<PeerConfig>,
) {
  const { offerer, answerer } = await createGatheredPeers(servers, initial);
  try {
    const { ice, connection } = firstIceTransport(offerer);
    const ufragBefore = ice.localParameters.usernameFragment;
    const staleAllocations = peerTurnAllocations(offerer);
    const closedAllocations = new Set<unknown>();
    for (const allocation of staleAllocations) {
      const close = allocation.close.bind(allocation);
      allocation.close = () => {
        closedAllocations.add(allocation);
        return close();
      };
    }
    const authenticatedBefore = servers.turn.authenticatedUsernames.length;
    const trickled: string[] = [];
    const trickledRelayRelated: string[] = [];
    offerer.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      trickled.push(candidateLabel(candidate.candidate));
      if (candidate.candidate.includes(" typ relay")) {
        trickledRelayRelated.push(relatedAddressOf(candidate.candidate));
      }
    });

    offerer.setConfiguration(change);
    const needRestart = (offerer as any).needRestart as boolean;
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);
    await answerer.setRemoteDescription(offerer.localDescription!);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);
    await waitForLocalCandidatesEnd(offerer);

    return {
      needRestart,
      restarted: ice.localParameters.usernameFragment !== ufragBefore,
      offer: sdpCandidateLabels(offer.sdp),
      trickled: uniqueSorted(trickled),
      trickledRelayRelated: uniqueSorted(trickledRelayRelated),
      localDescriptionRelayRelated: sdpRelayRelatedAddresses(
        offerer.localDescription!.sdp,
      ),
      generation: generationCandidateLabels(offerer),
      generationRelayRelated: uniqueSorted(
        connection.localCandidates
          .filter((candidate) => candidate.type === "relay")
          .map((candidate) => relatedAddressOf(candidate.toSdp())),
      ),
      options: connection.options,
      authenticated: [
        ...new Set(servers.authenticatedSince(authenticatedBefore)),
      ],
      staleAllocations: staleAllocations.length,
      staleAllocationsClosed: staleAllocations.every((allocation) =>
        closedAllocations.has(allocation),
      ),
    };
  } finally {
    await Promise.all([offerer.close(), answerer.close()]);
  }
}
