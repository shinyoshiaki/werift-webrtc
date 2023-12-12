import { RtcpHeader, RtcpPacketConverter } from "../../../src";
import { RtcpTransportLayerFeedback } from "../../../src/rtcp/rtpfb";
import {
  PacketChunk,
  PacketStatus,
  RecvDelta,
  RunLengthChunk,
  StatusVectorChunk,
  TransportWideCC,
} from "../../../src/rtcp/rtpfb/twcc";

describe("rtcp/rtpfb/twcc", () => {
  test("RunLength deserialize", () => {
    {
      const res = RunLengthChunk.deSerialize(Buffer.from([0x00, 0xdd]));
      expect(res.type).toBe(PacketChunk.TypeTCCRunLengthChunk);
      expect(res.packetStatus).toBe(PacketStatus.TypeTCCPacketNotReceived);
      expect(res.runLength).toBe(221);
    }
    {
      const res = RunLengthChunk.deSerialize(Buffer.from([0x60, 0x18]));
      expect(res.type).toBe(PacketChunk.TypeTCCRunLengthChunk);
      expect(res.packetStatus).toBe(
        PacketStatus.TypeTCCPacketReceivedWithoutDelta,
      );
      expect(res.runLength).toBe(24);
    }
  });

  test("RunLength serialize", () => {
    {
      const buf = new RunLengthChunk({
        type: PacketChunk.TypeTCCRunLengthChunk,
        packetStatus: PacketStatus.TypeTCCPacketNotReceived,
        runLength: 221,
      }).serialize();
      expect(buf).toEqual(Buffer.from([0x00, 0xdd]));
    }
    {
      const buf = new RunLengthChunk({
        type: PacketChunk.TypeTCCRunLengthChunk,
        packetStatus: PacketStatus.TypeTCCPacketReceivedWithoutDelta,
        runLength: 24,
      }).serialize();
      const expected = Buffer.from([0x60, 0x18]);
      expect(buf).toEqual(expected);
    }
  });

  test("StatusVectorChunk", () => {
    {
      const data = Buffer.from([0x9f, 0x1c]);
      const res = StatusVectorChunk.deSerialize(data);
      expect(res.type).toBe(PacketChunk.TypeTCCStatusVectorChunk);
      expect(res.symbolSize).toBe(0);
      expect(res.symbolList).toEqual([
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketNotReceived,
      ]);

      expect(res.serialize()).toEqual(data);
    }
    {
      const data = Buffer.from([0xcd, 0x50]);
      const res = StatusVectorChunk.deSerialize(data);
      expect(res.type).toBe(PacketChunk.TypeTCCStatusVectorChunk);
      expect(res.symbolSize).toBe(1);
      expect(res.symbolList).toEqual([
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketReceivedWithoutDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketReceivedSmallDelta,
        PacketStatus.TypeTCCPacketNotReceived,
        PacketStatus.TypeTCCPacketNotReceived,
      ]);
      expect(res.serialize()).toEqual(data);
    }
  });

  test("RecvDelta", () => {
    {
      const data = Buffer.from([0xff]);
      const res = RecvDelta.deSerialize(data);
      expect(res.type).toBe(PacketStatus.TypeTCCPacketReceivedSmallDelta);
      expect(res.delta).toBe(63750);

      expect(res.serialize()).toEqual(data);
    }
    {
      const data = Buffer.from([0x7f, 0xff]);
      const res = RecvDelta.deSerialize(data);
      expect(res.type).toBe(PacketStatus.TypeTCCPacketReceivedLargeDelta);
      expect(res.delta).toBe(8191750);

      expect(res.serialize()).toEqual(data);
    }
    {
      const data = Buffer.from([0x80, 0x00]);
      const res = RecvDelta.deSerialize(data);
      expect(res.type).toBe(PacketStatus.TypeTCCPacketReceivedLargeDelta);
      expect(res.delta).toBe(-8192000);

      expect(res.serialize()).toEqual(data);
    }
  });

  describe("TransportWideCC", () => {
    test("example1", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x5, 0xfa, 0x17, 0xfa, 0x17, 0x43, 0x3, 0x2f, 0xa0,
        0x0, 0x99, 0x0, 0x1, 0x3d, 0xe8, 0x2, 0x17, 0x20, 0x1, 0x94, 0x1,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 5,
        }),
      );
      expect(twcc.senderSsrc).toBe(4195875351);
      expect(twcc.mediaSourceSsrc).toBe(1124282272);
      expect(twcc.baseSequenceNumber).toBe(153);
      expect(twcc.packetStatusCount).toBe(1);
      expect(twcc.referenceTime).toBe(4057090);
      expect(twcc.fbPktCount).toBe(23);
      expect(twcc.packetChunks).toEqual([
        new RunLengthChunk({
          type: PacketChunk.TypeTCCRunLengthChunk,
          packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          runLength: 1,
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 37000,
        }),
      ]);

      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
    test("example2", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x6, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x1, 0x74, 0x0, 0xe, 0x45, 0xb1, 0x5a, 0x40, 0xd8, 0x0, 0xf0, 0xff,
        0xd0, 0x0, 0x0, 0x1,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 6,
        }),
      );
      expect(twcc.senderSsrc).toBe(4195875351);
      expect(twcc.mediaSourceSsrc).toBe(423483579);
      expect(twcc.baseSequenceNumber).toBe(372);
      expect(twcc.packetStatusCount).toBe(14);
      expect(twcc.referenceTime).toBe(4567386);
      expect(twcc.fbPktCount).toBe(64);
      expect(twcc.packetChunks).toEqual([
        new StatusVectorChunk({
          type: PacketChunk.TypeTCCStatusVectorChunk,
          symbolSize: 1,
          symbolList: [
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedLargeDelta,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
          ],
        }),
        new StatusVectorChunk({
          type: PacketChunk.TypeTCCStatusVectorChunk,
          symbolSize: 1,
          symbolList: [
            PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            PacketStatus.TypeTCCPacketReceivedWithoutDelta,
          ],
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 52000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
          delta: 0,
        }),
      ]);

      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
    test("example3", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x7, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x1, 0x74, 0x0, 0x6, 0x45, 0xb1, 0x5a, 0x40, 0x40, 0x2, 0x20, 0x04,
        0x1f, 0xfe, 0x1f, 0x9a, 0xd0, 0x0, 0xd0, 0x0,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 7,
        }),
      );
      expect(twcc.senderSsrc).toBe(4195875351);
      expect(twcc.mediaSourceSsrc).toBe(423483579);
      expect(twcc.baseSequenceNumber).toBe(372);
      expect(twcc.packetStatusCount).toBe(6);
      expect(twcc.referenceTime).toBe(4567386);
      expect(twcc.fbPktCount).toBe(64);
      expect(twcc.packetChunks).toEqual([
        new RunLengthChunk({
          type: PacketChunk.TypeTCCRunLengthChunk,
          packetStatus: PacketStatus.TypeTCCPacketReceivedLargeDelta,
          runLength: 2,
        }),
        new RunLengthChunk({
          type: PacketChunk.TypeTCCRunLengthChunk,
          packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          runLength: 4,
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
          delta: 2047500,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
          delta: 2022500,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 52000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 0,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 52000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 0,
        }),
      ]);
      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
    test("example4", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x7, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x0, 0x4, 0x0, 0x7, 0x10, 0x63, 0x6e, 0x1, 0x20, 0x7, 0x4c, 0x24, 0x24,
        0x10, 0xc, 0xc, 0x10, 0x0, 0x0, 0x3,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 7,
        }),
      );
      expect(twcc.senderSsrc).toBe(4195875351);
      expect(twcc.mediaSourceSsrc).toBe(423483579);
      expect(twcc.baseSequenceNumber).toBe(4);
      expect(twcc.packetStatusCount).toBe(7);
      expect(twcc.referenceTime).toBe(1074030);
      expect(twcc.fbPktCount).toBe(1);
      expect(twcc.packetChunks).toEqual([
        new RunLengthChunk({
          type: PacketChunk.TypeTCCRunLengthChunk,
          packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          runLength: 7,
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 19000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 9000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 9000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 4000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 3000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 3000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 4000,
        }),
      ]);
      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
    test("example5", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x6, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x0, 0x1, 0x0, 0xe, 0x10, 0x63, 0x6d, 0x0, 0xba, 0x0, 0x10, 0xc, 0xc,
        0x10, 0x0, 0x2,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 6,
        }),
      );
      expect(twcc.senderSsrc).toBe(4195875351);
      expect(twcc.mediaSourceSsrc).toBe(423483579);
      expect(twcc.baseSequenceNumber).toBe(1);
      expect(twcc.packetStatusCount).toBe(14);
      expect(twcc.referenceTime).toBe(1074029);
      expect(twcc.fbPktCount).toBe(0);
      expect(twcc.packetChunks).toEqual([
        new StatusVectorChunk({
          type: PacketChunk.TypeTCCStatusVectorChunk,
          symbolSize: 0,
          symbolList: [
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketNotReceived,
          ],
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 4000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 3000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 3000,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 4000,
        }),
      ]);
      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
    test("example6", () => {
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x7, 0x9b, 0x74, 0xf6, 0x1f, 0x93, 0x71, 0xdc, 0xbc,
        0x85, 0x3c, 0x0, 0x9, 0x63, 0xf9, 0x16, 0xb3, 0xd5, 0x52, 0x0, 0x30,
        0x9b, 0xaa, 0x6a, 0xaa, 0x7b, 0x1, 0x9, 0x1,
      ]);
      const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
        RtcpTransportLayerFeedback,
      ];
      const twcc = rtpfb.feedback as TransportWideCC;
      expect(twcc.header).toEqual(
        new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 7,
        }),
      );
      expect(twcc.senderSsrc).toBe(2608133663);
      expect(twcc.mediaSourceSsrc).toBe(2473712828);
      expect(twcc.baseSequenceNumber).toBe(34108);
      expect(twcc.packetStatusCount).toBe(9);
      expect(twcc.referenceTime).toBe(6551830);
      expect(twcc.fbPktCount).toBe(179);
      expect(twcc.packetChunks).toEqual([
        new StatusVectorChunk({
          type: PacketChunk.TypeTCCStatusVectorChunk,
          symbolSize: 1,
          symbolList: [
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketReceivedSmallDelta,
            PacketStatus.TypeTCCPacketNotReceived,
            PacketStatus.TypeTCCPacketReceivedLargeDelta,
          ],
        }),
        new RunLengthChunk({
          type: PacketChunk.TypeTCCRunLengthChunk,
          packetStatus: PacketStatus.TypeTCCPacketNotReceived,
          runLength: 48,
        }),
      ]);
      expect(twcc.recvDeltas).toEqual([
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 38750,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 42500,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 26500,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 42500,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
          delta: 30750,
        }),
        new RecvDelta({
          type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
          delta: 66250,
        }),
      ]);
      const buf = rtpfb.serialize();
      expect(buf).toEqual(data);
    });
  });

  describe("TransportWideCC serialize", () => {
    test("example1", () => {
      const twcc = new TransportWideCC({
        header: new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 5,
        }),
        senderSsrc: 4195875351,
        mediaSourceSsrc: 1124282272,
        baseSequenceNumber: 153,
        packetStatusCount: 1,
        referenceTime: 4057090,
        fbPktCount: 23,
        packetChunks: [
          new RunLengthChunk({
            type: PacketChunk.TypeTCCRunLengthChunk,
            packetStatus: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            runLength: 1,
          }),
        ],
        recvDeltas: [
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 37000,
          }),
        ],
      });
      const buf = twcc.serialize();
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x5, 0xfa, 0x17, 0xfa, 0x17, 0x43, 0x3, 0x2f, 0xa0,
        0x0, 0x99, 0x0, 0x1, 0x3d, 0xe8, 0x2, 0x17, 0x20, 0x1, 0x94, 0x1,
      ]);
      expect(buf).toEqual(data);
    });

    test("example2", () => {
      const twcc = new TransportWideCC({
        header: new RtcpHeader({
          padding: true,
          count: TransportWideCC.count,
          type: RtcpTransportLayerFeedback.type,
          length: 6,
        }),
        senderSsrc: 4195875351,
        mediaSourceSsrc: 423483579,
        baseSequenceNumber: 372,
        packetStatusCount: 2,
        referenceTime: 4567386,
        fbPktCount: 64,
        packetChunks: [
          new StatusVectorChunk({
            type: PacketChunk.TypeTCCStatusVectorChunk,
            symbolSize: 1,
            symbolList: [
              PacketStatus.TypeTCCPacketReceivedSmallDelta,
              PacketStatus.TypeTCCPacketReceivedLargeDelta,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketNotReceived,
            ],
          }),
          new StatusVectorChunk({
            type: PacketChunk.TypeTCCStatusVectorChunk,
            symbolSize: 1,
            symbolList: [
              PacketStatus.TypeTCCPacketReceivedWithoutDelta,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketNotReceived,
              PacketStatus.TypeTCCPacketReceivedWithoutDelta,
              PacketStatus.TypeTCCPacketReceivedWithoutDelta,
              PacketStatus.TypeTCCPacketReceivedWithoutDelta,
              PacketStatus.TypeTCCPacketReceivedWithoutDelta,
            ],
          }),
        ],
        recvDeltas: [
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedSmallDelta,
            delta: 52000,
          }),
          new RecvDelta({
            type: PacketStatus.TypeTCCPacketReceivedLargeDelta,
            delta: 0,
          }),
        ],
      });
      const buf = twcc.serialize();
      const data = Buffer.from([
        0xaf, 0xcd, 0x0, 0x6, 0xfa, 0x17, 0xfa, 0x17, 0x19, 0x3d, 0xd8, 0xbb,
        0x1, 0x74, 0x0, 0x2, 0x45, 0xb1, 0x5a, 0x40, 0xd8, 0x0, 0xf0, 0xff,
        0xd0, 0x0, 0x0, 0x1,
      ]);
      expect(buf).toEqual(data);
    });
  });
});
