import { RtpHeader, RtpPacket } from "../../src";
import { JitterBufferBase } from "../../src/extra/processor/jitterBuffer";
import { JitterBufferTransformer } from "../../src/extra/processor/jitterBufferTransformer";

describe("test JitterBuffer", () => {
  const createRtpPacket = (sequenceNumber: number, timestamp: number) =>
    new RtpPacket(
      new RtpHeader({ sequenceNumber, timestamp }),
      Buffer.from([1, 2, 3]),
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
    //@ts-expect-error
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

  it("keeps received packets when one packet is lost and reception continues", () => {
    // Arrange: 20ms 間隔のパケット 0〜30 のうち 1 だけが欠落する。
    const jitterBuffer = new JitterBufferBase(48000, { latency: 200 });
    const received: number[] = [];
    const lost: { from: number; to: number }[] = [];

    // Act
    for (let i = 0; i <= 30; i++) {
      if (i === 1) {
        continue;
      }
      for (const out of jitterBuffer.processInput({
        rtp: createRtpPacket(i, i * 960),
      })) {
        if (out.rtp) received.push(out.rtp.header.sequenceNumber);
        if (out.isPacketLost) lost.push(out.isPacketLost);
      }
    }
    for (const out of jitterBuffer.processInput({ eol: true })) {
      if (out.rtp) received.push(out.rtp.header.sequenceNumber);
    }

    // Assert: 欠落した 1 以外の全パケットが、重複なく順序どおり出力される。
    expect(received).toEqual([
      0,
      ...Array.from({ length: 29 }, (_, i) => i + 2),
    ]);
    // Assert: 欠落通知は 1 のみを指す。
    expect(lost.length).toBeGreaterThan(0);
    expect(lost[0].from).toBe(1);
  });
});
