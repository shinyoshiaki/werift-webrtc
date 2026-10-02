import { vi } from "vitest";
import { Candidate } from "../../../ice/src";
import type { SCTP } from "../../../sctp/src";
import { CookieAckChunk, parsePacket } from "../../../sctp/src/chunk";
import {
  DtlsVersion,
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { exchangeIceCandidates, exchangeOfferAnswer } from "../utils";

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
