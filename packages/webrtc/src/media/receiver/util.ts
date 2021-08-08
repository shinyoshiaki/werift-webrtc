import { bufferReader, bufferWriter } from "../../../../common/src";
import { RtcpSrPacket, RtpHeader } from "../../../../rtp/src";

export const rtpTime2ntpTime = (
  header: RtpHeader,
  sr: RtcpSrPacket,
  clockRate: number
) => {
  const { ntpTimestamp, rtpTimestamp } = sr.senderInfo;

  const elapsed = (rtpTimestamp - header.timestamp) / clockRate;

  const [ntpSec, ntpMsec] = bufferReader(
    bufferWriter([8], [ntpTimestamp]),
    [4, 4]
  );

  return Number(`${ntpSec}.${ntpMsec}`) - elapsed;
};
