import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { vi } from "vitest";
import {
  Candidate,
  CandidatePairState,
  type Connection,
} from "../../../ice/src";
import { connectionDatagramEvent } from "../../../ice/src/internal/datagram";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { classes } from "../../../ice/src/stun/const";
import type { Message } from "../../../ice/src/stun/message";
import { StunProtocol } from "../../../ice/src/stun/protocol";
import { TcpActiveProtocol } from "../../../ice/src/stun/tcpProtocol";
import type { SCTP } from "../../../sctp/src";
import {
  CookieAckChunk,
  CookieEchoChunk,
  InitAckChunk,
  InitChunk,
  parsePacket,
} from "../../../sctp/src/chunk";
import {
  DtlsVersion,
  MediaStreamTrack,
  type RTCDataChannel,
  type RTCDtlsTransport,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useSdesRTPStreamId,
} from "../../src";
import type { RTCTransportStats } from "../../src/media/stats";
import type { RTCSessionDescriptionInit } from "../../src/sdpManager";
import { createSplitOffer } from "../negotiation/harness/negotiationTransactionUtils";
import { exchangeIceCandidates, exchangeOfferAnswer } from "../utils";

/*
 * Shared Arrange helpers for the WARP integration tests
 * (warpLifecycle / spedTiming / legacyCompatibility).
 */

// --- WARP lifecycle: early server data, close, COOKIE_ACK, ICE restart ---

export function createEarlyWarpPeers() {
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
    warp: { allowEarlyServerData: true },
  };
  return {
    server: new RTCPeerConnection(config),
    client: new RTCPeerConnection(config),
  };
}

