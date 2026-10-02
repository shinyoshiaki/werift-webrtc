import { vi } from "vitest";
import type { Connection } from "../../../ice/src";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { classes } from "../../../ice/src/stun/const";
import type { Message } from "../../../ice/src/stun/message";
import { DtlsVersion, type RTCDataChannel, RTCPeerConnection } from "../../src";
import { exchangeIceCandidates } from "../utils";

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
