import { RedEncoder, RtpHeader, RtpPacket } from "../../../src";

describe("RedEncoder", () => {
  it("normal", () => {
    const redundantPackets = [
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30420,
          timestamp: 3086388154,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([248]),
      ),
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30421,
          timestamp: 3086389114,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([248]),
      ),
    ];
    const present = new RtpPacket(
      new RtpHeader({
        version: 2,
        padding: false,
        paddingSize: 0,
        extension: false,
        marker: true,
        payloadType: 96,
        sequenceNumber: 30422,
        timestamp: 3086390074,
        ssrc: 4096661943,
        csrc: [],
        extensionProfile: 48862,
        extensions: [],
      }),
      Buffer.from([248]),
    );

    const redEncoder = new RedEncoder(3);
    redundantPackets.forEach((p) =>
      redEncoder.push({
        block: p.payload,
        timestamp: p.header.timestamp,
        blockPT: p.header.payloadType,
      }),
    );
    redEncoder.push({
      block: present.payload,
      timestamp: present.header.timestamp,
      blockPT: present.header.payloadType,
    });
    const red = redEncoder.build();
    expect(red.blocks.length).toBe(3);
  });

  it("dtx", () => {
    const redundantPackets = [
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30420,
          timestamp: 3086390074 - 16384,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([248]),
      ),
      new RtpPacket(
        new RtpHeader({
          version: 2,
          padding: false,
          paddingSize: 0,
          extension: false,
          marker: true,
          payloadType: 96,
          sequenceNumber: 30421,
          timestamp: 3086389114,
          ssrc: 4096661943,
          csrc: [],
          extensionProfile: 48862,
          extensions: [],
        }),
        Buffer.from([248]),
      ),
    ];
    const present = new RtpPacket(
      new RtpHeader({
        version: 2,
        padding: false,
        paddingSize: 0,
        extension: false,
        marker: true,
        payloadType: 96,
        sequenceNumber: 30422,
        timestamp: 3086390074,
        ssrc: 4096661943,
        csrc: [],
        extensionProfile: 48862,
        extensions: [],
      }),
      Buffer.from([248]),
    );

    const redEncoder = new RedEncoder(3);
    redundantPackets.forEach((p) =>
      redEncoder.push({
        block: p.payload,
        timestamp: p.header.timestamp,
        blockPT: p.header.payloadType,
      }),
    );
    redEncoder.push({
      block: present.payload,
      timestamp: present.header.timestamp,
      blockPT: present.header.payloadType,
    });
    const red = redEncoder.build();
    expect(red.blocks.length).toBe(2);
  });
});
