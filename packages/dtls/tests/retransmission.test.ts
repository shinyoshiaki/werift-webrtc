import { describe, expect, test } from "vitest";
import { DtlsRandom } from "../src/handshake/random";
import {
  DTLS_SRTP_INITIAL_RTO_MS,
  INITIAL_RTO_MS,
  MAX_RTO_MS,
  MIN_RTO_MS,
  computeDtlsRtoMs,
} from "../src/retransmission";

describe("shared DTLS 1.2 / 1.3 helpers", () => {
  test("computeDtlsRtoMs: unknown RTT uses RFC initial (SRTP vs generic)", () => {
    // Arrange / Act / Assert: RTT 未取得
    expect(
      computeDtlsRtoMs({
        rttMs: 0,
        retransmitCount: 0,
        useSrtpProfile: false,
      }),
    ).toBe(INITIAL_RTO_MS);
    expect(
      computeDtlsRtoMs({
        rttMs: 0,
        retransmitCount: 0,
        useSrtpProfile: true,
      }),
    ).toBe(DTLS_SRTP_INITIAL_RTO_MS);
  });

  test("computeDtlsRtoMs: known RTT is 1.5× with doubling and clamp", () => {
    // Arrange / Act / Assert: 外部 RTT
    expect(
      computeDtlsRtoMs({
        rttMs: 200,
        retransmitCount: 0,
        useSrtpProfile: false,
      }),
    ).toBe(300);
    expect(
      computeDtlsRtoMs({
        rttMs: 200,
        retransmitCount: 1,
        useSrtpProfile: false,
      }),
    ).toBe(600);
    expect(
      computeDtlsRtoMs({
        rttMs: 1,
        retransmitCount: 0,
        useSrtpProfile: false,
      }),
    ).toBe(MIN_RTO_MS);
    expect(
      computeDtlsRtoMs({
        rttMs: 50_000,
        retransmitCount: 0,
        useSrtpProfile: false,
      }),
    ).toBe(MAX_RTO_MS);
  });

  test("DtlsRandom.bytes32 matches toBuffer32", () => {
    // Arrange
    const r = new DtlsRandom(0x01020304, Buffer.alloc(28, 0xab));
    // Act / Assert
    expect(DtlsRandom.bytes32(r)).toEqual(r.toBuffer32());
    expect(DtlsRandom.bytes32(r).length).toBe(32);
    expect(DtlsRandom.bytes32(r).readUInt32BE(0)).toBe(0x01020304);
  });
});
