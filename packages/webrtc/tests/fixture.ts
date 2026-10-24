import { setTimeout } from "timers/promises";

import { vi } from "vitest";
import {
  FullIntraRequest,
  type Kind,
  MediaStreamTrack,
  PictureLossIndication,
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpTransceiver,
  type RTCSessionDescription,
  RTP_EXTENSION_URI,
  RtcpPayloadSpecificFeedback,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  defaultPeerConfig,
} from "../src";
import { RTCRtpCodingParameters } from "../src/media/parameters";
import { type KeyFrameRequestRouting, RtpRouter } from "../src/media/router";
import { RTCRtpReceiver } from "../src/media/rtpReceiver";
import { RTCRtpSender } from "../src/media/rtpSender";

export const createRtpPacket = (
  sequenceNumber = 0,
  timestamp = 0,
  payload: Buffer = Buffer.from([]),
) => {
  const header = new RtpHeader({
    sequenceNumber,
    timestamp,
    payloadType: 96,
    payloadOffset: 12,
    extension: true,
    marker: false,
    padding: false,
  });
  const rtp = new RtpPacket(header, payload);
  return rtp;
};

export const createDtlsTransport = () => {
  const dtls = new RTCDtlsTransport(
    defaultPeerConfig,
    new RTCIceTransport(new RTCIceGatherer()),
  );
  return dtls;
};

export function createAudioCodec(payloadType = 96) {
  return new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48000,
    payloadType,
  });
}

export function createRtxCodec(payloadType = 97, apt = 96) {
  return new RTCRtpCodecParameters({
    mimeType: "audio/rtx",
    clockRate: 48000,
    payloadType,
    parameters: codecParametersToString({ apt }),
  });
}

export function createConnectedRtpSender(options?: {
  kind?: Kind;
  track?: MediaStreamTrack;
  rtx?: boolean;
  twcc?: boolean;
  cname?: string;
}) {
  const kind = options?.kind ?? "audio";
  const track = options?.track ?? new MediaStreamTrack({ kind, remote: true });
  const dtls = createDtlsTransport();
  dtls.state = "connected";
  const sender = new RTCRtpSender(track);
  sender.setDtlsTransport(dtls);

  const codecs = [createAudioCodec()];
  if (options?.rtx) {
    codecs.push(createRtxCodec());
  }
  const headerExtensions = options?.twcc
    ? [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ]
    : [];

  sender.prepareSend({
    codecs,
    headerExtensions,
    rtcp: options?.cname ? { cname: options.cname, mux: false } : undefined,
  });

  const sendRtp = vi.spyOn(dtls, "sendRtp").mockResolvedValue(12);
  const sendRtcp = vi
    .spyOn(dtls, "sendRtcp")
    .mockResolvedValue(undefined as never);

  return { sender, track, dtls, sendRtp, sendRtcp };
}

export type ConnectedRtpSenderSetup = ReturnType<
  typeof createConnectedRtpSender
>;

export function sentRtpHeaders(sendRtp: ConnectedRtpSenderSetup["sendRtp"]) {
  return sendRtp.mock.calls.map(([, header]) => header);
}

export async function generateOffer() {
  const pc = new RTCPeerConnection();
  const offer = await pc.createOffer();
  pc.close();
  return offer;
}

export async function generateAnswer(offer: RTCSessionDescription) {
  const pc = new RTCPeerConnection();
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  pc.close();
  return answer;
}

export async function dtlsTransportPair() {
  const [transport1, transport2] = await iceTransportPair();
  await setTimeout(100);
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;

  await RTCDtlsTransport.SetupCertificate();

  const session1 = new RTCDtlsTransport(defaultPeerConfig, transport1);

  const session2 = new RTCDtlsTransport(defaultPeerConfig, transport2);

  session1.setRemoteParams(session2.localParameters);
  session2.setRemoteParams(session1.localParameters);
  await Promise.all([session1.start(), session2.start()]);

  if (session1.role === "client") {
    return [session1, session2];
  } else {
    return [session2, session1];
  }
}

export const iceTransportPair = async () => {
  const gatherer1 = new RTCIceGatherer();
  const transport1 = new RTCIceTransport(gatherer1);
  transport1.connection.iceControlling = true;
  const gatherer2 = new RTCIceGatherer();
  const transport2 = new RTCIceTransport(gatherer2);
  transport2.connection.iceControlling = false;

  expect(transport1.state).toBe("new");
  expect(transport2.state).toBe("new");

  await Promise.all([gatherer1.gather(), gatherer2.gather()]);

  gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
  gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);
  expect(transport1.state).toBe("completed");
  expect(transport2.state).toBe("completed");

  transport1.setRemoteParams(gatherer2.localParameters);
  transport2.setRemoteParams(gatherer1.localParameters);
  await Promise.all([transport1.start(), transport2.start()]);

  return [transport1, transport2];
};

