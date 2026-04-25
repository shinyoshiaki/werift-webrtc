import { RTCP_HEADER_SIZE, RtcpHeader } from "../rtcp/header";
import { RtpHeader } from "../rtp/rtp";
import { SrtpAuthenticationError } from "./error";

const minRtpHeaderSize = 12;
const minRtcpPacketSize = 8;

export function parseSrtpRtpHeader(
  packet: Buffer,
  authTagLength: number,
  message = "Failed to authenticate SRTP packet",
) {
  assertAuthenticatedPacketLength(
    packet.length >= minRtpHeaderSize + authTagLength,
    message,
  );

  const header = wrapAuthenticationError(
    () => RtpHeader.deSerialize(packet),
    message,
  );
  const authTagOffset = packet.length - authTagLength;

  assertAuthenticatedPacketLength(
    header.payloadOffset >= minRtpHeaderSize &&
      header.payloadOffset <= authTagOffset,
    message,
  );
  if (header.padding) {
    assertAuthenticatedPacketLength(
      header.paddingSize > 0 &&
        header.paddingSize <= authTagOffset - header.payloadOffset,
      message,
    );
  }

  return header;
}

export function parseSrtcpHeader(
  packet: Buffer,
  authTagLength: number,
  srtcpIndexSize: number,
  message = "Failed to authenticate SRTCP packet",
) {
  assertAuthenticatedPacketLength(
    packet.length >= minRtcpPacketSize + authTagLength + srtcpIndexSize,
    message,
  );

  return wrapAuthenticationError(
    () => RtcpHeader.deSerialize(packet.subarray(0, RTCP_HEADER_SIZE)),
    message,
  );
}

function assertAuthenticatedPacketLength(condition: boolean, message: string) {
  if (!condition) {
    throw new SrtpAuthenticationError(message);
  }
}

function wrapAuthenticationError<T>(parse: () => T, message: string) {
  try {
    return parse();
  } catch {
    throw new SrtpAuthenticationError(message);
  }
}
