import {
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useSdesRTPStreamId,
} from "../../src";

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
