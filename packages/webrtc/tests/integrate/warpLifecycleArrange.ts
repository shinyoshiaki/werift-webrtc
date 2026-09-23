import { vi } from "vitest";
import type { SCTP } from "../../../sctp/src";
import { CookieAckChunk, parsePacket } from "../../../sctp/src/chunk";
import { DtlsVersion, RTCPeerConnection } from "../../src";
import { exchangeIceCandidates } from "../utils";

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
