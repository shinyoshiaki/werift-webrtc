/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-var */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { RtcpPacket, RtpHeader, RtpPacket } from "../../../rtp/src";
import { Nack } from "../../src/media/nack";

describe("media/nack", () => {
  test("16bit rotate", () => {
    const nack = new Nack(new MockRTCRtpReceiver() as any);
    var packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 65535, ssrc: 1 }),
      Buffer.from("")
    );
    nack.onPacket(packet);

    var packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 3, ssrc: 1 }),
      Buffer.from("")
    );
    nack.onPacket(packet);

    expect(nack.lost).toEqual([0, 1, 2]);
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
