import { describe, expect, test, vi } from "vitest";
import type { PeerConfig } from "../../src";
import {
  BurstLossClock,
  DebugPacketLoss,
  dropByPercent,
} from "../../src/transport/debugPacketLoss";
import { createDtlsTransport } from "../fixture";

describe("transport/debugPacketLoss", () => {
  test("dropByPercent は指定 % を捨てる (逆ではない)", () => {
    // Act / Assert: random が loss% 未満のときだけ捨てる
    expect(dropByPercent(10, () => 0.05)).toBe(true);
    expect(dropByPercent(10, () => 0.5)).toBe(false);
    expect(dropByPercent(0, () => 0)).toBe(false);
    expect(dropByPercent(undefined, () => 0)).toBe(false);
    expect(dropByPercent(100, () => 0.999)).toBe(true);
  });

  test("BurstLossClock は最初のパケットから周期的に durationMs だけ捨てる", () => {
    const clock = new BurstLossClock();
    const burst = { intervalMs: 1000, durationMs: 200 };

    // Act: 0ms (開始) から 2.5 秒を 100ms 刻みで判定する
    const dropped = Array.from({ length: 25 }, (_, i) =>
      clock.drop(burst, 10_000 + i * 100),
    );

    // Assert: 既定 offset (interval - duration = 800ms) から 200ms ずつ捨てる
    const droppedAt = dropped
      .map((drop, i) => (drop ? i * 100 : undefined))
      .filter((v) => v !== undefined);
    expect(droppedAt).toEqual([800, 900, 1800, 1900]);
  });

  test("BurstLossClock は offsetMs を指定できる", () => {
    const clock = new BurstLossClock();

    // Act
    const dropped = [0, 50, 100, 150].map((t) =>
      clock.drop({ intervalMs: 100, durationMs: 50, offsetMs: 0 }, t),
    );

    // Assert
    expect(dropped).toEqual([true, false, true, false]);
  });

  test("inboundRtpDrop は RTP ヘッダの seq / timestamp / ssrc で判定して捨てる", () => {
    // Arrange: seq 5 だけを捨てる
    const seen: unknown[] = [];
    const loss = new DebugPacketLoss({
      debug: {
        inboundRtpDrop: (rtp) => {
          seen.push(rtp);
          return rtp.sequenceNumber === 5;
        },
      },
    });
    const rtp = (seq: number) => {
      const data = Buffer.alloc(20);
      data.writeUInt8(0x80, 0);
      data.writeUInt16BE(seq, 2);
      data.writeUInt32BE(48000, 4);
      data.writeUInt32BE(1234, 8);
      return data;
    };

    // Act
    const dropped = [4, 5, 6].map((seq) => loss.dropInboundRtp(rtp(seq)));

    // Assert: seq 5 だけを捨て、ヘッダの値をそのまま渡している
    expect(dropped).toEqual([false, true, false]);
    expect(seen[1]).toEqual({
      sequenceNumber: 5,
      timestamp: 48000,
      ssrc: 1234,
    });
  });

  const arrangeTransport = (debug: PeerConfig["debug"]) => {
    const dtls = createDtlsTransport({ debug });
    dtls.srtp = { encrypt: () => Buffer.alloc(20) } as any;
    const send = vi
      .spyOn(dtls.iceTransport.connection, "send")
      .mockResolvedValue(undefined as never);
    return { dtls, send };
  };

  test("outboundPacketLoss=100 は全 RTP を捨て、0 は捨てない", async () => {
    const all = arrangeTransport({ outboundPacketLoss: 100 });
    const none = arrangeTransport({ outboundPacketLoss: 0 });

    // Act
    for (let i = 0; i < 20; i++) {
      await all.dtls.sendRtp(Buffer.alloc(1), {} as any);
      await none.dtls.sendRtp(Buffer.alloc(1), {} as any);
    }

    // Assert: 従来は判定が反転しており 100% 指定で全て送っていた
    expect(all.send).not.toHaveBeenCalled();
    expect(none.send).toHaveBeenCalledTimes(20);
  });
});
