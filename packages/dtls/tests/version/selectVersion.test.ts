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
    // Arrange / Act
    const v = selectVersion(
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
    );
    // Assert
    expect(v).toBe(DtlsVersion.V1_3);
  });

  test("normalizeProtocolVersions coerces [1.2,1.3] → [1.3,1.2]", () => {
    // Arrange / Act / Assert: Epic 1 does not support 1.2-first dual
    expect(
      normalizeProtocolVersions([DtlsVersion.V1_2, DtlsVersion.V1_3]),
    ).toEqual([DtlsVersion.V1_3, DtlsVersion.V1_2]);
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
    // Arrange / Act / Assert
    expect(() => selectVersion([DtlsVersion.V1_3], [DtlsVersion.V1_2])).toThrow(
      ProtocolVersionError,
    );
    expect(() => selectVersion([DtlsVersion.V1_2], [DtlsVersion.V1_3])).toThrow(
      ProtocolVersionError,
    );
  });

  test("peerVersionsFromSupportedVersionsWire maps wire codes", () => {
    // Arrange / Act / Assert
    expect(
      peerVersionsFromSupportedVersionsWire([
        DTLS_1_3_VERSION,
        DTLS_1_2_VERSION,
      ]),
    ).toEqual([DtlsVersion.V1_3, DtlsVersion.V1_2]);
    expect(peerVersionsFromSupportedVersionsWire([])).toEqual([
      DtlsVersion.V1_2,
    ]);
    expect(peerVersionsFromSupportedVersionsWire(undefined)).toEqual([
      DtlsVersion.V1_2,
    ]);
  });

  test("hasTlsDowngradeSentinel detects DOWNGRD tails", () => {
    // Arrange
    const ok = Buffer.alloc(32, 1);
    const bad = Buffer.concat([Buffer.alloc(24, 2), DOWNGRADE_TLS12_SENTINEL]);
    // Act / Assert
    expect(hasTlsDowngradeSentinel(ok)).toBe(false);
    expect(hasTlsDowngradeSentinel(bad)).toBe(true);
  });
});
