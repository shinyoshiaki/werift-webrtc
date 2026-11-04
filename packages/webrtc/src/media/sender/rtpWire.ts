import {
  type Extension,
  RedEncoder,
  RTP_EXTENSION_URI,
  type RtpHeader,
  type RtpPacket,
  serializeAbsSendTime,
  serializeRepairedRtpStreamId,
  serializeSdesMid,
  serializeSdesRTPStreamID,
  serializeTransportWideCC,
} from "../../imports/rtp";
import { RTCDtlsTransport } from "../../transport/dtls";
import type { RTCRtpHeaderExtensionParameters } from "../parameters";

/** Identifiers a sender writes into its own header extensions. */
export type SendStreamIds = {
  mid?: string;
  rtpStreamId?: string;
  repairedRtpStreamId?: string;
};

/**
 * Header extensions of an outgoing packet: the negotiated ones this sender
 * writes (MID, RID, repaired RID, placeholders for TWCC / abs-send-time),
 * then the input packet's other extensions, sorted by id.
 *
 * TWCC and abs-send-time are hop-by-hop: a forwarded packet's values are not
 * kept, so the new transport-wide sequence assigned at send time is not
 * overwritten (see {@link stampHopByHopExtensions}).
 */
export function buildSendHeaderExtensions(
  original: Extension[],
  negotiated: RTCRtpHeaderExtensionParameters[],
  ids: SendStreamIds,
): Extension[] {
  const extensions = negotiated
    .map((extension) => {
      const extPayload = (() => {
        switch (extension.uri) {
          case RTP_EXTENSION_URI.sdesMid:
            if (ids.mid) {
              return serializeSdesMid(ids.mid);
            }
            return;
          case RTP_EXTENSION_URI.sdesRTPStreamID:
            if (ids.rtpStreamId) {
              return serializeSdesRTPStreamID(ids.rtpStreamId);
            }
            return;
          case RTP_EXTENSION_URI.repairedRtpStreamId:
            if (ids.repairedRtpStreamId) {
              return serializeRepairedRtpStreamId(ids.repairedRtpStreamId);
            }
            return;
          case RTP_EXTENSION_URI.transportWideCC:
            return serializeTransportWideCC(0);
          case RTP_EXTENSION_URI.absSendTime:
            return serializeAbsSendTime(0n);
        }
      })();

      if (extPayload) return { id: extension.id, payload: extPayload };
    })
    .filter((v) => v) as Extension[];
  const hopByHopIds = new Set(
    negotiated
      .filter(
        (e) =>
          e.uri === RTP_EXTENSION_URI.transportWideCC ||
          e.uri === RTP_EXTENSION_URI.absSendTime,
      )
      .map((e) => e.id),
  );
  for (const ext of original) {
    if (hopByHopIds.has(ext.id)) continue;
    const exist = extensions.find((v) => v.id === ext.id);
    if (exist) {
      exist.payload = ext.payload;
    } else {
      extensions.push(ext);
    }
  }
  return extensions.sort((a, b) => a.id - b.id);
}

/**
 * Write the send-time values of the hop-by-hop extensions right before the
 * DTLS write: a newly allocated transport-wide sequence (when TWCC is on) and
 * the abs-send-time of `ntpTimestamp`.
 * @returns the extended transport-wide sequence, or undefined without TWCC.
 */
export function stampHopByHopExtensions(
  header: RtpHeader,
  negotiated: RTCRtpHeaderExtensionParameters[],
  {
    twccOn,
    allocateTransportWideSequence,
    ntpTimestamp,
  }: {
    twccOn: boolean;
    allocateTransportWideSequence: () => { wire: number; extended: number };
    ntpTimestamp: bigint;
  },
): number | undefined {
  let packetWideSeq: number | undefined;
  for (const ext of header.extensions) {
    const extension = negotiated.find((e) => e.id === ext.id);
    if (!extension) continue;
    if (extension.uri === RTP_EXTENSION_URI.transportWideCC && twccOn) {
      const allocated = allocateTransportWideSequence();
      packetWideSeq = allocated.extended;
      ext.payload = serializeTransportWideCC(allocated.wire);
    }
    if (extension.uri === RTP_EXTENSION_URI.absSendTime) {
      ext.payload = serializeAbsSendTime(ntpTimestamp);
    }
  }
  return packetWideSeq;
}

/** Bytes a packet occupies in the send FIFO (before RED / padding). */
export function estimateOutgoingBytes(rtp: Buffer | RtpPacket): number {
  if (Buffer.isBuffer(rtp)) return rtp.length;
  return rtp.header.serializeSize + rtp.payload.length;
}

/**
 * RED payload length if `block` were pushed now, without changing `encoder`
 * (the pacer needs the size before the packet is committed).
 */
export function estimateRedPayloadLength(
  encoder: RedEncoder,
  block: Buffer,
  timestamp: number,
  blockPT: number,
): number {
  const clone = new RedEncoder(encoder.distance);
  clone.cacheSize = encoder.cacheSize;
  const src = encoder as unknown as {
    cache: { block: Buffer; timestamp: number; blockPT: number }[];
  };
  (clone as unknown as { cache: typeof src.cache }).cache = [...src.cache];
  clone.push({ block, timestamp, blockPT });
  return clone.build().serialize().length;
}

/**
 * Write one RTP packet. Production uses {@link RTCDtlsTransport.sendRtpWithMeta}
 * for the ICE-enqueue time. Tests that stub {@link RTCDtlsTransport.sendRtp}
 * keep a number (or object) return.
 */
export async function sendDtlsRtp(
  dtls: RTCDtlsTransport,
  payload: Buffer,
  header: RtpHeader,
  fallbackSendingAtMs: number,
): Promise<{ size: number; sendingAtMs: number }> {
  const mocked = dtls.sendRtp !== RTCDtlsTransport.prototype.sendRtp;
  if (!mocked) {
    return dtls.sendRtpWithMeta(payload, header);
  }
  const sent: unknown = await dtls.sendRtp(payload, header);
  if (
    typeof sent === "object" &&
    sent !== null &&
    "size" in sent &&
    typeof (sent as { size: unknown }).size === "number"
  ) {
    const meta = sent as { size: number; sendingAtMs?: number };
    return {
      size: meta.size,
      sendingAtMs: meta.sendingAtMs ?? fallbackSendingAtMs,
    };
  }
  return {
    size: typeof sent === "number" ? sent : 0,
    sendingAtMs: fallbackSendingAtMs,
  };
}
