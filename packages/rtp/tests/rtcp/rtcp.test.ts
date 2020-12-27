import { load } from "../utils";
import { RtcpPacketConverter } from "../../src/rtcp/rtcp";
import { RtcpSrPacket } from "../../src/rtcp/sr";
import { RtcpRrPacket } from "../../src/rtcp/rr";

describe("rtcp/rtcp", () => {
  test("test_sr", () => {
    const data = load("rtcp_sr.bin");
    const packets = RtcpPacketConverter.deSerialize(data) as RtcpSrPacket[];
    expect(packets.length).toBe(1);

    const packet = packets[0];
    expect(packet.ssrc).toBe(1831097322);
    expect(packet.senderInfo.ntpTimestamp).toBe(BigInt("16016567581311369308"));
    expect(packet.senderInfo.rtpTimestamp).toBe(1722342718);
    expect(packet.senderInfo.packetCount).toBe(269);
    expect(packet.senderInfo.octetCount).toBe(13557);
    expect(packet.reports.length).toBe(1);
    const report = packet.reports[0];
    expect(report.ssrc).toBe(2398654957);
    expect(report.fractionLost).toBe(0);
    expect(report.packetsLost).toBe(0);
    expect(report.highestSequence).toBe(246);
    expect(report.jitter).toBe(127);
    expect(report.lsr).toBe(0);
    expect(report.dlsr).toBe(0);

    expect(data).toEqual(packet.serialize());
  });

  test("test_rr", () => {
    const data = load("rtcp_rr.bin");
    const packets = RtcpPacketConverter.deSerialize(data) as RtcpRrPacket[];
    expect(packets.length).toBe(1);

    const packet = packets[0];
    expect(packet.ssrc).toBe(817267719);
    const report = packet.reports[0];
    expect(report.ssrc).toBe(1200895919);
    expect(report.fractionLost).toBe(0);
    expect(report.packetsLost).toBe(0);
    expect(report.highestSequence).toBe(630);
    expect(report.jitter).toBe(1906);
    expect(report.lsr).toBe(0);
    expect(report.dlsr).toBe(0);

    expect(data).toEqual(packet.serialize());
  });

  test("test_compound", () => {
    const data = Buffer.concat([load("rtcp_sr.bin"), load("rtcp_rr.bin")]);
    const packets = RtcpPacketConverter.deSerialize(data);
    expect(packets.length).toBe(2);
    expect(packets[0].type).toBe(RtcpSrPacket.type);
    expect(packets[1].type).toBe(RtcpRrPacket.type);
  });
});
