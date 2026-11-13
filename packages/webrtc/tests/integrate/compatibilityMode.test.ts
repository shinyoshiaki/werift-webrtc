import {
  CompatibilityModes,
  DeprecatedCompatibilityValues,
  KeyFrameRequestRoutingModes,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  TransceiverPairingModes,
} from "../../src";

/**
 * The constructor-fixed compatibility options share the values
 * `"standard"` (specifications / browsers) and `"legacy"` (werift's own
 * behavior); the names up to v0.27.0 are read as the new ones.
 */
const options = [
  {
    option: "certificateScope",
    defaultValue: "legacy",
    changeable: false,
    aliases: { process: "legacy", peerConnection: "standard" },
  },
  {
    option: "mLineReuse",
    defaultValue: "standard",
    changeable: false,
    aliases: { compatible: "standard", aggressive: "legacy" },
  },
  {
    option: "transceiverPairing",
    defaultValue: "legacy",
    changeable: false,
    aliases: {},
  },
  {
    option: "keyFrameRequestRouting",
    defaultValue: "legacy",
    changeable: true,
    aliases: { compatible: "legacy", strict: "standard" },
  },
] as const;

type CompatibilityOption = (typeof options)[number]["option"];

describe("compatibility options share standard / legacy", () => {
  const pcs: RTCPeerConnection[] = [];
  const createPc = (config: RTCPeerConnectionConfig = {}) => {
    const pc = new RTCPeerConnection({ iceServers: [], ...config });
    pcs.push(pc);
    return pc;
  };
  const read = (pc: RTCPeerConnection, option: CompatibilityOption) =>
    pc.getConfiguration()[option];

  afterEach(async () => {
    await Promise.all(pcs.splice(0).map((pc) => pc.close()));
  });

  test("the exported mode lists are the shared values", () => {
    // Assert: 各モードの一覧は共通の ["standard", "legacy"]
    expect(CompatibilityModes).toEqual(["standard", "legacy"]);
    expect(TransceiverPairingModes).toEqual(CompatibilityModes);
    expect(KeyFrameRequestRoutingModes).toEqual(CompatibilityModes);
    expect(Object.keys(DeprecatedCompatibilityValues).sort()).toEqual(
      options
        .filter(({ aliases }) => Object.keys(aliases).length > 0)
        .map(({ option }) => option)
        .sort(),
    );
  });

  test.each(options)(
    "$option: default $defaultValue, both values, other values are a TypeError",
    ({ option, defaultValue }) => {
      // Act: 既定・両方の値で作成する
      const defaultPc = createPc();
      const standardPc = createPc({ [option]: "standard" });
      const legacyPc = createPc({ [option]: "legacy" });

      // Assert: 既定値と指定した値がそのまま読み返せる
      expect(read(defaultPc, option)).toBe(defaultValue);
      expect(read(standardPc, option)).toBe("standard");
      expect(read(legacyPc, option)).toBe("legacy");

      // Assert: 共通の値以外は生成時に TypeError (旧名 "jsep" や別オプションの旧名も含む)
      for (const value of ["any", "jsep", "constructor", "toString"]) {
        expect(() => createPc({ [option]: value as never })).toThrow(
          new TypeError(`${option} must be one of standard, legacy`),
        );
      }
    },
  );

  test.each(
    options.flatMap(({ option, aliases }) =>
      Object.entries(aliases).map(([alias, mode]) => ({
        option,
        alias,
        mode,
      })),
    ),
  )(
    "$option: the v0.27.0 name $alias is read as $mode",
    ({ option, alias, mode }) => {
      // Act: 旧名で作成する
      const pc = createPc({ [option]: alias as never });

      // Assert: getConfiguration() は新しい名前を返す
      expect(read(pc, option)).toBe(mode);
    },
  );

  test("a v0.27.0 name selects the same behavior as its new name", async () => {
    // Arrange: mLineReuse の旧名 "aggressive" と新名 "legacy"
    const aliasPc = createPc({ mLineReuse: "aggressive" });
    const legacyPc = createPc({ mLineReuse: "legacy" });
    aliasPc.addTransceiver("audio", { direction: "inactive" });
    legacyPc.addTransceiver("audio", { direction: "inactive" });

    // Act
    const [aliasOffer, legacyOffer] = await Promise.all([
      aliasPc.createOffer(),
      legacyPc.createOffer(),
    ]);

    // Assert: どちらも inactive m-line を port 0 で書く (legacy の挙動)
    const port = (sdp: string) => sdp.match(/^m=audio (\d+)/m)?.[1];
    expect(port(aliasOffer.sdp)).toBe("0");
    expect(port(legacyOffer.sdp)).toBe("0");
  });

  test.each(options)(
    "$option: setConfiguration() changes it only when changeable ($changeable)",
    ({ option, defaultValue, changeable, aliases }) => {
      // Arrange
      const pc = createPc();
      const other = defaultValue === "standard" ? "legacy" : "standard";
      const sameAlias = Object.entries(aliases).find(
        ([, mode]) => mode === defaultValue,
      )?.[0];

      // Act / Assert: 同じ値 (旧名を含む) の再設定は常に成功する
      expect(() =>
        pc.setConfiguration({ [option]: defaultValue }),
      ).not.toThrow();
      if (sameAlias) {
        expect(() =>
          pc.setConfiguration({ [option]: sameAlias as never }),
        ).not.toThrow();
      }
      expect(read(pc, option)).toBe(defaultValue);

      // Act / Assert: 別の値への変更は変更可能なオプションだけ成功する
      if (changeable) {
        pc.setConfiguration({ [option]: other });
        expect(read(pc, option)).toBe(other);
      } else {
        expect(() => pc.setConfiguration({ [option]: other })).toThrow(
          expect.objectContaining({
            name: "InvalidModificationError",
            message: `${option} cannot be changed`,
          }),
        );
        expect(read(pc, option)).toBe(defaultValue);
      }
    },
  );
});
