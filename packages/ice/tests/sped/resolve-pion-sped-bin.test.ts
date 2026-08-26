import { resolvePionSpedBin } from "./resolve-pion-sped-bin";

const localBin = "/repo/packages/ice/tools/pion-sped/pion-sped";

function input(
  extra: Partial<Parameters<typeof resolvePionSpedBin>[0]> = {},
): Parameters<typeof resolvePionSpedBin>[0] {
  return {
    override: undefined,
    required: false,
    autoBuild: false,
    localBin,
    exists: () => false,
    isCompatible: () => false,
    tryBuildLocal: () => false,
    ...extra,
  };
}

describe("resolvePionSpedBin", () => {
  it("REQUIRED=1 で binary 未指定なら throw し skip しない", () => {
    // Arrange: 完了判定用 script 相当。override / AUTO_BUILD なし
    // Act / Assert: describe.skip に落ちず、opt-in 未設定で失敗する
    expect(() => resolvePionSpedBin(input({ required: true }))).toThrow(
      /Pion SPED opt-in requires WERIFT_PION_SPED or WERIFT_PION_SPED_AUTO_BUILD=1/,
    );
  });

  it("既定 suite は env 未指定なら skip 用に undefined", () => {
    // Act
    const bin = resolvePionSpedBin(input());

    // Assert: default npm test は green のまま
    expect(bin).toBeUndefined();
  });

  it("REQUIRED=1 で壊れた explicit override は throw", () => {
    // Arrange: 存在するが verify / empty-ack が無い CLI
    const override = "/usr/local/bin/pion-sped";

    // Act / Assert
    expect(() =>
      resolvePionSpedBin(
        input({
          override,
          required: true,
          exists: (path) => path === override,
          isCompatible: () => false,
        }),
      ),
    ).toThrow(`WERIFT_PION_SPED is incompatible: ${override}`);
  });

  it("REQUIRED=1 で存在しない override は throw", () => {
    const override = "/broken/path";

    // Act / Assert
    expect(() =>
      resolvePionSpedBin(input({ override, required: true })),
    ).toThrow(`WERIFT_PION_SPED does not exist: ${override}`);
  });

  it("既定 suite は壊れた explicit override を skip する", () => {
    // Arrange: CI の古い /usr/local/bin/pion-sped
    const override = "/usr/local/bin/pion-sped";

    // Act
    const bin = resolvePionSpedBin(
      input({
        override,
        exists: (path) => path === override,
        isCompatible: () => false,
      }),
    );

    // Assert: default npm test は throw しない
    expect(bin).toBeUndefined();
  });

  it("REQUIRED=1 でも AUTO_BUILD なら local binary を使う", () => {
    // Act
    const bin = resolvePionSpedBin(
      input({
        required: true,
        autoBuild: true,
        isCompatible: (path) => path === localBin,
      }),
    );

    // Assert
    expect(bin).toBe(localBin);
  });
});
