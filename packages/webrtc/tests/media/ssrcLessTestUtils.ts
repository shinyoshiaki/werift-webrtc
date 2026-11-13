import {
  codecParametersToString,
  defaultPeerConfig,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpTransceiver,
  RTP_EXTENSION_URI,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import type { RTCDtlsTransport } from "../../src/transport/dtls";
import type { Kind } from "../../src/types/domain";
import { createDtlsTransport } from "../fixture";

/**
 * Shared Arrange of the RTP routing fallback for remote m-lines without
 * `a=ssrc` (#356, RFC 9143 section 9.2): a router whose transceivers are the
 * ones created here, as the TransceiverManager wires it.
 */

/** Header extension ID of `sdes:mid` in these fixtures. */
export const ssrcLessMidExtensionId = 1;

export const opus = (payloadType = 111) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    payloadType,
  });

export const pcmu = () =>
  new RTCRtpCodecParameters({
    mimeType: "audio/PCMU",
    clockRate: 8000,
    payloadType: 0,
  });

export const vp8 = (payloadType = 96) =>
  new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    payloadType,
  });

export const rtxOf = (payloadType: number, apt: number) =>
  new RTCRtpCodecParameters({
    mimeType: "video/rtx",
    clockRate: 90000,
    payloadType,
    parameters: codecParametersToString({ apt }),
  });

export function createSsrcLessRouter() {
  const router = new RtpRouter();
  const transceivers: RTCRtpTransceiver[] = [];
  router.transceivers = () => transceivers;
  const dtls = createDtlsTransport();

  /**
   * A receiving transceiver whose remote m-line sends without `a=ssrc` (as
   * setRemoteRTP() applies it): codecs prepared, no SSRC encoding, `ontrack`
   * fired. `ssrc` gives the m-line an SDP SSRC instead.
   */
  const addReceiver = (
    options: {
      kind?: Kind;
      mid?: string;
      codecs?: RTCRtpCodecParameters[];
      transport?: RTCDtlsTransport;
      ssrc?: number;
    } = {},
  ) => {
    const kind = options.kind ?? "audio";
    const codecs = options.codecs ?? [opus()];
    const transceiver = new RTCRtpTransceiver(
      kind,
      options.transport ?? dtls,
      new RTCRtpReceiver(defaultPeerConfig, kind, 1000 + transceivers.length),
      new RTCRtpSender(kind),
      "recvonly",
    );
    transceiver.mid = options.mid ?? String(transceivers.length);
    const params = {
      muxId: transceiver.mid,
      codecs,
      headerExtensions: [
        { id: ssrcLessMidExtensionId, uri: RTP_EXTENSION_URI.sdesMid },
      ],
      encodings: codecs.map(
        (c) =>
          new RTCRtpCodingParameters({
            ssrc: options.ssrc as number,
            payloadType: c.payloadType,
          }),
      ),
    };
    transceiver.receiver.prepareReceive(params);
    router.registerRtpReceiverBySsrc(transceiver, params);
    transceiver.firedReceiving = true;
    transceivers.push(transceiver);
    return transceiver;
  };

  return { router, dtls, transceivers, addReceiver };
}

export function ssrcLessPacket(options: {
  ssrc: number;
  payloadType: number;
  sequenceNumber?: number;
  mid?: string;
  payload?: Buffer;
}) {
  return new RtpPacket(
    new RtpHeader({
      ssrc: options.ssrc,
      payloadType: options.payloadType,
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: (options.sequenceNumber ?? 1) * 960,
      extensions:
        options.mid === undefined
          ? []
          : [{ id: ssrcLessMidExtensionId, payload: Buffer.from(options.mid) }],
    }),
    options.payload ?? Buffer.from(`payload-${options.sequenceNumber ?? 1}`),
  );
}

/** The payloads `transceiver`'s announced track (`receiver.track`) received. */
export function collectTrackPayloads(transceiver: RTCRtpTransceiver) {
  const payloads: string[] = [];
  transceiver.receiver.track.onReceiveRtp.subscribe((rtp) => {
    payloads.push(rtp.payload.toString());
  });
  return payloads;
}
