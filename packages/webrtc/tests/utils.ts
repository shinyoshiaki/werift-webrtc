import { readFileSync } from "fs";
import { setTimeout as delay } from "timers/promises";

import { type Mock, vi } from "vitest";

import type { Connection, IceConnection } from "../../ice/src";
import {
  Candidate,
  CandidatePair,
  CandidatePairState,
  type Protocol,
} from "../../ice/src";
import { getHostAddresses } from "../../ice/src/utils";
import {
  createLocalStunServer,
  createLocalTurnServer,
  turnAllocations,
} from "../../ice/tests/utils";
import { SCTP_STATE } from "../../sctp/src";
import { DataChunk, parsePacket } from "../../sctp/src/chunk";
import type { SCTP } from "../../sctp/src/sctp";
import {
  type ConnectionState,
  type PeerConfig,
  type RTCDataChannel,
  type RTCDtlsTransport,
  RTCIceGatherer,
  type RTCIceServer,
  RTCIceTransport,
  RTCPeerConnection,
  type RTCSctpTransport,
  type RTCSdpType,
} from "../src";
import { Event } from "../src/imports/common";
import type { RTCTransportStats } from "../src/media/stats";
import { TransportActivation } from "../src/negotiation/transportActivation";

/**
 * Arrange: host-only ICE transports (1 controlling) where 2 has 1's
 * credentials but none of its candidates, and 1 does not start: checks that 2
 * starts wait for an incoming check on an empty check list.
 */
export async function createIceTransportsWithoutPeerCandidates(
  incomingCheckTimeout: number,
) {
  // Host candidates only: no query to the built-in public STUN server.
  const options = {
    incomingCheckTimeout,
    useIpv6: false,
    useDefaultStunServer: false,
  };
  const transport1 = new RTCIceTransport(new RTCIceGatherer(options));
  const transport2 = new RTCIceTransport(new RTCIceGatherer(options));
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;
  await Promise.all([transport1.gather(), transport2.gather()]);
  transport2.setRemoteParams(transport1.localParameters);
  return { transport1, transport2 };
}

/**
 * Arrange: `createIceTransportsWithoutPeerCandidates` with 2's start()
 * running. `starting` settles with that start().
 */
