import { vi } from "vitest";
import { Candidate, type Connection } from "../../../ice/src";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { classes } from "../../../ice/src/stun/const";
import type { Message } from "../../../ice/src/stun/message";
import type { SCTP } from "../../../sctp/src";
import { CookieAckChunk, parsePacket } from "../../../sctp/src/chunk";
import {
  DtlsVersion,
  MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useSdesRTPStreamId,
} from "../../src";
import type { RTCTransportStats } from "../../src/media/stats";
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
