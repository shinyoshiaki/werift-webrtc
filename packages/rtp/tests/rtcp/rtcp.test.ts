import {
  FullIntraRequest,
  PictureLossIndication,
  RtcpHeader,
  RtcpPayloadSpecificFeedback,
} from "../../src";
import { RtcpRrPacket } from "../../src/rtcp/rr";
import { RtcpPacketConverter } from "../../src/rtcp/rtcp";
import { RtcpSrPacket } from "../../src/rtcp/sr";
import { load } from "../utils";

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

  test("compound packet: each packet ends at its declared length", () => {
    // Arrange: RR + SDES + FIR (A 宛 1 エントリ) + PLI (B 宛) の実バイト列
    const data = Buffer.from(
      [
        // RR: v=2, rc=0, len=1, ssrc=0x12345678
        "80c90001",
        "12345678",
        // SDES: sc=1, len=2, chunk ssrc=0x12345678, CNAME "r", END
        "81ca0002",
        "12345678",
        "01017200",
        // FIR: FMT=4, len=4 (2 + 2 * 1), sender=0x12345678, media=0, FCI ssrc=0xaaaaaaaa seq=7
        "84ce0004",
        "12345678",
        "00000000",
        "aaaaaaaa",
        "07000000",
        // PLI: FMT=1, len=2, sender=0x12345678, media=0xbbbbbbbb
        "81ce0002",
        "12345678",
        "bbbbbbbb",
      ].join(""),
      "hex",
    );

    // Act
    const packets = RtcpPacketConverter.deSerialize(data);

    // Assert: 4 パケットに分かれ、FIR の FCI に後続の PLI が混ざらない
    expect(packets.map((p) => p.type)).toEqual([201, 202, 206, 206]);
    const [fir, pli] = (packets.slice(2) as RtcpPayloadSpecificFeedback[]).map(
      (p) => p.feedback,
    );
    expect((fir as FullIntraRequest).fir).toEqual([
      { ssrc: 0xaaaaaaaa, sequenceNumber: 7 },
    ]);
    expect((pli as PictureLossIndication).mediaSsrc).toBe(0xbbbbbbbb);
  });

  test("compound packet: padding is read from the end of its own packet", () => {
    // Arrange: padding 付き RR (末尾 4 バイトが padding) のあとに PLI が続く
    const data = Buffer.from(
      [
        // RR: P=1, rc=0, len=2, ssrc=0x12345678, padding 4 bytes (last octet = 4)
        "a0c90002",
        "12345678",
        "00000004",
        // PLI: FMT=1, len=2, sender=0x12345678, media=0xbbbbbbbb
        "81ce0002",
        "12345678",
        "bbbbbbbb",
      ].join(""),
      "hex",
    );

    // Act
    const packets = RtcpPacketConverter.deSerialize(data);

    // Assert: RR と PLI の両方が復号される (padding 長を後続パケットの末尾から読まない)
    expect(packets.map((p) => p.type)).toEqual([201, 206]);
    expect((packets[0] as RtcpRrPacket).ssrc).toBe(0x12345678);
    expect(
      (
        (packets[1] as RtcpPayloadSpecificFeedback)
          .feedback as PictureLossIndication
      ).mediaSsrc,
    ).toBe(0xbbbbbbbb);
  });

  test("FIR serializes the RFC 5104 header length and round-trips in a compound packet", () => {
    // Arrange: 2 エントリの FIR と PLI
    const fir = new RtcpPayloadSpecificFeedback({
      feedback: new FullIntraRequest({
        senderSsrc: 1,
        mediaSsrc: 0,
        fir: [
          { ssrc: 0xaaaaaaaa, sequenceNumber: 1 },
          { ssrc: 0xcccccccc, sequenceNumber: 2 },
        ],
      }),
    });
    const pli = new RtcpPayloadSpecificFeedback({
      feedback: new PictureLossIndication({
        senderSsrc: 1,
        mediaSsrc: 0xbbbbbbbb,
      }),
    });

    // Act
    const firBytes = fir.serialize();
    const packets = RtcpPacketConverter.deSerialize(
      Buffer.concat([firBytes, pli.serialize()]),
    ) as RtcpPayloadSpecificFeedback[];

    // Assert: header length は 2 + 2 * 2 = 6 で実バイト長と一致し、復号後も 2 エントリのまま
    expect(firBytes.readUInt16BE(2)).toBe(6);
    expect(firBytes.length).toBe((6 + 1) * 4);
    expect((packets[0].feedback as FullIntraRequest).fir).toEqual(
      (fir.feedback as FullIntraRequest).fir,
    );
    expect((packets[1].feedback as PictureLossIndication).mediaSsrc).toBe(
      0xbbbbbbbb,
    );
  });

  test("should fail", () => {
    const rtcp = RtcpHeader.serialize(
      RtcpPayloadSpecificFeedback.type,
      PictureLossIndication.count,
      Buffer.from([0]),
      2,
    );
    const packets = RtcpPacketConverter.deSerialize(rtcp);
    expect(packets.length).toBe(0);
  });
});
