/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-var */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { RtcpPacket, RtpHeader, RtpPacket } from "../../../rtp/src";
import { NackHandler } from "../../src/media/receiver/nack";

describe("media/nack", () => {
  test("16bit rotate", () => {
    const nack = new NackHandler(new MockRTCRtpReceiver() as any);
    var packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 65535, ssrc: 1 }),
      Buffer.from("")
    );
    nack.addPacket(packet);

    var packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 3, ssrc: 1 }),
      Buffer.from("")
    );
    nack.addPacket(packet);

    expect(nack.lostSeqNumbers).toEqual([0, 1, 2]);
  });
});

class MockRTCRtpReceiver {
  rtcpSsrc: number = 0;
  dtlsTransport = {
    sendRtcp: (packets: RtcpPacket[]) => {
      const payload = Buffer.concat(
        packets.map((packet) => packet.serialize())
      );
    },
  };
  sendRtcpPLI = () => {};
}
