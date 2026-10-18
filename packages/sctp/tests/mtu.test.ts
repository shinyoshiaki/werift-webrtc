import { vi } from "vitest";

import {
  DEFAULT_SCTP_MTU,
  SCTP,
  maxPayloadSizeForMtu,
  validateSctpMtu,
} from "../src";
import { DataChunk, parsePacket, serializePacket } from "../src/chunk";
import type { Transport } from "../src/transport";

describe("SCTP outbound MTU", () => {
  test.each([
    [1191, 1160],
    [1228, 1200],
    [1052, 1024],
    [32, 4],
  ])("derives the aligned payload size for MTU %i", (mtu, expected) => {
    // Act: ヘッダーと padding を差し引いた payload 上限を計算する。
    const actual = maxPayloadSizeForMtu(mtu);

    // Assert: 期待する 4-byte 境界の payload サイズになる。
    expect(actual).toBe(expected);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid MTU %s",
    (mtu) => {
      // Act / Assert: 正の安全な整数でない値を拒否する。
      expect(() => validateSctpMtu(mtu)).toThrow(
        "SCTP MTU must be a positive integer",
      );
    },
  );

  test.each([28, 29, 31])("rejects too-small MTU %i", (mtu) => {
    // Act / Assert: DATA payload を格納できない MTU を拒否する。
    expect(() => validateSctpMtu(mtu)).toThrow(
      "SCTP MTU is too small for a DATA chunk",
    );
  });

  test("accepts the minimum usable MTU", () => {
    // Act / Assert: 4 bytes の payload を格納できる最小値を許可する。
    expect(() => validateSctpMtu(32)).not.toThrow();
  });

  test.each([1157, 1158, 1159, 1160])(
    "keeps a padded DATA packet within the default MTU for payload %i",
    (payloadSize) => {
      const chunk = new DataChunk(0x03, undefined);
      chunk.userData = Buffer.alloc(payloadSize);

      // Act: padding を含む SCTP packet を直列化する。
      const packet = serializePacket(5000, 5001, 0, chunk);

      // Assert: packet 全体が設定 MTU を超えない。
      expect(packet.length).toBeLessThanOrEqual(DEFAULT_SCTP_MTU);
      if (payloadSize === 1160) expect(packet.length).toBe(1188);
    },
  );

  test.each([
    { mtu: DEFAULT_SCTP_MTU, size: 2321, chunks: 3 },
    { mtu: 1052, size: 1025, chunks: 2 },
  ])(
    "fragments and reassembles a message for MTU $mtu",
    async ({ mtu, size, chunks }) => {
      const packets: Buffer[] = [];
      const transport: Transport = {
        send: vi.fn(async (packet) => {
          packets.push(packet);
        }),
        close: vi.fn(),
      };
      const sctp = SCTP.client(transport, 5000, { mtu });
      sctp.setRemotePort(5001);
      const message = Buffer.alloc(size, 0x5a);

      // Act: configured MTU を使って message を送信する。
      await sctp.send(1, 51, message);

      // Assert: 全 fragment が MTU 内で、結合すると元の message に一致する。
      expect(packets).toHaveLength(chunks);
      expect(packets.every((packet) => packet.length <= mtu)).toBe(true);
      const reassembled = Buffer.concat(
        packets.map(
          (packet) => (parsePacket(packet)[3][0] as DataChunk).userData,
        ),
      );
      expect(reassembled).toEqual(message);
    },
  );

  test.each([
    { name: "unordered", options: { ordered: false } },
    { name: "max retransmits", options: { ordered: true, maxRetransmits: 1 } },
    { name: "expiry", options: { ordered: true, expiry: Date.now() + 10_000 } },
  ])("applies the same MTU to $name messages", async ({ options }) => {
    const packets: Buffer[] = [];
    const transport: Transport = {
      send: vi.fn(async (packet) => {
        packets.push(packet);
      }),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport);
    sctp.setRemotePort(5001);

    // Act: ordering / reliability の異なる経路で fragmentation を行う。
    await sctp.send(1, 51, Buffer.alloc(1161), options);

    // Assert: send option にかかわらず全 packet が MTU 内に収まる。
    expect(packets).toHaveLength(2);
    expect(packets.every((packet) => packet.length <= DEFAULT_SCTP_MTU)).toBe(
      true,
    );
  });
});