/** router に受信 stream R (sendrecv 相当) を SSRC で登録する。 */
function registerRemoteVideoReceiver(router: RtpRouter) {
  const receiverTransceiver = new RTCRtpTransceiver(
    "video",
    createDtlsTransport(),
    new RTCRtpReceiver(defaultPeerConfig, "video", 0),
    new RTCRtpSender("video"),
    "recvonly",
  );
  const remoteSsrc = 0x0abc0001;
  router.registerRtpReceiverBySsrc(receiverTransceiver, {
    encodings: [
      new RTCRtpCodingParameters({ ssrc: remoteSsrc, payloadType: 96 }),
    ],
    codecs: [],
    headerExtensions: [],
  });
  return { receiver: receiverTransceiver.receiver, remoteSsrc };
}

/**
 * router に送信 stream A / B / C と受信 stream R (sendrecv 相当) を登録する。
 * RTCP feedback の配送先を検証するための Arrange。
 */
export function createRtcpFeedbackRouter() {
  const router = new RtpRouter();
  const createSender = () => {
    const sender = new RTCRtpSender("video");
    router.registerRtpSender(sender);
    return sender;
  };
  const senderA = createSender();
  const senderB = createSender();
  const senderC = createSender();
  const { receiver, remoteSsrc } = registerRemoteVideoReceiver(router);

  const rtcpSpies = {
    senderA: vi.spyOn(senderA, "handleRtcpPacket"),
    senderB: vi.spyOn(senderB, "handleRtcpPacket"),
    senderC: vi.spyOn(senderC, "handleRtcpPacket"),
    receiver: vi.spyOn(receiver, "handleRtcpPacket"),
  };

  return { router, senderA, senderB, senderC, receiver, remoteSsrc, rtcpSpies };
}

/**
 * video sender 1 本と audio sender 1 本、受信 stream R を登録した router。
 * target SSRC が未登録の keyframe request の扱い (KeyFrameRequestRouting) を検証する Arrange。
 */
export function createSingleVideoSenderRouter(
  keyFrameRequestRouting: KeyFrameRequestRouting = "compatible",
) {
  const router = new RtpRouter();
  router.keyFrameRequestRouting = keyFrameRequestRouting;
  const video = new RTCRtpSender("video");
  const audio = new RTCRtpSender("audio");
  router.registerRtpSender(video);
  router.registerRtpSender(audio);
  const { receiver, remoteSsrc } = registerRemoteVideoReceiver(router);

  const rtcpSpies = {
    video: vi.spyOn(video, "handleRtcpPacket"),
    audio: vi.spyOn(audio, "handleRtcpPacket"),
    receiver: vi.spyOn(receiver, "handleRtcpPacket"),
  };

  return { router, video, audio, receiver, remoteSsrc, rtcpSpies };
}

export function createPliPacket(props: {
  senderSsrc: number;
  mediaSsrc: number;
}) {
  return new RtcpPayloadSpecificFeedback({
    feedback: new PictureLossIndication(props),
  });
}

/** transceiver の transport から RTCP をそのまま送る (sendRtcpPLI の codec 判定を通さない)。 */
export function sendRawRtcp(
  transceiver: RTCRtpTransceiver,
  packet: RtcpPayloadSpecificFeedback,
) {
  return transceiver.dtlsTransport!.sendRtcp([packet]);
}

export function createFirPacket(props: {
  senderSsrc: number;
  mediaSsrc?: number;
  fir: { ssrc: number; sequenceNumber: number }[];
}) {
  return new RtcpPayloadSpecificFeedback({
    feedback: new FullIntraRequest({ mediaSsrc: 0, ...props }),
  });
}

export async function outboundRtpStats(sender: RTCRtpSender) {
  const report = await sender.getStats();
  return Array.from(report.values()).find(
    (stat) => stat.type === "outbound-rtp",
  ) as { pliCount?: number; firCount?: number };
}

/**
 * werift 同士で sendrecv video を 1 本ずつ接続し、双方が相手の RTP を 1 つ受けた状態にする。
 * 受信側の SSRC と codec が確定するので、PLI を送れる。
 */
export async function createConnectedSendrecvVideoPeers(
  pc1Config?: RTCPeerConnectionConfig,
) {
  const connect = (pc: RTCPeerConnection) => {
    const track = new MediaStreamTrack({ kind: "video" });
    const transceiver = pc.addTransceiver(track, { direction: "sendrecv" });
    const received = new Promise<void>((resolve) =>
      transceiver.onTrack.subscribe((remote) =>
        remote.onReceiveRtp.once(() => resolve()),
      ),
    );
    transceiver.sender.onReady.subscribe(() => {
      const timer = setInterval(() => {
        if (transceiver.sender.stopped) return clearInterval(timer);
        track.writeRtp(new RtpPacket(new RtpHeader(), Buffer.from("rtp")));
      }, 20);
      received.finally(() => setTimeout(100).then(() => clearInterval(timer)));
    });
    return { transceiver, received };
  };
  const pc1 = new RTCPeerConnection(pc1Config);
  const pc2 = new RTCPeerConnection();
  const peer1 = connect(pc1);
  const peer2 = connect(pc2);

  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription!);
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription!);
  await Promise.all([peer1.received, peer2.received]);

  return {
    pc1,
    pc2,
    transceiver1: peer1.transceiver,
    transceiver2: peer2.transceiver,
  };
}
