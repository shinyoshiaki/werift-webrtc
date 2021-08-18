import { RtpHeader, RtpPacket } from "../../src";
import { JitterBuffer } from "../../src/nonstandard/jitterBuffer";

describe("packages/webrtc/tests/nonstandard/jitterBuffer.test.ts", () => {
  it("ideal conditions", () => {
    let sequenceNumber = 0;
    const jitter = new JitterBuffer();

    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: sequenceNumber++ }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(p).toEqual(res);
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: sequenceNumber++ }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(p).toEqual(res);
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: sequenceNumber++ }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(p).toEqual(res);
    }
  });

  it("give up packet lost", () => {
    const jitter = new JitterBuffer(2);
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 0 }),
        Buffer.from([])
      );
      jitter.push(p);
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 2 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 3 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 4 }),
        Buffer.from([])
      );
      const packets = jitter.push(p);
      expect(packets.length).toBe(3);
    }
  });

  it("recover packet lost", () => {
    const jitter = new JitterBuffer(2);
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 0 }),
        Buffer.from([])
      );
      jitter.push(p);
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 2 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 3 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 1 }),
        Buffer.from([])
      );
      const packets = jitter.push(p);
      expect(packets.length).toBe(3);
    }
  });

  it("disorder packets", () => {
    const jitter = new JitterBuffer();
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 0 }),
        Buffer.from([])
      );
      jitter.push(p);
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 2 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 3 }),
        Buffer.from([])
      );
      const [res] = jitter.push(p);
      expect(res).toBeUndefined();
    }
    {
      const p = new RtpPacket(
        new RtpHeader({ sequenceNumber: 1 }),
        Buffer.from([])
      );
      const packets = jitter.push(p);
      expect(packets.length).toBe(3);
    }
  });
});
