import { RtcpPacketConverter } from "../../src";
import {
  RtcpSourceDescriptionPacket,
  SourceDescriptionChunk,
  SourceDescriptionItem,
} from "../../src/rtcp/sdes";

describe("rtcp/sdes", () => {
  test("two items", () => {
    const data = Buffer.from([
      // v=2, p=0, count=1, SDES, len=16
      0x81,
      0xca, 0x00, 0x03,
      // ssrc=0x10000000
      0x10,
      0x00, 0x00, 0x00,
      // CNAME, len=1, content=A
      0x01,
      0x01, 0x41,
      // PHONE, len=1, content=B
      0x04,
      0x01, 0x42,
      // END + padding
      0x00,
      0x00,
    ]);
    const [sdes] = RtcpPacketConverter.deSerialize(data) as [
      RtcpSourceDescriptionPacket,
    ];
    expect(sdes).toEqual(
      new RtcpSourceDescriptionPacket({
        chunks: [
          new SourceDescriptionChunk({
            source: 0x10000000,
            items: [
              new SourceDescriptionItem({ type: 1, text: "A" }),
              new SourceDescriptionItem({ type: 4, text: "B" }),
            ],
          }),
        ],
      }),
    );
    const d = sdes.serialize();
    expect(d).toEqual(data);
  });

  test("two chunks", () => {
    const data = Buffer.from([
      // v=2, p=0, count=2, SDES, len=24
      0x82,
      0xca, 0x00, 0x05,
      // ssrc=0x01020304
      0x01,
      0x02, 0x03, 0x04,
      // Chunk 1
      // CNAME, len=1, content=A
      0x01,
      0x01, 0x41,
      // END
      0x00,
      // Chunk 2
      // SSRC 0x05060708
      0x05,
      0x06, 0x07, 0x08,
      // CNAME, len=3, content=BCD
      0x01,
      0x03, 0x42, 0x43, 0x44,
      // END
      0x00,
      0x00, 0x00,
    ]);
    const [sdes] = RtcpPacketConverter.deSerialize(data) as [
      RtcpSourceDescriptionPacket,
    ];
    expect(sdes).toEqual(
      new RtcpSourceDescriptionPacket({
        chunks: [
          new SourceDescriptionChunk({
            source: 0x01020304,
            items: [new SourceDescriptionItem({ type: 1, text: "A" })],
          }),
          new SourceDescriptionChunk({
            source: 0x05060708,
            items: [new SourceDescriptionItem({ type: 1, text: "BCD" })],
          }),
        ],
      }),
    );
    const to = sdes.serialize();
    expect(to).toEqual(data);
  });
});
