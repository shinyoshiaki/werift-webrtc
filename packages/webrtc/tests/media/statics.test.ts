import { uint16Add } from "../../../common/src";
import { RtpHeader, RtpPacket } from "../../src";
import { StreamStatistics } from "../../src/media/statics";

describe("packages/webrtc/src/media/statics.ts", () => {
  test("no loss", () => {
    const counter = new StreamStatistics(8000);
    const packets = createRtpPackets(20, 0);
    packets.slice(0, 10).forEach((p) => counter.add(p));

    expect(counter.max_seq).toBe(9);
    expect(counter.packets_received).toBe(10);
    expect(counter.packets_lost).toBe(0);
    expect(counter.fraction_lost).toBe(0);

    packets.slice(10, 20).forEach((p) => counter.add(p));

    expect(counter.max_seq).toBe(19);
    expect(counter.packets_received).toBe(20);
    expect(counter.packets_lost).toBe(0);
    expect(counter.fraction_lost).toBe(0);
  });

  test("test_no_loss_cycle", () => {
    const counter = new StreamStatistics(8000);
    const packets = createRtpPackets(10, 65530);
    packets.forEach((p) => counter.add(p));

    expect(counter.max_seq).toBe(3);
    expect(counter.packets_received).toBe(10);
    expect(counter.packets_lost).toBe(0);
    expect(counter.fraction_lost).toBe(0);
  });

  test("test_with_loss", () => {
    const counter = new StreamStatistics(8000);
    const packets = createRtpPackets(20, 0);
    packets.splice(1, 1);

    packets.slice(0, 9).forEach((p) => counter.add(p));

    expect(counter.max_seq).toBe(9);
    expect(counter.packets_received).toBe(9);
    expect(counter.packets_lost).toBe(1);
    expect(counter.fraction_lost).toBe(25);

    packets.slice(9).forEach((p) => counter.add(p));
    expect(counter.max_seq).toBe(19);
    expect(counter.packets_received).toBe(19);
    expect(counter.packets_lost).toBe(1);
    expect(counter.fraction_lost).toBe(0);
  });

  test("test_no_jitter", () => {
    const counter = new StreamStatistics(8000);
    const packets = createRtpPackets(3, 0);

    counter.add(packets[0], 1531562330.0);
    expect(counter.jitter_q4).toBe(0);
    expect(counter.jitter).toBe(0);

    counter.add(packets[1], 1531562330.02);
    expect(counter.jitter_q4).toBe(0);
    expect(counter.jitter).toBe(0);

    counter.add(packets[2], 1531562330.04);
    expect(counter.jitter_q4).toBe(0);
    expect(counter.jitter).toBe(0);
  });

  test("test_with_jitter", () => {
    const counter = new StreamStatistics(8000);
    const packets = createRtpPackets(3, 0);

    counter.add(packets[0], 1531562330.0);
    expect(counter.jitter_q4).toBe(0);
    expect(counter.jitter).toBe(0);

    counter.add(packets[1], 1531562330.03);
    expect(counter.jitter_q4).toBe(80);
    expect(counter.jitter).toBe(5);

    counter.add(packets[2], 1531562330.05);
    expect(counter.jitter_q4).toBe(75);
    expect(counter.jitter).toBe(4);
  });
});

function createRtpPackets(count: number, seq = 0) {
  return [...Array(count)].map(
    (_, i) =>
      new RtpPacket(
        new RtpHeader({
          payloadType: 0,
          sequenceNumber: uint16Add(seq, i),
          ssrc: 1234,
          timestamp: i * 160,
        }),
        Buffer.alloc(0)
      )
  );
}