export async function startIceTransportWaitingForIncomingCheck(
  incomingCheckTimeout: number,
) {
  const { transport1, transport2 } =
    await createIceTransportsWithoutPeerCandidates(incomingCheckTimeout);
  const starting = transport2.start().then(
    () => ({ error: undefined as unknown }),
    (error: unknown) => ({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { transport1, transport2, starting };
}

/**
 * Arrange: end the ICE generation of the transports of
 * `createIceTransportsWithoutPeerCandidates`, synchronously. `restart` is
 * "local" (both restart) or "remote" (only 1 restarts, 2 drops its remote
 * generation and keeps its credentials and candidates).
 */
export function endIceTransportGeneration(
  transport1: RTCIceTransport,
  transport2: RTCIceTransport,
  restart: "local" | "remote",
) {
  transport1.restart(false);
  if (restart === "local") transport2.restart(false);
  else transport2.resetRemoteGeneration();
}

/**
 * Arrange: gather the generation `endIceTransportGeneration` began and
 * exchange every candidate and the credentials (no check starts).
 */
export async function exchangeIceTransportGeneration(
  transport1: RTCIceTransport,
  transport2: RTCIceTransport,
  restart: "local" | "remote",
) {
  if (restart === "local") {
    await Promise.all([transport1.gather(), transport2.gather()]);
  } else {
    await transport1.gather();
  }
  transport2.localCandidates.forEach(transport1.addRemoteCandidate);
  transport1.localCandidates.forEach(transport2.addRemoteCandidate);
  transport1.setRemoteParams(transport2.localParameters);
  transport2.setRemoteParams(transport1.localParameters);
}

/**
 * Arrange: a new ICE generation of the transports of
 * `startIceTransportWaitingForIncomingCheck` with every candidate exchanged.
 */
export async function restartIceTransportGeneration(
  transport1: RTCIceTransport,
  transport2: RTCIceTransport,
  restart: "local" | "remote",
) {
  endIceTransportGeneration(transport1, transport2, restart);
  await exchangeIceTransportGeneration(transport1, transport2, restart);
}

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/**
 * Shared Arrange: create a peer that does not contact the public default STUN
 * server. Tests that need STUN or TURN pass their local server in `config`.
 */
export function createLocalPeerConnection(config: Partial<PeerConfig> = {}) {
  return new RTCPeerConnection({
    iceServers: [],
    iceUseDefaultStunServer: false,
    ...config,
  });
}

/**
 * Create a PeerConnection with one data channel so that its first
 * RTCIceTransport exists, and return both.
 */
export function createPeerConnectionWithIceTransport(
  config: Partial<PeerConfig> = {},
) {
  const pc = createLocalPeerConnection(config);
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

/**
 * Arrange: an offer/answer exchange whose descriptions carry no candidate
 * (the a=candidate lines are dropped; end-of-candidates stays), so each side
 * checks nothing and waits for a check the other never sends.
 */
export async function negotiateWithoutCandidates(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
) {
  const strip = (description: { type: RTCSdpType; sdp: string }) => ({
    type: description.type,
    sdp: description.sdp
      .split("\r\n")
      .filter((line) => !line.startsWith("a=candidate:"))
      .join("\r\n"),
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(strip(offerer.localDescription!));
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(strip(answerer.localDescription!));
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

/**
 * Shared Arrange: gather `ice` until its gathering state is `complete`.
 * `gather()` resolves once the representative sockets are done; the other
 * sockets' server-reflexive candidates trickle and `complete` follows them,
 * so a test that needs gathering finished waits for the state as well.
 */
export async function gatherUntilComplete(ice: RTCIceTransport) {
  await ice.gather();
  await waitUntil(
    () => ice.gatheringState === "complete",
    "ICE gathering did not complete",
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
    await delay(20);
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

export function exchangeIceCandidates(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
) {
  // private function
  function doExchange(localPc: RTCPeerConnection, remotePc: RTCPeerConnection) {
    localPc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      if (remotePc.signalingState !== "closed") {
        remotePc.addIceCandidate(candidate).catch((error) => {
          const message = (error as Error).message;
          if (
            message === "The remote description was null" ||
            message.includes("usernameFragment")
          ) {
            return;
          }
          throw error;
        });
      }
    });
  }

  doExchange(pc1, pc2);
  doExchange(pc2, pc1);
}

export async function exchangeOfferAnswer(
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

export async function waitForConnectionState(
  pc: RTCPeerConnection,
  state: ConnectionState,
  timeoutMs = 5_000,
) {
  if (pc.connectionState === state) {
    return;
  }
  await Promise.race([
    pc.connectionStateChange.watch((current) => current === state),
    delay(timeoutMs).then(() => {
      throw new Error(
        `timed out waiting for connectionState ${state}, got ${pc.connectionState}`,
      );
    }),
  ]);
}

/** Arrange: wait until the peer's SCTP association reaches ESTABLISHED. */
export async function waitForSctpEstablished(
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (pc.sctpTransport?.sctp.associationState !== SCTP_STATE.ESTABLISHED) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the SCTP association");
    }
    await delay(10);
  }
}

export async function waitForDtlsState(
  transport: RTCDtlsTransport,
  state: RTCDtlsTransport["state"],
  timeoutMs = 5_000,
) {
  if (transport.state === state) {
    return;
  }
  await Promise.race([
    transport.onStateChange.watch((current) => current === state),
    delay(timeoutMs).then(() => {
      throw new Error(
        `timed out waiting for dtls state ${state}, got ${transport.state}`,
      );
    }),
  ]);
}

export async function waitForIceNominated(
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
) {
  const started = Date.now();
  for (;;) {
    const ice = pc.dtlsTransports[0]?.iceTransport;
    const iceUp = ice?.state === "connected" || ice?.state === "completed";
    if (ice?.connection.nominated && iceUp) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for ICE nominated pair (state=${ice?.state} nominated=${!!ice?.connection.nominated})`,
      );
    }
    await delay(50);
  }
}

export async function getTransportStats(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  return [...stats.values()].find(
    (stat): stat is RTCTransportStats => stat.type === "transport",
  );
}

/**
 * Arrange: a description whose ICE credentials changed (a restart by its
 * author only) and whose candidates have not arrived yet (trickled later).
 */
export function withRestartedIceCredentials(sdp: string) {
  return sdp
    .replace(/a=ice-ufrag:\S+/g, "a=ice-ufrag:rstr")
    .replace(/a=ice-pwd:\S+/g, "a=ice-pwd:restartedpassword0123456789")
    .split("\r\n")
    .filter(
      (line) =>
        !line.startsWith("a=candidate:") && line !== "a=end-of-candidates",
    )
    .join("\r\n");
}

export function mutateSdpFingerprint(sdp: string) {
  return sdp.replace(
    /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/g,
    (_match, algorithm: string, value: string) => {
      const flipped = `${value[0] === "A" || value[0] === "a" ? "B" : "A"}${value.slice(1)}`;
      return `a=fingerprint:${algorithm} ${flipped}`;
    },
  );
}

export function isProtocolVersionFailure(error?: Error) {
  if (!error) {
    return false;
  }
  return (
    error.name === "ProtocolVersionError" ||
    (error as { code?: string }).code === "protocol_version" ||
    /protocol_version/i.test(error.message)
  );
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
 * The TURN servers an ICE agent gathers from (username and transport of
 * each, in order), the ones `setConfiguration` / ICE restart applied.
 */
export function iceAgentTurnServers(connection: IceConnection) {
  return (connection.turnServers ?? []).map(({ username, transport }) => ({
    username,
    transport,
  }));
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
      turnServers: iceAgentTurnServers(connection),
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

/**
 * RFC 8832 5.1 DATA_CHANNEL_OPEN Channel Type for every combination of
 * ordered / unordered and reliable / retransmit-limited / lifetime-limited.
 */
export const DCEP_CHANNEL_TYPE_CASES: {
  name: string;
  options: {
    ordered: boolean;
    maxRetransmits?: number;
    maxPacketLifeTime?: number;
  };
  channelType: number;
  reliability: number;
}[] = [
  {
    name: "reliable ordered",
    options: { ordered: true },
    channelType: 0x00,
    reliability: 0,
  },
  {
    name: "retransmit-limited ordered",
    options: { ordered: true, maxRetransmits: 3 },
    channelType: 0x01,
    reliability: 3,
  },
  {
    name: "lifetime-limited ordered",
    options: { ordered: true, maxPacketLifeTime: 500 },
    channelType: 0x02,
    reliability: 500,
  },
  {
    name: "reliable unordered",
    options: { ordered: false },
    channelType: 0x80,
    reliability: 0,
  },
  {
    name: "retransmit-limited unordered (maxRetransmits: 0)",
    options: { ordered: false, maxRetransmits: 0 },
    channelType: 0x81,
    reliability: 0,
  },
  {
    name: "lifetime-limited unordered",
    options: { ordered: false, maxPacketLifeTime: 500 },
    channelType: 0x82,
    reliability: 500,
  },
];

/** RFC 9260 3.3.1: U bit of the DATA chunk flags (unordered delivery). */
export const SCTP_DATA_UNORDERED = 0x04;

/**
 * Record the PPID and options of every `SCTP.send()` call the transport makes.
 * Call it after `setDtlsTransport`, which recreates the SCTP association.
 */
export function captureSctpSendOptions(transport: RTCSctpTransport) {
  const calls: { ppId: number; options: Parameters<SCTP["send"]>[3] }[] = [];
  const sctp = transport.sctp;
  const send = sctp.send.bind(sctp);
  sctp.send = (streamId, ppId, userData, options) => {
    calls.push({ ppId, options });
    return send(streamId, ppId, userData, options);
  };
  return calls;
}

/**
 * Record every DATA chunk the transport puts on the wire, parsed back from
 * the serialized SCTP packets handed to the DTLS transport. Call it after
 * `setDtlsTransport`, which recreates the SCTP association.
 */
export function captureSctpDataChunks(transport: RTCSctpTransport) {
  const chunks: DataChunk[] = [];
  const lower = transport.sctp.transport;
  const send = lower.send.bind(lower);
  lower.send = (packet: Buffer) => {
    const [, , , parsed] = parsePacket(packet);
    chunks.push(
      ...parsed.filter(
        (chunk): chunk is DataChunk => chunk instanceof DataChunk,
      ),
    );
    return send(packet);
  };
  return chunks;
}

/**
 * Shared Arrange: an `RTCIceTransport` that is not connected, with remote
 * credentials and one pair whose ordinary check succeeded but that is not
 * nominated (no network: the pair is built from SDP candidates).
 */
export function createIceTransportWithValidPair() {
  const transport = new RTCIceTransport(new RTCIceGatherer({ useIpv6: false }));
  const connection = transport.connection as unknown as Connection;
  connection.remoteUsername = "remote";
  connection.remotePassword = "remote-password-0000000000";
  const local = Candidate.fromSdp(
    "1 1 udp 2130706431 127.0.0.1 40000 typ host",
  );
  const remote = Candidate.fromSdp(
    "2 1 udp 2130706431 127.0.0.1 40001 typ host",
  );
  const pair = new CandidatePair(
    { localCandidate: local } as unknown as Protocol,
    remote,
    true,
  );
  pair.updateState(CandidatePairState.SUCCEEDED);
  connection.checkList.push(pair);
  return { transport, connection, pair };
}

/** The `a=ice-options` lines of `sdp`. */
export function iceOptionLines(sdp: string) {
  return sdp.split("\r\n").filter((line) => line.startsWith("a=ice-options:"));
}

/**
 * Shared Arrange: two PeerConnections over loopback with their own
 * `PeerConfig` (e.g. `iceRenomination`), connected by one offer/answer
 * exchange. Returns the offer and answer SDP as sent and each side's ICE
 * agent (the offerer's is controlling). `beforeGather` runs on the offerer
 * once its ICE transport exists, before it gathers (e.g. `setConfiguration`,
 * which updates the agent only before gathering).
 */
export async function connectWithIceConfigs(
  offererConfig: Partial<PeerConfig>,
  answererConfig: Partial<PeerConfig>,
  {
    beforeGather,
  }: { beforeGather?: (offerer: RTCPeerConnection) => void } = {},
) {
  const shared: Partial<PeerConfig> = { iceServers: [], iceUseIpv6: false };
  const offerer = new RTCPeerConnection({ ...shared, ...offererConfig });
  const answerer = new RTCPeerConnection({ ...shared, ...answererConfig });
  if (beforeGather) {
    offerer.createDataChannel("before-gather");
    beforeGather(offerer);
  }
  await connectPeerConnections(offerer, answerer);
  return {
    offerer,
    answerer,
    offerSdp: offerer.localDescription!.sdp,
    answerSdp: answerer.localDescription!.sdp,
    controlling: firstIceTransport(offerer).connection,
    controlled: firstIceTransport(answerer).connection,
  };
}
/**
 * Shared Arrange: a local-only peer configuration (no STUN / TURN) whose ICE
 * agent sends checks with `iceMessageIntegrity` and records the integrity
 * algorithm of every connectivity check it receives.
 */
export function iceIntegrityConfig(config: Partial<PeerConfig> = {}): {
  config: Partial<PeerConfig>;
  received: (string | undefined)[];
} {
  const received: (string | undefined)[] = [];
  return {
    received,
    config: {
      iceServers: [],
      iceUseDefaultStunServer: false,
      ...config,
      iceFilterStunResponse: (message) => {
        received.push(message.integrityAlgorithm);
        return true;
      },
    },
  };
}

/** Every `a=ice-options` line of `sdp`. */
export function sdpIceOptionLines(sdp: string) {
  return sdp.split(/\r?\n/).filter((line) => line.startsWith("a=ice-options:"));
}

/**
 * Who awaits the ICE checks in `TransportActivation`:
 * - `connect-start` / `pending-start`: connect() / connectPending() starts
 *   them (`RTCIceTransport.start()`).
 * - `connect-waiter` / `pending-waiter`: they were started already, and
 *   connect() / connectPending() awaits them (`checksSettled()`).
 */
export type ActivationWaiter =
  | "connect-start"
  | "connect-waiter"
  | "pending-start"
  | "pending-waiter";

/**
 * How the awaited generation ends: `restart` (local ICE restart),
 * `resetRemoteGeneration` (remote-only restart) or `retire` (the transport
 * leaves the live / pending set and stops).
 */
export type ChecksEnd = "restart" | "resetRemoteGeneration" | "retire";

/**
 * Shared Arrange: a real `TransportActivation` over one real
 * `RTCIceTransport` whose checks wait for an incoming check (the peer never
 * starts), awaited by `waiter`. The other managers are stubs; the DTLS
 * transport only records `start()`. `running` settles with the activation
 * call; `end` ends the awaited generation.
 */
export async function startActivationWaiting(
  waiter: ActivationWaiter,
  /** Runs inside `setConnectionState` (a synchronous connectionstatechange subscriber). */
  onConnectionState?: (state: string, transport2: RTCIceTransport) => void,
) {
  const { transport1, transport2 } =
    await createIceTransportsWithoutPeerCandidates(30);
  const dtlsTransport = {
    id: "dtls",
    iceTransport: transport2,
    state: "new",
    hasRemoteParameters: true,
    onStateChange: new Event<[string]>(),
    onRoleChange: new Event<[]>(),
    start: vi.fn(async () => {}) as Mock<() => Promise<void>>,
  };
  const pending = waiter.startsWith("pending");
  const live = pending ? [] : [dtlsTransport];
  const pendingOnly = new Set(pending ? [transport2.id] : []);
  const setConnectionState: Mock<(state: string) => void> = vi.fn(
    (state: string) => onConnectionState?.(state, transport2),
  );
  const activation = new TransportActivation(
    {} as any,
    {
      dtlsTransports: live,
      iceTransports: live.map((transport) => transport.iceTransport),
      setConnectionState,
    } as any,
    {} as any,
    { sctpTransport: undefined } as any,
    {
      transportByMid: new Map([["0", dtlsTransport]]),
      isPendingOnlyTransport: (id: string) => pendingOnly.has(id),
    } as any,
    {} as any,
    {
      signalingState: () => "stable",
      config: () => ({}) as PeerConfig,
      createTransport: () => {
        throw new Error("not used");
      },
    },
  );

  if (waiter.endsWith("waiter")) {
    // The checks a previous call started; their own outcome is not checked.
    transport2.start().catch(() => {});
  }
  const running = (
    pending ? activation.connectPending() : activation.connect()
  ).then(
    () => ({ error: undefined as unknown }),
    (error: unknown) => ({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  const end = async (how: ChecksEnd) => {
    if (how === "restart") transport2.restart(false);
    else if (how === "resetRemoteGeneration") {
      transport2.resetRemoteGeneration();
    } else {
      live.splice(0);
      pendingOnly.clear();
      await transport2.stop();
    }
  };
  const cleanup = async () => {
    await Promise.all([transport1.stop(), transport2.stop()]);
  };
  return {
    transport1,
    transport2,
    dtlsTransport,
    setConnectionState,
    running,
    end,
    cleanup,
  };
}
