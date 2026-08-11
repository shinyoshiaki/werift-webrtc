import { describe, expect, test } from "vitest";
import {
  DOWNGRADE_TLS12_SENTINEL,
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsVersion,
  ProtocolVersionError,
  hasTlsDowngradeSentinel,
  normalizeProtocolVersions,
  peerVersionsFromSupportedVersionsWire,
  selectVersion,
} from "../../src/version";

describe("selectVersion (association layer)", () => {
  test("prefers first local version in peer intersection [1.3,1.2]", () => {
    // Arrange: 前提を準備する
    const v = selectVersion(
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
    );
    // Assert: version 交渉を検証する
    expect(v).toBe(DtlsVersion.V1_3);
  });

  test("prefers first local version in peer intersection [1.2,1.3]", () => {
    // Arrange: local は 1.2 優先
    const v = selectVersion(
      [DtlsVersion.V1_2, DtlsVersion.V1_3],
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
    );
    // Assert: 交差集合内で local 先頭を選ぶ
    expect(v).toBe(DtlsVersion.V1_2);
  });

  test("normalizeProtocolVersions: dual is [1.3,1.2] only; [1.2,1.3] normalizes", () => {
    // Arrange / Act / Assert: 唯一の dual は 1.3 優先。1.2-first は DOWNGRD 非両立のため正規化
    expect(
      normalizeProtocolVersions([DtlsVersion.V1_3, DtlsVersion.V1_2]),
    ).toEqual([DtlsVersion.V1_3, DtlsVersion.V1_2]);
    expect(
      normalizeProtocolVersions([DtlsVersion.V1_2, DtlsVersion.V1_3]),
    ).toEqual([DtlsVersion.V1_3, DtlsVersion.V1_2]);
    expect(normalizeProtocolVersions([DtlsVersion.V1_3])).toEqual([
      DtlsVersion.V1_3,
    ]);
    expect(normalizeProtocolVersions([DtlsVersion.V1_2])).toEqual([
      DtlsVersion.V1_2,
    ]);
    expect(normalizeProtocolVersions(undefined)).toEqual([DtlsVersion.V1_2]);
  });

  test("1.3-only local with dual peer → 1.3", () => {
    expect(
      selectVersion([DtlsVersion.V1_3], [DtlsVersion.V1_3, DtlsVersion.V1_2]),
    ).toBe(DtlsVersion.V1_3);
  });

  test("1.2-only local with dual peer → 1.2", () => {
    expect(
      selectVersion([DtlsVersion.V1_2], [DtlsVersion.V1_3, DtlsVersion.V1_2]),
    ).toBe(DtlsVersion.V1_2);
  });

  test("intersection empty throws ProtocolVersionError", () => {
    // Arrange: 前提を準備する
    expect(() => selectVersion([DtlsVersion.V1_3], [DtlsVersion.V1_2])).toThrow(
      ProtocolVersionError,
    );
    expect(() => selectVersion([DtlsVersion.V1_2], [DtlsVersion.V1_3])).toThrow(
      ProtocolVersionError,
    );
  });

  test("peerVersionsFromSupportedVersionsWire maps wire codes", () => {
    // Arrange: 前提を準備する
    expect(
      peerVersionsFromSupportedVersionsWire([
        DTLS_1_3_VERSION,
        DTLS_1_2_VERSION,
      ]),
    ).toEqual([DtlsVersion.V1_3, DtlsVersion.V1_2]);
    // Extension absent only → legacy 1.2
    expect(peerVersionsFromSupportedVersionsWire(undefined)).toEqual([
      DtlsVersion.V1_2,
    ]);
    // Present but empty / unknown-only → no negotiable version (not 1.2)
    expect(peerVersionsFromSupportedVersionsWire([])).toEqual([]);
    expect(peerVersionsFromSupportedVersionsWire([0x0303])).toEqual([]);
  });

  test("hasTlsDowngradeSentinel detects DOWNGRD tails", () => {
    // Arrange: 前提を準備する
    const ok = Buffer.alloc(32, 1);
    const bad = Buffer.concat([Buffer.alloc(24, 2), DOWNGRADE_TLS12_SENTINEL]);
    // Act / Assert: 期待どおりの結果を検証する
    expect(hasTlsDowngradeSentinel(ok)).toBe(false);
    expect(hasTlsDowngradeSentinel(bad)).toBe(true);
  });
});
