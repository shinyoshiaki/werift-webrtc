import {
  RTP_EXTENSION_URI,
  serializeAbsSendTime,
  serializeRepairedRtpStreamId,
  serializeSdesMid,
  serializeSdesRTPStreamID,
  serializeTransportWideCC,
} from "./headerExtension";
import type { Extension, RtpHeader } from "./rtp";

/** A negotiated header extension: its id and URI (`a=extmap`). */
export type NegotiatedHeaderExtension = { id: number; uri: string };

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
  negotiated: NegotiatedHeaderExtension[],
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
  negotiated: NegotiatedHeaderExtension[],
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
