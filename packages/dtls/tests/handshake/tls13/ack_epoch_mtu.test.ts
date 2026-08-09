import { describe, expect, test } from "vitest";
import {
  ACK_ENCRYPTED_OVERHEAD,
  ACK_PLAINTEXT_OVERHEAD,
  ACK_RECORD_NUMBER_BYTES,
  MAX_ACCEPTED_HS_RECORDS,
  MAX_ACK_RECORD_NUMBERS,
} from "../../../src/engine/v1_3/types";
import {
  DtlsAck,
  remainingAfterAck,
} from "../../../src/handshake/message/tls13/ack";

describe("ACK epoch filtering (Erratum 8108)", () => {
  test("filters record_numbers with epoch > receivedEpoch", () => {
    // Arrange: 前提を準備する
    const claimed = [
      { epoch: 0, sequenceNumber: 1 },
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 3, sequenceNumber: 5 },
    ];
    const receivedEpoch = 0;
    // Act: epoch 管理を検証する
    const applicable = claimed.filter((r) => r.epoch <= receivedEpoch);
    // Assert: epoch 管理を検証する
    expect(applicable).toEqual([{ epoch: 0, sequenceNumber: 1 }]);
    const pending = [
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
    ];
    expect(remainingAfterAck(pending, applicable)).toEqual(pending);
  });

  test("encrypted ACK on epoch 2 may ACK epoch 2 records", () => {
    // Arrange: 前提を準備する
    const claimed = [
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
      { epoch: 3, sequenceNumber: 0 }, // higher than received → ignore
    ];
    const receivedEpoch = 2;
    // Act: ACK 処理を検証する
    const applicable = claimed.filter((r) => r.epoch <= receivedEpoch);
    // Assert: ACK 処理を検証する
    expect(applicable).toEqual([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 1 },
    ]);
  });
});

describe("ACK dynamic MTU sizing", () => {
  test("max records fit under encrypted overhead for small MTU", () => {
    // Arrange: 前提を準備する
    const mtu = 180;
    const n = Math.floor(
      (mtu - ACK_ENCRYPTED_OVERHEAD) / ACK_RECORD_NUMBER_BYTES,
    );
    const maxN = Math.max(1, Math.min(MAX_ACK_RECORD_NUMBERS, n));
    // Act: MTU 制約を検証する
    const numbers = Array.from({ length: maxN }, (_, i) => ({
      epoch: 2,
      sequenceNumber: i,
    }));
    const body = new DtlsAck(numbers).serialize();
    // Assert: MTU 制約を検証する
    expect(body.length + (ACK_ENCRYPTED_OVERHEAD - 2)).toBeLessThanOrEqual(mtu);
    // 2 bytes list length is inside ACK body; overhead includes list len in constant
    // Encrypted wire ≈ 5+1+body+16; body = 2+16*N
    const wireEstimate = 5 + 1 + body.length + 16;
    expect(wireEstimate).toBeLessThanOrEqual(mtu);
  });

  test("plaintext ACK overhead constant is consistent", () => {
    // Arrange: 前提を準備する
    expect(ACK_PLAINTEXT_OVERHEAD).toBe(15); // 13 hdr + 2 list len
    expect(ACK_RECORD_NUMBER_BYTES).toBe(16);
  });

  test("accepted HS record cap covers multi-fragment flight", () => {
    // Arrange: 前提を準備する
    expect(MAX_ACCEPTED_HS_RECORDS).toBeGreaterThanOrEqual(66);
  });
});
