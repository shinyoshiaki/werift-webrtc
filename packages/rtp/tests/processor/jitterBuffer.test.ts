import { RtpHeader, RtpPacket } from "../../src";
import { JitterBufferTransformer } from "../../src/processor/jitterBufferTransformer";

describe("test JitterBuffer", () => {
  const createRtpPacket = (sequenceNumber: number, timestamp: number) =>
    new RtpPacket(
      new RtpHeader({ sequenceNumber, timestamp }),
      Buffer.from([1, 2, 3])
    );

  it("handle continues packet", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    for (let i = 0; i < 5; i++) {
      writer.write({ rtp: createRtpPacket(i, i) });
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(i);
    }
  });

  it("handle jitter", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    writer.write({ rtp: createRtpPacket(0, 0) });
    await reader.read();

    writer.write({ rtp: createRtpPacket(2, 2) });
    writer.write({ rtp: createRtpPacket(1, 1) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(1);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(2);
    }
    writer.write({ rtp: createRtpPacket(3, 3) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(3);
    }
  });

  it("should packet loss", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    writer.write({ rtp: createRtpPacket(0, 0) });
    await reader.read();

    writer.write({ rtp: createRtpPacket(2, 2) });
    writer.write({ rtp: createRtpPacket(3, 3) });
    writer.write({ rtp: createRtpPacket(4, 4 + 90000 * 1) });
    const res = (await reader.read()).value!;
    expect(res.isPacketLost).toEqual({ from: 1, to: 3 });
    expect(jitterBuffer.presentSeqNum).toBe(4);

    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(2);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(3);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(4);
    }

    writer.write({ rtp: createRtpPacket(5, 5) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(5);
    }
  });
});
