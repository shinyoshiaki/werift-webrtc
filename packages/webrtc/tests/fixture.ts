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
  type RtcpSrPacket,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  defaultPeerConfig,
} from "../src";
import { RTCRtpSender } from "../src/media/rtpSender";
import type { SenderBandwidthEstimator } from "../src/media/sender/senderBWE";

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

export function createVideoCodec(payloadType = 96) {
  return new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
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
  /** send codec (default: 48 kHz opus) */
  codec?: RTCRtpCodecParameters;
}) {
  const kind = options?.kind ?? "audio";
  const track = options?.track ?? new MediaStreamTrack({ kind, remote: true });
  const dtls = createDtlsTransport();
  dtls.state = "connected";
  const sender = new RTCRtpSender(track);
  sender.setDtlsTransport(dtls);

  const codecs = [options?.codec ?? createAudioCodec()];
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

/**
 * Replace `performance.now()` with a manually advanced monotonic clock so
 * RTP send times and SR generation times are deterministic.
 * Call `restore()` (or `vi.restoreAllMocks()`) after the test.
 */
export function mockMonotonicClock(startMs = 1000) {
  let nowMs = startMs;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  return {
    get nowMs() {
      return nowMs;
    },
    set(ms: number) {
      nowMs = ms;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

/** Build the RTCP Sender Report the sender would send at `nowMs` (`performance.now()`). */
export function buildSenderReportAt(sender: RTCRtpSender, nowMs: number) {
  return (sender as any).buildSenderReport(nowMs) as RtcpSrPacket;
}

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_UNIX_OFFSET_SEC = 2208988800;

/**
 * RFC 3550 の 64bit NTP timestamp を実装とは独立に組み立てる。
 * 上位32bit=秒、下位32bit=秒の小数部 (x / 2^32)。
 */
export function rfc3550Ntp(epochMs: number) {
  const wholeSec = Math.floor(epochMs / 1000);
  const fractionMs = epochMs - wholeSec * 1000;
  const seconds = BigInt(wholeSec + NTP_UNIX_OFFSET_SEC);
  const fraction = BigInt(Math.floor((fractionMs * 2 ** 32) / 1000));
  return (seconds << 32n) | fraction;
}

/** 2 つの NTP timestamp の差を RFC 3550 の定義に従い ms で返す。 */
export function ntpDiffMs(later: bigint, earlier: bigint) {
  return (Number(later - earlier) / 2 ** 32) * 1000;
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

/** Arrange: `count` packets sent through `estimator` from `firstSeq`, `sentAtMs` apart by `stepMs`. */
export function recordSentPackets(
  estimator: SenderBandwidthEstimator,
  {
    count,
    firstSeq = 0,
    sentAtMs = Date.now(),
    stepMs = 0,
  }: { count: number; firstSeq?: number; sentAtMs?: number; stepMs?: number },
) {
  for (let i = 0; i < count; i++) {
    const at = sentAtMs + i * stepMs;
    estimator.rtpPacketSent({
      wideSeq: (firstSeq + i) & 0xffff,
      size: 1000,
      sendingAtMs: at,
      sentAtMs: at,
    });
  }
}

/** Test-only read: the packets `estimator` keeps for transport-cc feedback. */
export function pendingFeedback(estimator: SenderBandwidthEstimator) {
  return (estimator as unknown as { sentInfos: Map<number, unknown> })
    .sentInfos;
}
