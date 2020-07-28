import { iceTransportPair } from "./dtls.test";
import { sleep } from "../../../src/helper";
import { RTCCertificate } from "../../../src";
import { RTCDtlsTransport } from "../../../src/rtc/transport/dtls";
import { RTCSrtpTransport } from "../../../src/rtc/transport/srtp";
import { load } from "../../utils";
import { RtcpPacketConverter } from "../../../src/vendor/rtp/rtcp/rtcp";

const RTP = load("rtp.bin");
const RTCP = load("rtcp_sr.bin");

describe("rtc/transport/srtp", () => {
  test("test_rtp", async () => {
    const [session1, session2] = await dtlsTransportPair();
    const srtp1 = new RTCSrtpTransport(session1);
    const srtp2 = new RTCSrtpTransport(session2);

    srtp1.sendRtp(RTP);
    const rtp = await srtp2.onSrtp.asPromise();
    expect(rtp.serialize()).toEqual(RTP);

    const packets = RtcpPacketConverter.deSerialize(RTCP);
    srtp1.sendRtcp(packets);
    const rtcp = await srtp2.onSrtcp.asPromise();
    expect(Buffer.concat(rtcp.map((v) => v.serialize()))).toEqual(RTCP);
  });
});

export async function dtlsTransportPair(): Promise<
  [RTCDtlsTransport, RTCDtlsTransport]
> {
  const [transport1, transport2] = await iceTransportPair();
  await sleep(100);
  transport1.connection.iceControlling = true;
  transport2.connection.iceControlling = false;

  const certificate1 = RTCCertificate.unsafe_useDefaultCertificate();
  const session1 = new RTCDtlsTransport(transport1, [certificate1]);

  const certificate2 = RTCCertificate.unsafe_useDefaultCertificate();
  const session2 = new RTCDtlsTransport(transport2, [certificate2]);

  await Promise.all([
    session1.start(session2.getLocalParameters()),
    session2.start(session1.getLocalParameters()),
  ]);

  if (session1.role === "client") {
    return [session1, session2];
  } else {
    return [session2, session1];
  }
}
