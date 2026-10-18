import { setTimeout } from "timers/promises";

import { vi } from "vitest";
import {
  type Kind,
  MediaStreamTrack,
  RTCDtlsTransport,
  RTCIceGatherer,
  RTCIceTransport,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  type RTCSessionDescription,
  RTP_EXTENSION_URI,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  defaultPeerConfig,
} from "../src";
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
