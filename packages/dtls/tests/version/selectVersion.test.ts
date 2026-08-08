import { describe, expect, test } from "vitest";
import {
  DtlsVersion,
  ProtocolVersionError,
  peerVersionsFromSupportedVersionsWire,
  selectVersion,
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
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

  test("prefers first local version in peer intersection [1.2,1.3]", () => {
    // Arrange / Act
    const v = selectVersion(
      [DtlsVersion.V1_2, DtlsVersion.V1_3],
      [DtlsVersion.V1_3, DtlsVersion.V1_2],
    );
    // Assert: server/client preference order wins over peer order
    expect(v).toBe(DtlsVersion.V1_2);
  });

  test("1.3-only local with dual peer → 1.3", () => {
    expect(
      selectVersion(
        [DtlsVersion.V1_3],
        [DtlsVersion.V1_3, DtlsVersion.V1_2],
      ),
    ).toBe(DtlsVersion.V1_3);
  });

  test("1.2-only local with dual peer → 1.2", () => {
    expect(
      selectVersion(
        [DtlsVersion.V1_2],
        [DtlsVersion.V1_3, DtlsVersion.V1_2],
      ),
    ).toBe(DtlsVersion.V1_2);
  });

  test("intersection empty throws ProtocolVersionError", () => {
    // Arrange / Act / Assert
    expect(() =>
      selectVersion([DtlsVersion.V1_3], [DtlsVersion.V1_2]),
    ).toThrow(ProtocolVersionError);
    expect(() =>
      selectVersion([DtlsVersion.V1_2], [DtlsVersion.V1_3]),
    ).toThrow(ProtocolVersionError);
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
});
