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

  it("期限切れで欠番を諦めても、後続の正常なパケットを欠落・重複させない", () => {
    // Arrange: 5 秒 (250 パケット) の latency、seq 2 は届かない
    const jitterBuffer = new JitterBufferBase(48000, { latency: 5000 });
    const output: number[] = [];
    const lost: { from: number; to: number }[] = [];
    const collect = (
      input: Parameters<typeof jitterBuffer.processInput>[0],
    ) => {
      for (const o of jitterBuffer.processInput(input)) {
        if (o.rtp) output.push(o.rtp.header.sequenceNumber);
        if (o.isPacketLost) lost.push(o.isPacketLost);
      }
    };

    // Act: seq 1 と 3〜255 を順に入力し、最後に終了する
    collect({ rtp: createRtpPacket(1, 1 * 960) });
    for (let seq = 3; seq <= 255; seq++) {
      collect({ rtp: createRtpPacket(seq, seq * 960) });
    }
    collect({ eol: true });

    // Assert: seq 2 以外が昇順に一度ずつ出力され、欠番が通知される
    const expected = [1, ...Array.from({ length: 253 }, (_, i) => i + 3)];
    expect(output).toEqual(expected);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost[0].from).toBe(2);
  });
});
