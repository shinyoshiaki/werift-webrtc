import type { RtpHeader, RtpPacket } from "../../imports/rtp";
import { RTCDtlsTransport } from "../../transport/dtls";

/** Bytes a packet occupies in the send FIFO (before RED / padding). */
export function estimateOutgoingBytes(rtp: Buffer | RtpPacket): number {
  if (Buffer.isBuffer(rtp)) return rtp.length;
  return rtp.header.serializeSize + rtp.payload.length;
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
