import { wrapRtx } from "../../../rtp/src";
import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  defaultPeerConfig,
  type PeerConfig,
} from "../../src";
import type { NackHandler } from "../../src/media/receiver/nack";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { createDtlsTransport } from "../fixture";

export const defaultVideoSsrc = 777;
export const defaultRtxSsrc = 666;

export function createVideoReceiver(
  options: {
    nack?: boolean;
    rtx?: boolean;
    red?: boolean;
    payloadType?: number;
    ssrc?: number;
    kind?: "audio" | "video";
    peerConfig?: PeerConfig;
  } = {},
) {
  const kind = options.kind ?? "video";
  const payloadType = options.payloadType ?? 96;
  const ssrc = options.ssrc ?? defaultVideoSsrc;
  const dtls = createDtlsTransport();
  const receiver = new RTCRtpReceiver(
    options.peerConfig ?? defaultPeerConfig,
    kind,
    1234,
  );
  receiver.setDtlsTransport(dtls);

  const track = new MediaStreamTrack({ kind, remote: true });
  track.ssrc = ssrc;
  receiver.addTrack(track);

  const codecs = [
    new RTCRtpCodecParameters({
      mimeType: kind === "audio" ? "audio/opus" : "video/vp8",
      clockRate: kind === "audio" ? 48000 : 90000,
      payloadType,
      rtcpFeedback: options.nack ? [{ type: "nack" }] : [],
    }),
  ];
  const encodings = [
    new RTCRtpCodingParameters({
      ssrc,
      payloadType,
      rtx: options.rtx ? { ssrc: defaultRtxSsrc } : undefined,
    }),
  ];

  if (options.rtx) {
    codecs.push(
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90000,
        payloadType: 97,
        parameters: codecParametersToString({ apt: payloadType }),
      }),
    );
    encodings.push(
      new RTCRtpCodingParameters({
        ssrc: defaultRtxSsrc,
        payloadType: 97,
      }),
    );
  }

  if (options.red) {
    codecs.unshift(
      new RTCRtpCodecParameters({
        mimeType: "audio/red",
        clockRate: 48000,
        channels: 2,
        payloadType: 111,
      }),
    );
  }

  receiver.prepareReceive({
    codecs,
    encodings,
    headerExtensions: [],
  });

  return { receiver, track, dtls, payloadType, ssrc };
}

export function createMediaRtpPacket(options: {
  sequenceNumber?: number;
  timestamp?: number;
  payloadType?: number;
  ssrc?: number;
  payload?: Buffer;
  marker?: boolean;
}) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: options.timestamp ?? 1,
      payloadType: options.payloadType ?? 96,
      ssrc: options.ssrc ?? defaultVideoSsrc,
      marker: options.marker ?? false,
    }),
    options.payload ?? Buffer.from([1, 2, 3, 4]),
  );
}

export function createPaddingOnlyRtpPacket(options: {
  sequenceNumber?: number;
  timestamp?: number;
  payloadType?: number;
  ssrc?: number;
  paddingSize?: number;
}) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: options.timestamp ?? 1,
      payloadType: options.payloadType ?? 96,
      ssrc: options.ssrc ?? defaultVideoSsrc,
      padding: true,
      paddingSize: options.paddingSize ?? 224,
    }),
    Buffer.alloc(0),
  );
}

export function createRtxRtpPacket(
  media: RtpPacket,
  rtxPt = 97,
  rtxSeq = 0,
  rtxSsrc = defaultRtxSsrc,
) {
  return wrapRtx(media, rtxPt, rtxSeq, rtxSsrc);
}

export function getReceiverNack(receiver: RTCRtpReceiver) {
  return (receiver as unknown as { nack: NackHandler }).nack;
}