export async function prepareWarpClose(hasSctp: boolean) {
  const { server, client } = createEarlyWarpPeers();
  if (hasSctp) {
    server.createDataChannel("close-before-ready");
  } else {
    server.addTransceiver("audio");
  }
  await server.setLocalDescription(await server.createOffer());
  await client.setRemoteDescription(server.localDescription!);
  // Applying this ungathered answer starts the server but cannot complete ICE.
  const answer = await client.createAnswer();
  return { server, client, answer };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function prepareDelayedCookieAck() {
  const { server, client } = createEarlyWarpPeers();
  const channels = [server, client].map((peer) =>
    peer.createDataChannel("cookie-ack", { negotiated: true, id: 0 }),
  );
  const dtls = client.sctp!.dtlsTransport;
  const originalSend = dtls.sendData;
  let ackSent!: (association: SCTP) => void;
  const entered = new Promise<SCTP>((resolve) => {
    ackSent = resolve;
  });
  const release = deferred();
  const completed = deferred();
  let held = false;
  // Negotiation can replace the initial early association. Capture the
  // instance actually sending COOKIE_ACK through this stable DTLS transport.
  const send = vi.spyOn(dtls, "sendData").mockImplementation(async (data) => {
    const association = client.sctp!.sctp;
    await originalSend(data);
    const chunks = parsePacket(data)[3];
    if (
      !held &&
      association.state !== "closed" &&
      chunks.some((chunk) => chunk.type === CookieAckChunk.type)
    ) {
      held = true;
      ackSent(association);
      await release.promise;
      completed.resolve();
    }
  });
  exchangeIceCandidates(server, client);
  return {
    server,
    client,
    channels,
    entered,
    release: release.resolve,
    completed: completed.promise,
    restore: () => {
      release.resolve();
      send.mockRestore();
    },
  };
}

export function observeUnhandledRejections() {
  const errors: unknown[] = [];
  const listener = (reason: unknown) => errors.push(reason);
  process.on("unhandledRejection", listener);
  return {
    errors,
    dispose: () => process.off("unhandledRejection", listener),
  };
}

export const nextTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Arrange: connected sendonly → recvonly audio peers with a continuous RTP
 * stream. `received` counts RTP delivered to the receiver's remote track.
 */
export async function prepareContinuousRtp() {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const track = new MediaStreamTrack({ kind: "audio" });
  sender.addTransceiver(track, { direction: "sendonly" });
  const stats = { received: 0 };
  receiver.onTrack.subscribe((remote) => {
    remote.onReceiveRtp.subscribe(() => {
      stats.received++;
    });
  });
  exchangeIceCandidates(sender, receiver);
  await exchangeOfferAnswer(sender, receiver);
  await Promise.all(
    [sender, receiver].map((pc) =>
      pc.connectionStateChange.watch((state) => state === "connected"),
    ),
  );

  let sequenceNumber = 0;
  const timer = setInterval(() => {
    const header = new RtpHeader({
      payloadType: 111,
      sequenceNumber: sequenceNumber++ & 0xffff,
      timestamp: sequenceNumber * 960,
    });
    track.writeRtp(new RtpPacket(header, Buffer.from("media")));
  }, 10);

  return {
    sender,
    receiver,
    stats,
    /** Resolves after `count` more RTP packets reached the receiver. */
    receivedMore: (count: number) => {
      const target = stats.received + count;
      return vi.waitFor(
        () => {
          if (stats.received < target) throw new Error("waiting for RTP");
        },
        { timeout: 2_000 },
      );
    },
    stop: () => clearInterval(timer),
  };
}

/** Arrange: the 5-tuple source the receiver currently sees for media. */
export function currentMediaSource(pc: RTCPeerConnection) {
  const connection = pc.dtlsTransports[0].iceTransport.connection;
  const pair = connection.nominated!;
  return { protocol: pair.protocol, address: pair.remoteAddr };
}

/** Arrange: register a new-generation remote candidate for an existing 5-tuple. */
export async function addSameAddressCandidate(
  pc: RTCPeerConnection,
  [host, port]: readonly [string, number],
) {
  const connection = pc.dtlsTransports[0].iceTransport.connection;
  await connection.addRemoteCandidate(
    Candidate.fromSdp(`restart 1 udp 2116026367 ${host} ${port} typ host`),
  );
  return connection.checkList.find(
    (pair) => pair.remoteAddr[0] === host && pair.remoteAddr[1] === port,
  );
}

/**
 * Arrange: early WARP peers where the DTLS server (SCTP initiator) holds the
 * first inbound COOKIE_ACK before its SCTP association processes it. At that
 * point the responder is already ESTABLISHED.
 */
export function prepareHeldCookieAckAtInitiator() {
  const { server, client } = createEarlyWarpPeers();
  const channels = [server, client].map((peer) =>
    peer.createDataChannel("held-cookie-ack", { negotiated: true, id: 0 }),
  );
  const dtls = server.sctp!.dtlsTransport;
  let receiver: (data: Buffer) => void = dtls.dataReceiver;
  let held: Buffer | undefined;
  let heldBy!: (association: SCTP) => void;
  const entered = new Promise<SCTP>((resolve) => {
    heldBy = resolve;
  });
  // SCTP re-assigns dataReceiver whenever it creates an association; wrap
  // whatever is installed so the hold also covers replaced instances.
  Object.defineProperty(dtls, "dataReceiver", {
    configurable: true,
    get: () => (data: Buffer) => {
      const chunks = parsePacket(data)[3];
      if (
        held === undefined &&
        chunks.some((chunk) => chunk.type === CookieAckChunk.type)
      ) {
        held = data;
        heldBy(server.sctp!.sctp);
        return;
      }
      receiver(data);
    },
    set: (next: (data: Buffer) => void) => {
      receiver = next;
    },
  });
  exchangeIceCandidates(server, client);
  return {
    server,
    client,
    channels,
    entered,
    /** Deliver the held COOKIE_ACK to whichever association is now installed. */
    release: () => {
      if (held) receiver(held);
    },
    restore: () => {
      Object.defineProperty(dtls, "dataReceiver", {
        configurable: true,
        writable: true,
        value: receiver,
      });
    },
  };
}

// --- SPED timing: delayed answerer / first SPED response ---

export async function prepareDelayedAnswerer(
  answererRole: "client" | "server",
) {
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
    warp: { allowEarlyServerData: true, earlyMediaPolicy: "buffer" as const },
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const outgoing = offerer.createDataChannel("early-binding");
  const incoming = new Promise<RTCDataChannel>((resolve) => {
    answerer.ondatachannel = ({ channel }) => resolve(channel);
  });
  exchangeIceCandidates(offerer, answerer);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  answerer.dtlsTransports[0].role = answererRole;
  const answer = await answerer.createAnswer();
  const ice = answerer.iceTransports[0].connection as Connection;
  const originalGather = ice.gatherCandidates.bind(ice);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gathering = vi
    .spyOn(ice, "gatherCandidates")
    .mockImplementation(async () => {
      await originalGather();
      // Keep the real sockets/candidate exchange running, but delay DTLS start.
      await gate;
    });
  await offerer.setRemoteDescription(answer);
  const runtime = getConnectionSpedRuntime(
    offerer.iceTransports[0].connection as Connection,
  )!;
  let received!: (message: Message) => void;
  const firstResponse = new Promise<Message>((resolve) => {
    received = resolve;
  });
  const originalReceive = runtime.handleAuthenticatedStun.bind(runtime);
  const receive = vi
    .spyOn(runtime, "handleAuthenticatedStun")
    .mockImplementation(async (...args) => {
      const result = await originalReceive(...args);
      if (args[0].messageClass === classes.RESPONSE) received(args[0]);
      return result;
    });
  return {
    offerer,
    answerer,
    answer,
    outgoing,
    incoming,
    firstResponse,
    runtime,
    release,
    restore: () => {
      release();
      gathering.mockRestore();
      receive.mockRestore();
    },
  };
}

// --- Legacy (non-WARP) negotiation compatibility ---

export function createCompatibilityPeers(count = 2) {
  const peers = Array.from(
    { length: count },
    () => new RTCPeerConnection({ iceServers: [] }),
  );
  return {
    peers,
    close: () => Promise.all(peers.map((peer) => peer.close())),
  };
}

export async function prepareProvisionalAnswers() {
  const scenario = createCompatibilityPeers(3);
  const [caller, first, second] = scenario.peers;
  caller.addTransceiver("audio");
  await caller.setLocalDescription(await caller.createOffer());
  for (const responder of [first, second]) {
    await responder.setRemoteDescription(caller.localDescription!);
  }
  const firstAnswer = await first.createAnswer();
  const secondAnswer = await second.createAnswer();
  return {
    ...scenario,
    caller,
    offer: caller.pendingLocalDescription,
    pranswer: {
      type: "pranswer" as const,
      sdp: firstAnswer.sdp.replace("a=setup:", "a=tls-id:first\r\na=setup:"),
    },
    answer: {
      type: "answer" as const,
      sdp: secondAnswer.sdp.replace("a=setup:", "a=tls-id:second\r\na=setup:"),
    },
  };
}

export async function prepareRidLoopback() {
  const config = {
    iceServers: [],
    headerExtensions: { video: [useSdesRTPStreamId()], audio: [] },
  };
  const sender = new RTCPeerConnection(config);
  const receiver = new RTCPeerConnection(config);
  sender.addTransceiver("video", {
    direction: "sendonly",
    simulcast: [
      { rid: "high", direction: "send" },
      { rid: "low", direction: "send" },
    ],
  });
  const input = receiver.addTransceiver("video", { direction: "recvonly" });
  const outputs = {
    high: receiver.addTransceiver("video", { direction: "sendonly" }).sender,
    low: receiver.addTransceiver("video", { direction: "sendonly" }).sender,
  };
  const received = { high: [] as number[], low: [] as number[] };
  for (const rid of ["high", "low"] as const) {
    outputs[rid].sendRtp = async (packet) => {
      received[rid].push(
        (packet instanceof RtpPacket ? packet : RtpPacket.deSerialize(packet))
          .header.sequenceNumber,
      );
    };
  }
  input.onTrack.subscribe((track) => {
    const output = outputs[track.rid as keyof typeof outputs];
    if (output) void output.replaceTrack(track);
  });
  await receiver.setRemoteDescription(await sender.createOffer());
  const extensionId = input.headerExtensions[0].id;
  return {
    received,
    packet: (rid: "high" | "low", sequenceNumber: number, includeRid = true) =>
      new RtpPacket(
        new RtpHeader({
          ssrc: rid === "high" ? 1001 : 2001,
          payloadType: input.codecs[0].payloadType,
          sequenceNumber,
          timestamp: sequenceNumber * 3000,
          extensions: includeRid
            ? [{ id: extensionId, payload: Buffer.from(rid) }]
            : [],
        }),
        Buffer.from([0x10, 0]),
      ),
    receive: (packet: RtpPacket) => input.dtlsTransport.onRtp.execute(packet),
    close: () => Promise.all([sender.close(), receiver.close()]),
  };
}

// --- WARP diagnostics (RTCTransportStats warp* fields) ---

/** Assert helper: the transport stats entry of a single-transport PeerConnection. */
export async function transportStatsOf(pc: RTCPeerConnection) {
  const stats = [...(await pc.getStats()).values()].find(
    (stat): stat is RTCTransportStats => stat.type === "transport",
  );
  if (!stats) throw new Error("transport stats not found");
  return stats;
}

/** Assert helper: only the WARP diagnostics fields of a transport stats entry. */
export function warpFieldsOf(stats: RTCTransportStats) {
  return {
    warpSpedState: stats.warpSpedState,
    warpCarrier: stats.warpCarrier,
    warpHandshakeRttMs: stats.warpHandshakeRttMs,
    warpDtlsRetransmissions: stats.warpDtlsRetransmissions,
    warpSpedRetransmissions: stats.warpSpedRetransmissions,
    warpEarlyBufferedPackets: stats.warpEarlyBufferedPackets,
    warpEarlyBufferedBytes: stats.warpEarlyBufferedBytes,
    warpEarlyDroppedPackets: stats.warpEarlyDroppedPackets,
    warpEarlyDroppedBytes: stats.warpEarlyDroppedBytes,
    warpEarlyServerSendUsed: stats.warpEarlyServerSendUsed,
    iceGeneration: stats.iceGeneration,
  };
}

/**
 * Assert helper: internal protocol sources behind the WARP diagnostics, read
 * without going through getStats so tests can compare the two.
 */
export function warpDiagnosticsSourceOf(pc: RTCPeerConnection) {
  const transport = pc.dtlsTransports[0] as unknown as {
    state: string;
    handshakeStartedAt?: number;
    peerAuthenticatedAt?: number;
    earlyServerSendUsed: boolean;
    readiness: Record<string, boolean>;
    dtls?: { totalRetransmitCount: number };
  };
  const ice = pc.iceTransports[0].connection as Connection;
  return {
    state: transport.state,
    readiness: { ...transport.readiness },
    handshakeStartedAt: transport.handshakeStartedAt,
    peerAuthenticatedAt: transport.peerAuthenticatedAt,
    earlyServerSendUsed: transport.earlyServerSendUsed,
    dtlsRetransmissions: transport.dtls?.totalRetransmitCount ?? 0,
    sped: getConnectionSpedRuntime(ice)?.diagnosticsSnapshot(),
    iceGeneration: ice.generation,
  };
}

/** Assert helper: the DTLS 1.3 engine of a transport (kept after socket detach). */
export function dtls13EngineOf(pc: RTCPeerConnection) {
  return (
    pc.dtlsTransports[0] as unknown as {
      dtls?: { engine13?: { closed: boolean } };
    }
  ).dtls?.engine13;
}

// --- DTLS role mapping (JSEP setup:active / setup:passive) ---

/**
 * Arrange: negotiate offerer/answerer with the answerer's DTLS role forced
 * (`client` = setup:active, `server` = setup:passive) and wait until the
 * offerer-created DataChannel is open on both sides.
 */
export async function connectWithAnswererDtlsRole(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  answererRole: "client" | "server",
) {
  const offererChannel = offerer.createDataChannel("role-mapping");
  const answererChannel = new Promise<RTCDataChannel>((resolve) => {
    answerer.ondatachannel = ({ channel }) => resolve(channel);
  });
  exchangeIceCandidates(offerer, answerer);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  answerer.dtlsTransports[0].role = answererRole;
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  const remote = await answererChannel;
  await Promise.all(
    [offererChannel, remote].map((channel) =>
      channel.readyState === "open"
        ? undefined
        : new Promise<void>((resolve, reject) => {
            channel.onopen = () => resolve();
            channel.onerror = ({ error }) => reject(error);
          }),
    ),
  );
  return { offererChannel, answererChannel: remote };
}

/** Assert helper: collect the next `count` messages of a DataChannel in order. */
export function collectMessages(channel: RTCDataChannel, count: number) {
  return new Promise<(string | Buffer)[]>((resolve) => {
    const messages: (string | Buffer)[] = [];
    channel.onMessage.subscribe((message) => {
      messages.push(message);
      if (messages.length === count) resolve(messages);
    });
  });
}

// --- SCTP fault injection + ICE restart (sped:false / SPED non-regression) ---

export type SctpFaultChunk = "INIT" | "INIT_ACK" | "COOKIE_ACK" | "COOKIE_ECHO";
export type SctpFaultRestartAt =
  | "none"
  | "dtls-connecting"
  | "cookie-wait"
  | "cookie-echoed";

export type SctpFaultScenario = {
  /** Answerer DTLS role (client = setup:active, server = setup:passive). */
  answererRole: "client" | "server";
  /** Silently drop the first SCTP packet carrying this chunk. */
  drop?: SctpFaultChunk;
  /** Make the first send of a packet carrying this chunk reject. */
  failSend?: SctpFaultChunk;
  /** When the offerer runs restartIce() + renegotiation. */
  restartAt: SctpFaultRestartAt;
  /** dtls.protocolVersions for both peers (default config when omitted). */
  protocolVersions?: DtlsVersion[];
  /**
   * Run the same scenario with SPED + DTLS 1.3 (`early` = allowEarlyServerData).
   * Omitted = default `sped: false` path.
   */
  sped?: { early: boolean };
};

const sctpFaultChunkType: Record<SctpFaultChunk, number> = {
  INIT: InitChunk.type,
  INIT_ACK: InitAckChunk.type,
  COOKIE_ACK: CookieAckChunk.type,
  COOKIE_ECHO: CookieEchoChunk.type,
};

/**
 * Arrange + Act: two PeerConnections (default `sped: false`, or SPED) with a negotiated
 * DataChannel, one SCTP fault and an optional ICE restart at a chosen point.
 * Returns once both channels exchanged a message (or the timeout elapsed),
 * with every connectionState each peer went through.
 */
export async function runSctpFaultScenario(
  scenario: SctpFaultScenario,
  timeoutMs = 20_000,
) {
  const config = scenario.sped
    ? {
        iceServers: [],
        sped: true,
        dtls: { protocolVersions: [DtlsVersion.V1_3] },
        warp: { allowEarlyServerData: scenario.sped.early },
      }
    : {
        iceServers: [],
        ...(scenario.protocolVersions
          ? { dtls: { protocolVersions: scenario.protocolVersions } }
          : {}),
      };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const states = { offerer: [] as string[], answerer: [] as string[] };
  offerer.connectionStateChange.subscribe((s) => states.offerer.push(s));
  answerer.connectionStateChange.subscribe((s) => states.answerer.push(s));
  const channels = [offerer, answerer].map((peer) =>
    peer.createDataChannel("fault", { negotiated: true, id: 0 }),
  );

  let restarted: Promise<void> | undefined;
  const restart = () => {
    restarted ??= (async () => {
      offerer.restartIce();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
    })();
  };
  const restartOnChunk: Partial<Record<SctpFaultRestartAt, number>> = {
    "cookie-wait": InitChunk.type,
    "cookie-echoed": CookieEchoChunk.type,
  };
  const faults = { dropped: false, failed: false };
  const spies = [offerer, answerer].map((peer) => {
    const dtls = peer.sctp!.dtlsTransport;
    const original = dtls.sendData;
    return vi.spyOn(dtls, "sendData").mockImplementation(async (data) => {
      const types = parsePacket(data)[3].map((chunk) => chunk.type);
      const trigger = restartOnChunk[scenario.restartAt];
      if (trigger !== undefined && types.includes(trigger)) {
        setImmediate(restart);
      }
      if (
        scenario.drop &&
        !faults.dropped &&
        types.includes(sctpFaultChunkType[scenario.drop])
      ) {
        faults.dropped = true;
        return;
      }
      if (
        scenario.failSend &&
        !faults.failed &&
        types.includes(sctpFaultChunkType[scenario.failSend])
      ) {
        faults.failed = true;
        throw new Error("injected send failure");
      }
      return original(data);
    });
  });

  exchangeIceCandidates(offerer, answerer);
  const messages = channels.map(
    (channel) =>
      new Promise<string>((resolve) => {
        channel.onMessage.subscribe((m) => resolve(m.toString()));
      }),
  );
  const open = channels.map(
    (channel) =>
      new Promise<void>((resolve) => {
        if (channel.readyState === "open") resolve();
        channel.stateChanged.subscribe((state) => {
          if (state === "open") resolve();
        });
      }),
  );

  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  answerer.dtlsTransports[0].role = scenario.answererRole;
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  if (scenario.restartAt === "dtls-connecting") restart();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([
    (async () => {
      await Promise.all(open);
      if (restarted) await restarted;
      channels[0].send("from-offerer");
      channels[1].send("from-answerer");
      const received = await Promise.all(messages);
      // SPED can deliver while connectionState is still settling after a
      // restart; report the state only once both peers are connected.
      while (
        offerer.connectionState !== "connected" ||
        answerer.connectionState !== "connected"
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return received;
    })(),
    timedOut,
  ]);
  clearTimeout(timer);

  return {
    states,
    faults,
    dtls13: offerer.dtlsTransports[0]?.dtls?.isDtls13 === true,
    delivered: outcome !== "timeout",
    messages: outcome === "timeout" ? undefined : outcome,
    restarted: restarted !== undefined,
    close: async () => {
      for (const spy of spies) spy.mockRestore();
      await Promise.allSettled([offerer.close(), answerer.close()]);
    },
  };
}

// --- ICE restart after authentication (selected pair switch) ---

/** Assert helper: the nominated pair of a PeerConnection's first ICE transport. */
export function selectedPairOf(pc: RTCPeerConnection) {
  const ice = pc.iceTransports[0].connection as Connection;
  const pair = ice.nominated;
  return {
    pair,
    localPort: pair?.localCandidate.port,
    remotePort: pair?.remoteAddr[1],
    generation: ice.generation,
  };
}

/**
 * Act helper: offerer-initiated ICE restart + renegotiation, until both
 * nominate. `signal` may rewrite each description on its way to the peer.
 */
export async function restartIceAndRenegotiate(
  offerer: RTCPeerConnection,
  answerer: RTCPeerConnection,
  signal = (sdp: RTCSessionDescriptionInit) => sdp,
) {
  await offerer.setLocalDescription(
    await offerer.createOffer({ iceRestart: true }),
  );
  await answerer.setRemoteDescription(signal(offerer.localDescription!));
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(signal(answerer.localDescription!));
  const generation = selectedPairOf(offerer).generation;
  for (const pc of [offerer, answerer]) {
    const deadline = Date.now() + 10_000;
    while (
      selectedPairOf(pc).generation !== generation ||
      !(pc.iceTransports[0].connection as Connection).nominated ||
      pc.connectionState !== "connected"
    ) {
      if (Date.now() > deadline) throw new Error("ICE restart did not settle");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

// --- ICE restart onto a new path (the other address family's socket) ---

const candidateIsIpv6 = (candidateLine: string) =>
  candidateLine.split(" ")[4].includes(":");

/**
 * Arrange: connected peers with a DataChannel whose only host candidates are
 * 127.0.0.1 and ::1. ICE restart keeps the sockets, so a restart reaches a
 * new 5-tuple only through the other family's socket: `restartOntoOtherFamily`
 * drops the selected family's candidates from then on (trickle and SDP), so
 * the restart can only select a pair on the other family.
 */
export async function connectDualFamilyDataChannelPeers(
  config: ConstructorParameters<typeof RTCPeerConnection>[0],
) {
  const dualFamily = {
    ...config,
    iceUseIpv4: true,
    iceUseIpv6: true,
    iceInterfaceAddresses: { udp4: "127.0.0.1", udp6: "::1" },
  };
  const offerer = new RTCPeerConnection(dualFamily);
  const answerer = new RTCPeerConnection(dualFamily);
  let excludeIpv6: boolean | undefined;
  const accepts = (candidateLine: string) =>
    excludeIpv6 === undefined || candidateIsIpv6(candidateLine) !== excludeIpv6;
  for (const [local, remote] of [
    [offerer, answerer],
    [answerer, offerer],
  ]) {
    local.onIceCandidate.subscribe((candidate) => {
      if (
        !candidate?.candidate ||
        !accepts(candidate.candidate) ||
        remote.signalingState === "closed"
      ) {
        return;
      }
      remote.addIceCandidate(candidate).catch(() => {});
    });
  }
  const dc1 = offerer.createDataChannel("restart");
  const dc2 = new Promise<RTCDataChannel>((resolve) => {
    answerer.onDataChannel.subscribe(resolve);
  });
  await exchangeOfferAnswer(offerer, answerer);
  const channels = [dc1, await dc2];
  await Promise.all(
    channels.map((dc) =>
      dc.readyState === "open"
        ? undefined
        : new Promise<void>((resolve) => {
            dc.onopen = () => resolve();
          }),
    ),
  );
  await Promise.all(
    [offerer, answerer].map(async (pc) => {
      const deadline = Date.now() + 10_000;
      while (!(pc.iceTransports[0].connection as Connection).nominated) {
        if (Date.now() > deadline) throw new Error("ICE did not nominate");
        await new Promise((r) => setTimeout(r, 20));
      }
    }),
  );
  return {
    offerer,
    answerer,
    dc1: channels[0],
    dc2: channels[1],
    /** Act helper: ICE restart that can only select the other family. */
    restartOntoOtherFamily: async () => {
      const selected = selectedPairOf(offerer).pair!;
      excludeIpv6 = selected.remoteAddr[0].includes(":");
      await restartIceAndRenegotiate(offerer, answerer, ({ type, sdp }) => ({
        type,
        sdp: sdp!
          .split("\r\n")
          .filter(
            (line) =>
              !line.startsWith("a=candidate:") || accepts(line.slice(2)),
          )
          .join("\r\n"),
      }));
    },
  };
}

// --- SPED: the two peers select different paths (IPv4 / IPv6) ---

/** Arrange: SPED peers whose only host candidates are 127.0.0.1 and ::1. */
export function createDualFamilyLoopbackSpedPeers() {
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
    iceUseIpv4: true,
    iceUseIpv6: true,
    iceInterfaceAddresses: { udp4: "127.0.0.1", udp6: "::1" },
  };
  return {
    caller: new RTCPeerConnection(config),
    callee: new RTCPeerConnection(config),
  };
}

const isIpv6 = (host: string) => host.includes(":");

/**
 * Arrange: give both peers a succeeded IPv4 and IPv6 pair. ICE stops the
 * remaining checks once a pair is nominated, so the other family may be left
 * IN_PROGRESS / FAILED; run a connectivity check for it explicitly instead of
 * waiting for one that will never come. The nominated pair stays untouched
 * (checkComplete never overwrites it).
 */
export async function waitForBothFamilySucceeded(
  peers: RTCPeerConnection[],
  timeoutMs = 10_000,
) {
  const succeededFamily = (ice: Connection, ipv6: boolean) =>
    ice.checkList.some(
      (pair) =>
        pair.state === CandidatePairState.SUCCEEDED &&
        isIpv6(pair.remoteAddr[0]) === ipv6,
    );
  const ready = () =>
    peers.every((pc) => {
      const ice = pc.iceTransports[0].connection as Connection;
      return [true, false].every((ipv6) => succeededFamily(ice, ipv6));
    });
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error("both address families need a succeeded pair");
    }
    await Promise.all(
      peers.flatMap((pc) => {
        const ice = pc.iceTransports[0].connection as Connection;
        return [true, false]
          .filter((ipv6) => !succeededFamily(ice, ipv6))
          .flatMap((ipv6) =>
            ice.checkList.filter((pair) => isIpv6(pair.remoteAddr[0]) === ipv6),
          )
          .map(async (pair) => {
            pair.handle?.resolve();
            pair.handle = ice.checkStart(pair);
            await pair.handle.awaitable;
          });
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Arrange: make the peers use paths of different address families. The
 * receiver selects one family; the sender selects the other one, which is
 * neither the receiver's selected pair nor the SPED handshake path the
 * receiver pinned (so only its authentication admits the sender's records).
 * @returns the receiver's pair of the 5-tuple the sender now uses.
 */
export function steerToDifferentFamilies(
  receiver: RTCPeerConnection,
  sender: RTCPeerConnection,
) {
  const receiverIce = receiver.iceTransports[0].connection as Connection;
  const senderIce = sender.iceTransports[0].connection as Connection;
  const pinned = getConnectionSpedRuntime(receiverIce)?.lastPath;
  const senderFamilyIpv6 = pinned ? !isIpv6(pinned.remoteAddr[0]) : true;
  const succeeded = (ice: Connection, ipv6: boolean) =>
    ice.checkList.find(
      (pair) =>
        pair.state === CandidatePairState.SUCCEEDED &&
        isIpv6(pair.remoteAddr[0]) === ipv6,
    );
  const receiverSelected = succeeded(receiverIce, !senderFamilyIpv6);
  const senderSelected = succeeded(senderIce, senderFamilyIpv6);
  if (!receiverSelected || !senderSelected) {
    throw new Error("both address families need a succeeded pair");
  }
  receiverIce.nominated = receiverSelected;
  senderIce.nominated = senderSelected;
  const receiverPairOfSenderPath = receiverIce.checkList.find(
    (pair) =>
      pair.remoteAddr[0] === senderSelected.localCandidate.host &&
      pair.remoteAddr[1] === senderSelected.localCandidate.port,
  );
  if (!receiverPairOfSenderPath) {
    throw new Error("the receiver has no pair for the sender's path");
  }
  // The receiver did not select the sender's path in any way.
  receiverPairOfSenderPath.nominated = false;
  receiverPairOfSenderPath.remoteNominated = false;
  return { receiverPairOfSenderPath, senderSelected };
}

// --- WARP configuration reaching every open transport ---

const bufferingWarpConfig = () => ({
  iceServers: [],
  bundlePolicy: "max-bundle" as const,
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3] },
  warp: { allowEarlyServerData: true, earlyMediaPolicy: "buffer" as const },
});

/**
 * Arrange: a connected session whose three m-lines share one BUNDLE
 * transport; the answerer applied an offer that splits `mid` out of BUNDLE
 * and created its answer, so the split transport is prepared but not live.
 */
export async function prepareSplitAnswerWithPreparedTransport(mid = "1") {
  const offerer = new RTCPeerConnection(bufferingWarpConfig());
  const answerer = new RTCPeerConnection(bufferingWarpConfig());
  offerer.addTransceiver("audio");
  offerer.addTransceiver("video");
  offerer.createDataChannel("warp-config");
  await exchangeOfferAnswer(offerer, answerer);
  await Promise.all(
    [offerer, answerer].map((pc) =>
      pc.connectionState === "connected"
        ? undefined
        : pc.connectionStateChange.watch((s) => s === "connected"),
    ),
  );
  const split = await createSplitOffer(offerer, mid);
  await offerer.setLocalDescription({ type: "offer", sdp: split });
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answer = await answerer.createAnswer();
  return { offerer, answerer, answer };
}

/** Assert helper: the WARP policy of every created, not yet closed transport. */
export function openTransportWarpConfigs(pc: RTCPeerConnection) {
  const secure = (
    pc as unknown as {
      secureManager: {
        openDtlsTransports: { id: string; config: { warp?: unknown } }[];
      };
    }
  ).secureManager;
  return secure.openDtlsTransports.map((transport) => ({
    id: transport.id,
    warp: transport.config.warp,
  }));
}

// --- WARP early server media without SCTP ---

/**
 * Arrange: keep a transport's peer authentication pending until `release`
 * (its handling of the peer's Finished waits). On the DTLS server this holds
 * it in the 0.5-RTT window: write-ready but the client not yet authenticated.
 * Replaces `transport.start` before the description that starts it.
 */
export function holdPeerAuthentication(client: RTCDtlsTransport) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  type HeldDtls = { waitForPeerHandshakeAuthenticated: () => Promise<void> };
  const originalStart = client.start.bind(client);
  client.start = async () => {
    const started = originalStart();
    while (!(client as unknown as { dtls?: HeldDtls }).dtls) {
      await nextTurn();
    }
    const dtls = (client as unknown as { dtls: HeldDtls }).dtls;
    const originalWait = dtls.waitForPeerHandshakeAuthenticated.bind(dtls);
    dtls.waitForPeerHandshakeAuthenticated = async () => {
      await originalWait();
      await held;
    };
    return started;
  };
  return { release };
}

// --- SPED final ACK while nomination is held ---

/**
 * Arrange: keep the ICE agent of `pc` from offering an application data path
 * (nomination / consent not reached) until `release`. DTLS handshake records
 * may still use authenticated pairs; application records queue.
 */
export function holdApplicationPath(pc: RTCPeerConnection) {
  const ice = pc.iceTransports[0].connection as Connection & {
    canSendApplicationData(): boolean;
  };
  const original = ice.canSendApplicationData.bind(ice);
  ice.canSendApplicationData = () => false;
  return {
    release: () => {
      ice.canSendApplicationData = original;
    },
  };
}

/** Assert helper: records the SPED transport still holds in its send queue. */
export function queuedSpedSendsOf(transport: RTCDtlsTransport) {
  const sped = (
    transport as unknown as {
      spedTransport?: { pendingEarlySends: unknown[] };
    }
  ).spedTransport;
  return sped?.pendingEarlySends.length ?? 0;
}

/** Assert helper: whether the DTLS association of `transport` completed its handshake. */
export function coreHandshakeComplete(transport: RTCDtlsTransport) {
  return (
    (
      transport as unknown as {
        dtls?: { readiness: { handshakeComplete: boolean } };
      }
    ).dtls?.readiness.handshakeComplete === true
  );
}

// --- RTCDtlsTransport.stop() releasing the SPED transport ---

/**
 * Arrange: a connected SPED (DTLS 1.3) DataChannel session, and spies on the
 * offerer's SPED transport callbacks that its ICE datagram / state
 * subscriptions run. `fireIceEvents` notifies both ICE events with the
 * authenticated pair captured while connected. With `dtlsCloseFails`, the
 * DTLS association's close() throws, so the association never closes the
 * SPED transport itself.
 */
export async function prepareSpedTransportStop({
  dtlsCloseFails = false,
} = {}) {
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  offerer.createDataChannel("stop");
  exchangeIceCandidates(offerer, answerer);
  await exchangeOfferAnswer(offerer, answerer);
  await Promise.all(
    [offerer, answerer].map((pc) =>
      pc.connectionState === "connected"
        ? undefined
        : pc.connectionStateChange.watch((s) => s === "connected"),
    ),
  );
  const transport = offerer.dtlsTransports[0];
  const ice = transport.iceTransport.connection as Connection;
  const pair = ice.nominated!;
  const generation = ice.generation;
  const sped = (
    transport as unknown as {
      spedTransport: {
        close(): Promise<void>;
        flushPendingEarlySends(): void;
        rejectPendingEarlySends(error: Error): void;
      };
    }
  ).spedTransport;
  if (dtlsCloseFails) {
    const dtls = (transport as unknown as { dtls: { close(): void } }).dtls;
    vi.spyOn(dtls, "close").mockImplementation(() => {
      throw new Error("injected DTLS close failure");
    });
  }
  const close = vi.spyOn(sped, "close");
  const listeners = [
    vi.spyOn(sped, "flushPendingEarlySends"),
    vi.spyOn(sped, "rejectPendingEarlySends"),
  ];
  return {
    offerer,
    answerer,
    transport,
    close,
    listeners,
    fireIceEvents: () => {
      connectionDatagramEvent(ice).execute({
        bytes: Buffer.from([0]),
        source: pair.remoteAddr,
        protocol: pair.protocol,
        pair,
        generation,
        authenticated: true,
      });
      ice.stateChanged.execute("failed");
    },
  };
}

// --- RTCDtlsTransport over ICE: Connection.close() runs once per teardown ---

/**
 * Arrange: a connected non-SPED session with the given DTLS version, and
 * counters for each peer's `Connection.close()` calls and the `closed`
 * notifications its `stateChanged` delivers.
 */
export async function prepareIceCloseCounting(version: DtlsVersion) {
  const config = {
    iceServers: [],
    dtls: { protocolVersions: [version] },
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  offerer.createDataChannel("close");
  exchangeIceCandidates(offerer, answerer);
  await exchangeOfferAnswer(offerer, answerer);
  await Promise.all(
    [offerer, answerer].map((pc) =>
      pc.connectionState === "connected"
        ? undefined
        : pc.connectionStateChange.watch((s) => s === "connected"),
    ),
  );
  const counters = [offerer, answerer].map((pc) => {
    const ice = pc.iceTransports[0].connection as Connection;
    const close = vi.spyOn(ice, "close");
    const closedNotifications = { count: 0 };
    ice.stateChanged.subscribe((state) => {
      if (state === "closed") closedNotifications.count++;
    });
    return { close, closedNotifications };
  });
  return {
    offerer,
    answerer,
    counters,
    /** Wait until async DTLS / transport teardown has run. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 500)),
  };
}

// --- SCTP initiator chosen by another rule (older werift peers) ---

/**
 * Arrange: make `pc` start SCTP like an older werift: the ICE controlling
 * side is the SCTP initiator and ignores incoming INIT / COOKIE_ECHO, the
 * controlled side only waits for INIT (no fallback), and in-band stream IDs
 * follow the ICE-role parity, counting up from the bottom. Call before DTLS
 * connects.
 */
export function emulateLegacySctpRole(pc: RTCPeerConnection) {
  const sctpTransport = pc.sctpTransport!;
  const internals = sctpTransport as unknown as {
    dataChannelId?: number;
    dataChannels: Record<number, unknown>;
    allocateLocalStreamId: () => number;
  };
  internals.allocateLocalStreamId = () => {
    let streamId = internals.dataChannelId!;
    while (internals.dataChannels[streamId] !== undefined) streamId += 2;
    return streamId;
  };
  sctpTransport.start = async (remotePort: number) => {
    const association = sctpTransport.prepareForStart();
    const initiator = pc.iceTransports[0].role === "controlling";
    internals.dataChannelId = initiator ? 1 : 0;
    association.isServer = !initiator;
    if (initiator) {
      const dtls = sctpTransport.transport;
      const receive = dtls.dataReceiver;
      dtls.dataReceiver = (data) => {
        const types = parsePacket(data)[3].map((chunk) => chunk.type);
        if (
          types.includes(InitChunk.type) ||
          types.includes(CookieEchoChunk.type)
        ) {
          return;
        }
        receive(data);
      };
    }
    await association.start(remotePort);
  };
}

/**
 * Act helper: open an in-band DataChannel from each side at the same moment
 * and wait until each side received the other's channel and both are open.
 * Returns the [local, remote] pair of each direction.
 */
export async function openChannelsFromBothSides(
  offerer: { createDataChannel(label: string): any; onDataChannel: any },
  answerer: { createDataChannel(label: string): any; onDataChannel: any },
  timeoutMs = 5_000,
) {
  const seenByOfferer: any[] = [];
  const seenByAnswerer: any[] = [];
  offerer.onDataChannel.subscribe((c: any) => seenByOfferer.push(c));
  answerer.onDataChannel.subscribe((c: any) => seenByAnswerer.push(c));
  const fromOfferer = offerer.createDataChannel("from-offerer");
  const fromAnswerer = answerer.createDataChannel("from-answerer");
  const deadline = Date.now() + timeoutMs;
  while (
    !(
      seenByAnswerer.length > 0 &&
      seenByOfferer.length > 0 &&
      [fromOfferer, fromAnswerer, seenByAnswerer[0], seenByOfferer[0]].every(
        (c) => c.readyState === "open",
      )
    )
  ) {
    if (Date.now() > deadline) {
      throw new Error(
        `channels from both sides did not open: ${JSON.stringify({
          offerer: [fromOfferer.id, seenByOfferer.map((c) => [c.label, c.id])],
          answerer: [
            fromAnswerer.id,
            seenByAnswerer.map((c) => [c.label, c.id]),
          ],
        })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [
    [fromOfferer, seenByAnswerer[0]],
    [fromAnswerer, seenByOfferer[0]],
  ] as const;
}

/**
 * Arrange: connect a current werift peer with an emulated older one
 * (`legacy`), the answerer taking `answererRole` as DTLS role. The offerer
 * is ICE controlling, so `answererRole: "server"` puts the ICE and DTLS
 * roles out of line. Resolves once both DataChannel ends are open.
 */
export async function connectWithLegacySctpPeer({
  legacy,
  answererRole,
}: {
  legacy: "offerer" | "answerer";
  answererRole: "client" | "server";
}) {
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  const offererChannel = offerer.createDataChannel("legacy-role");
  const answererChannel = new Promise<RTCDataChannel>((resolve) => {
    answerer.ondatachannel = ({ channel }) => resolve(channel);
  });
  exchangeIceCandidates(offerer, answerer);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  emulateLegacySctpRole(legacy === "offerer" ? offerer : answerer);
  answerer.dtlsTransports[0].role = answererRole;
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  const startedAt = Date.now();
  const remote = await answererChannel;
  await Promise.all(
    [offererChannel, remote].map((channel) =>
      channel.readyState === "open"
        ? undefined
        : new Promise<void>((resolve) => {
            channel.onopen = () => resolve();
          }),
    ),
  );
  return {
    offerer,
    answerer,
    offererChannel,
    answererChannel: remote,
    openedAfterMs: Date.now() - startedAt,
  };
}

// --- Early server outbound opt-in boundary at the DataChannel level ---

type ReadinessSnapshot = { writeReady: boolean; peerAuthenticated: boolean };
const readinessOf = (transport: RTCDtlsTransport) =>
  ({
    ...(transport as unknown as { readiness: ReadinessSnapshot }).readiness,
  }) as ReadinessSnapshot;

/**
 * Arrange: SPED / DTLS 1.3 peers whose offerer is the DTLS server and owns a
 * DataChannel. The server's peer authentication is held (it stays between
 * `writeReady` and fingerprint authentication) and every application record
 * it hands to DTLS is recorded with the readiness at that moment.
 */
export async function prepareHeldServerDataChannel(
  allowEarlyServerData: boolean,
) {
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
    warp: { allowEarlyServerData },
  };
  const server = new RTCPeerConnection(config);
  const client = new RTCPeerConnection(config);
  const serverChannel = server.createDataChannel("early-boundary");
  const clientChannel = new Promise<RTCDataChannel>((resolve) => {
    client.ondatachannel = ({ channel }) => resolve(channel);
  });
  let clientChannelOpened = false;
  void clientChannel.then(() => {
    clientChannelOpened = true;
  });
  exchangeIceCandidates(server, client);
  await server.setLocalDescription(await server.createOffer());
  await client.setRemoteDescription(server.localDescription!);
  await client.setLocalDescription(await client.createAnswer());
  const transport = server.dtlsTransports[0];
  const { release } = holdPeerAuthentication(transport);
  const sends: ReadinessSnapshot[] = [];
  const heldStart = transport.start.bind(transport);
  transport.start = async () => {
    const started = heldStart();
    while (!transport.dtls) await nextTurn();
    const dtls = transport.dtls;
    const send = dtls.send.bind(dtls);
    dtls.send = async (...args: Parameters<typeof dtls.send>) => {
      sends.push(readinessOf(transport));
      return send(...args);
    };
    return started;
  };
  return {
    server,
    client,
    transport,
    serverChannel,
    clientChannel,
    sends,
    release,
    clientChannelOpened: () => clientChannelOpened,
    readiness: () => readinessOf(transport),
    /** Act helper: apply the answer and wait until the server is write-ready. */
    applyAnswerUntilWriteReady: async () => {
      void server.setRemoteDescription(client.localDescription!);
      const deadline = Date.now() + 10_000;
      while (!readinessOf(transport).writeReady) {
        if (Date.now() > deadline) throw new Error("server not write-ready");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

// --- Connection matrix: setup role × Full/Lite × SPED × DTLS versions ---

export type ConnectionMatrixCase = {
  /** DTLS role the answerer takes: "client" = setup:active, "server" = setup:passive. */
  answererRole: "client" | "server";
  /** "full-lite": the answerer is an ICE-lite agent. */
  ice: "full-full" | "full-lite";
  sped: boolean;
  protocolVersions: DtlsVersion[];
};

/** Arrange: every combination of {@link ConnectionMatrixCase}. */
export const connectionMatrixCases = (): (ConnectionMatrixCase & {
  name: string;
})[] =>
  (["client", "server"] as const).flatMap((answererRole) =>
    (["full-full", "full-lite"] as const).flatMap((ice) =>
      [false, true].flatMap((sped) =>
        [[DtlsVersion.V1_3], [DtlsVersion.V1_3, DtlsVersion.V1_2]].map(
          (protocolVersions) => ({
            name: `setup:${answererRole === "client" ? "active" : "passive"} ${ice} sped:${sped} [${protocolVersions.join(",")}]`,
            answererRole,
            ice,
            sped,
            protocolVersions,
          }),
        ),
      ),
    ),
  );

const waitOpen = (channel: RTCDataChannel) =>
  channel.readyState === "open"
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        channel.onopen = () => resolve();
        channel.onerror = ({ error }) => reject(error);
      });

/**
 * Arrange: two real RTCPeerConnections connected for one matrix case, with
 * an in-band DataChannel opened from each side.
 */
export async function connectMatrixCase({
  answererRole,
  ice,
  sped,
  protocolVersions,
}: ConnectionMatrixCase) {
  const config = {
    iceServers: [],
    sped,
    dtls: { protocolVersions },
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection({
    ...config,
    iceLite: ice === "full-lite",
  });
  const offererChannel = offerer.createDataChannel("from-offerer");
  const received = (pc: RTCPeerConnection) => {
    const channels: RTCDataChannel[] = [];
    pc.onDataChannel.subscribe((channel) => channels.push(channel));
    return channels;
  };
  const receivedByAnswerer = received(answerer);
  const receivedByOfferer = received(offerer);
  exchangeIceCandidates(offerer, answerer);
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(offerer.localDescription!);
  answerer.dtlsTransports[0].role = answererRole;
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(answerer.localDescription!);
  await waitOpen(offererChannel);
  const answererChannel = answerer.createDataChannel("from-answerer");
  await waitOpen(answererChannel);
  const deadline = Date.now() + 10_000;
  while (receivedByAnswerer.length < 1 || receivedByOfferer.length < 1) {
    if (Date.now() > deadline) throw new Error("remote DataChannel missing");
    await new Promise((r) => setTimeout(r, 10));
  }
  await Promise.all(
    [receivedByAnswerer[0], receivedByOfferer[0]].map(waitOpen),
  );
  return {
    offerer,
    answerer,
    /** [local, remote] pairs: offerer → answerer, answerer → offerer. */
    channels: [
      [offererChannel, receivedByAnswerer[0]],
      [answererChannel, receivedByOfferer[0]],
    ] as const,
  };
}

/** Act helper: send `messages` in order and collect what the remote end receives. */
export async function sendInOrder(
  local: RTCDataChannel,
  remote: RTCDataChannel,
  messages: (string | Buffer)[],
) {
  const arrived = collectMessages(remote, messages.length);
  for (const message of messages) local.send(message);
  return arrived;
}

// --- Interop with a released (older) werift ---

/** Default released werift for the legacy interop test (SCTP initiator by ICE role). */
export const LEGACY_WERIFT_DEFAULT_VERSION = "0.26.0";

/**
 * Arrange: locate a released werift package directory.
 * - `WERIFT_LEGACY_RELEASE`: path to an installed `werift` package directory.
 * - `WERIFT_LEGACY_RELEASE_AUTO_INSTALL=1`: install
 *   `werift@${WERIFT_LEGACY_RELEASE_VERSION ?? LEGACY_WERIFT_DEFAULT_VERSION}`
 *   with `--ignore-scripts` into a temporary directory.
 * Returns undefined when neither is set.
 */
export function resolveLegacyWeriftRelease(env = process.env) {
  if (env.WERIFT_LEGACY_RELEASE) {
    return { dir: resolvePath(env.WERIFT_LEGACY_RELEASE), cleanup: () => {} };
  }
  if (env.WERIFT_LEGACY_RELEASE_AUTO_INSTALL !== "1") return undefined;
  const version =
    env.WERIFT_LEGACY_RELEASE_VERSION ?? LEGACY_WERIFT_DEFAULT_VERSION;
  const prefix = mkdtempSync(joinPath(tmpdir(), "werift-legacy-"));
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      `werift@${version}`,
    ],
    { stdio: "inherit" },
  );
  return {
    dir: joinPath(prefix, "node_modules", "werift"),
    /** Remove the temporary install. */
    cleanup: () => rmSync(prefix, { recursive: true, force: true }),
  };
}

type AnyPeerConnection = {
  createDataChannel(label: string): any;
  createOffer(): Promise<any>;
  createAnswer(): Promise<any>;
  setLocalDescription(description: any): Promise<any>;
  setRemoteDescription(description: any): Promise<any>;
  addIceCandidate(candidate: any): Promise<void>;
  onIceCandidate: { subscribe(fn: (candidate: any) => void): unknown };
  onDataChannel: { subscribe(fn: (channel: any) => void): unknown };
  localDescription: { type: string; sdp: string } | null;
  dtlsTransports: { role: string }[];
  close(): Promise<void>;
};

/**
 * Arrange: connect an offerer and an answerer that may come from different
 * werift builds, exchanging only plain SDP / candidate JSON. The answerer
 * takes `answererRole` as DTLS role; the offerer opens the DataChannel.
 * Resolves with both ends once they are open (rejects after `timeoutMs`).
 */
export async function connectAcrossBuilds({
  offerer,
  answerer,
  answererRole,
  timeoutMs = 15_000,
}: {
  offerer: AnyPeerConnection;
  answerer: AnyPeerConnection;
  answererRole: "client" | "server";
  timeoutMs?: number;
}) {
  for (const [local, remote] of [
    [offerer, answerer],
    [answerer, offerer],
  ] as const) {
    local.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      remote
        .addIceCandidate(
          typeof candidate.toJSON === "function"
            ? candidate.toJSON()
            : candidate,
        )
        .catch(() => {});
    });
  }
  const offererChannel = offerer.createDataChannel("cross-build");
  const answererChannel = new Promise<any>((resolve) => {
    answerer.onDataChannel.subscribe(resolve);
  });
  const plain = (pc: AnyPeerConnection) => ({
    type: pc.localDescription!.type,
    sdp: pc.localDescription!.sdp,
  });
  await offerer.setLocalDescription(await offerer.createOffer());
  await answerer.setRemoteDescription(plain(offerer));
  answerer.dtlsTransports[0].role = answererRole;
  await answerer.setLocalDescription(await answerer.createAnswer());
  await offerer.setRemoteDescription(plain(answerer));
  const startedAt = Date.now();
  const opened = (async () => {
    const remote = await answererChannel;
    await Promise.all(
      [offererChannel, remote].map((channel) =>
        channel.readyState === "open"
          ? undefined
          : new Promise<void>((resolve) => {
              channel.onopen = () => resolve();
            }),
      ),
    );
    return remote;
  })();
  const remote = await Promise.race([
    opened,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("DataChannel did not open")),
        timeoutMs,
      ),
    ),
  ]);
  return {
    offererChannel,
    answererChannel: remote,
    openedAfterMs: Date.now() - startedAt,
  };
}

// --- SPED over TCP with a delayed nomination ---

/**
 * Arrange: the four ways a released werift (`legacy`) can meet the current
 * one: as offerer or answerer, with the answerer taking DTLS client
 * (setup:active) or server (setup:passive). The offerer is ICE controlling,
 * so `answererRole: "server"` puts the ICE and DTLS roles out of line.
 */
export const legacyRoleCombos = () =>
  (["offerer", "answerer"] as const).flatMap((legacy) =>
    (["client", "server"] as const).map((answererRole) => ({
      name: `旧 ${legacy} × answerer DTLS ${answererRole}`,
      legacy,
      answererRole,
    })),
  );

/** Arrange: candidate pairs over ICE-TCP only (both builds accept these options). */
export const iceTcpOnlyConfig = () => ({
  iceUseTcp: true,
  iceUseIpv6: false,
  iceFilterCandidatePair: (pair: {
    localCandidate: { transport: string };
    remoteCandidate: { transport: string };
  }) =>
    pair.localCandidate.transport.toLowerCase() === "tcp" &&
    pair.remoteCandidate.transport.toLowerCase() === "tcp",
});

/** Act helper: send one text message each way and return what arrived. */
export async function sendBothWays(
  offererChannel: { send(m: string): void; onMessage: any },
  answererChannel: { send(m: string): void; onMessage: any },
) {
  const received = (channel: { onMessage: any }) =>
    new Promise<string>((resolve) => {
      channel.onMessage.subscribe((message: string | Buffer) =>
        resolve(message.toString()),
      );
    });
  const toAnswerer = received(answererChannel);
  const toOfferer = received(offererChannel);
  offererChannel.send("from-offerer");
  answererChannel.send("from-answerer");
  return Promise.all([toAnswerer, toOfferer]);
}

/**
 * Arrange: delay every ICE-TCP request that carries USE-CANDIDATE (regular
 * nomination) by `delayMs`; connectivity checks are untouched. Call
 * `restore()` afterwards.
 */
export function delayTcpNomination(delayMs: number) {
  const base = Object.getPrototypeOf(TcpActiveProtocol.prototype) as {
    request: (message: Message, ...args: unknown[]) => Promise<unknown>;
  };
  const request = base.request;
  base.request = async function (this: unknown, message, ...args) {
    if (message.attributesKeys.includes("USE-CANDIDATE")) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return request.call(this, message, ...args);
  };
  return {
    restore: () => {
      base.request = request;
    },
  };
}

/**
 * Arrange: SPED / DTLS 1.3 peers that connect only over ICE-TCP on
 * 127.0.0.1 (early outbound disabled), each with a negotiated DataChannel.
 */
export function createTcpLoopbackSpedPeers() {
  const config = {
    iceServers: [],
    iceUseIpv6: false,
    iceAdditionalHostAddresses: ["127.0.0.1"],
    iceUseTcp: true,
    iceFilterCandidatePair: (pair: {
      localCandidate: Candidate;
      remoteCandidate: Candidate;
    }) =>
      pair.localCandidate.transport.toLowerCase() === "tcp" &&
      pair.remoteCandidate.transport.toLowerCase() === "tcp" &&
      pair.localCandidate.host === "127.0.0.1" &&
      pair.remoteCandidate.host === "127.0.0.1",
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
  };
  const peers = [new RTCPeerConnection(config), new RTCPeerConnection(config)];
  const channels = peers.map((pc) =>
    pc.createDataChannel("tcp", { negotiated: true, id: 0 }),
  );
  return { peers, channels };
}

// --- SPED: ICE restart to another 5-tuple while nomination is delayed ---

/**
 * Arrange: connected SPED / DTLS 1.3 peers whose candidates are 127.0.0.1
 * and ::1, with a negotiated DataChannel each. Pairs of one address family
 * only are allowed: IPv4 first; `restartOntoIpv6(holdMs)` allows only IPv6,
 * restarts ICE (offerer) and delays the controlling side's handling of every
 * USE-CANDIDATE response by `holdMs`, so the controlled side nominates the
 * new 5-tuple first while the controlling side has none yet. With
 * `{ retainIpv4: true }` the IPv4 pairs stay listed after the restart but
 * the IPv4 path is lost (requests to 127.0.0.1 fail), so the old 5-tuple
 * remains a current, unauthenticated candidate. `restore()` removes the
 * delay and the path loss.
 */
export async function prepareMigratingSpedPeers() {
  let family: "v4" | "v6" | "both" = "v4";
  let holdMs = 0;
  let ipv4Lost = false;
  const originalRequest = StunProtocol.prototype.request;
  StunProtocol.prototype.request = async function (
    this: StunProtocol,
    message: Message,
    ...args: unknown[]
  ) {
    const destination = args[0] as [string, number] | undefined;
    if (ipv4Lost && destination?.[0] === "127.0.0.1") {
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      throw new Error("simulated IPv4 path loss");
    }
    const result = await (
      originalRequest as (...a: unknown[]) => Promise<unknown>
    ).call(this, message, ...args);
    if (holdMs > 0 && message.attributesKeys.includes("USE-CANDIDATE")) {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
    return result;
  } as typeof originalRequest;
  const host = () => (family === "v4" ? "127.0.0.1" : "::1");
  const config = {
    iceServers: [],
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
    iceUseIpv4: true,
    iceUseIpv6: true,
    iceInterfaceAddresses: { udp4: "127.0.0.1", udp6: "::1" },
    iceFilterCandidatePair: (pair: {
      localCandidate: Candidate;
      remoteCandidate: Candidate;
    }) =>
      family === "both"
        ? pair.localCandidate.host === pair.remoteCandidate.host
        : pair.localCandidate.host === host() &&
          pair.remoteCandidate.host === host(),
  };
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);
  const channels = [offerer, answerer].map((pc) =>
    pc.createDataChannel("migration", { negotiated: true, id: 0 }),
  );
  const exchange = async () => {
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription!);
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);
  };
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 12_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await exchange();
  await until(
    () => channels.every((c) => c.readyState === "open"),
    "initial DataChannel",
  );
  const iceOf = (pc: RTCPeerConnection) =>
    pc.iceTransports[0].connection as Connection;
  return {
    offerer,
    answerer,
    channels,
    iceOf,
    until,
    restartOntoIpv6: async (
      delayMs: number,
      { retainIpv4 = false }: { retainIpv4?: boolean } = {},
    ) => {
      family = retainIpv4 ? "both" : "v6";
      ipv4Lost = retainIpv4;
      holdMs = delayMs;
      offerer.restartIce();
      await exchange();
    },
    restore: () => {
      ipv4Lost = false;
      StunProtocol.prototype.request = originalRequest;
    },
  };
}
